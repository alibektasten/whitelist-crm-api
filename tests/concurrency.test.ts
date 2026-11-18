import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database.ts';
import { createMeeting } from '../src/domain/meetings.ts';
import { company, slot } from './helpers/fixture.ts';
import { toAppError } from '../src/domain/errors.ts';

function fileDatabase(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'whitelist-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'crm.sqlite');
}

type Outcome = { status: number; code?: string };
async function compete(t: TestContext, path: string, operations: object[]): Promise<Outcome[]> {
  const contestants = operations.map(operation => {
    const worker = new Worker(new URL('./helpers/booking-worker.ts', import.meta.url), { workerData: { path, ...operation } });
    t.after(async () => { await worker.terminate(); });
    let readyResolve: () => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise<Outcome>((resolve, reject) => {
      worker.on('message', message => message === 'ready' ? readyResolve() : resolve(message));
      worker.on('error', error => { readyReject(error); reject(error); });
      worker.on('exit', code => {
        if (code !== 0) { const error = new Error(`Worker exited with ${code}`); readyReject(error); reject(error); }
      });
    });
    const exited = new Promise<void>((resolve, reject) => worker.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Worker exited with ${code}`));
    }));
    return { worker, ready, result, exited };
  });
  // Both connections complete migrations before the barrier is released.
  const start = async () => {
    await Promise.all(contestants.map(contestant => contestant.ready));
    for (const contestant of contestants) contestant.worker.postMessage('go');
  };
  const [, results] = await Promise.all([
    start(),
    Promise.all(contestants.map(contestant => contestant.result)),
    Promise.all(contestants.map(contestant => contestant.exited)),
  ]);
  return results;
}

test('concurrent connections competing for one manager slot produce one success and one conflict', { timeout: 20_000 }, async t => {
  const path = fileDatabase(t);
  const seed = openDatabase(path);
  company(seed, 1); company(seed, 2); seed.close();
  const result = await compete(t, path, [{ body: slot(1) }, { body: slot(2) }]);
  assert.deepEqual(result.map(r => r.status).sort(), [201, 409]);
  assert.equal(result.find(r => r.status === 409)?.code, 'MANAGER_OVERLAP');
  const db = openDatabase(path);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meetings').get()?.count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meeting_history').get()?.count, 1);
  } finally { db.close(); }
});

test('concurrent connections cannot book the same company with different managers', { timeout: 20_000 }, async t => {
  const path = fileDatabase(t);
  const seed = openDatabase(path); company(seed); seed.close();
  const result = await compete(t, path, [{ body: slot(1) }, { body: slot(1, '2026-11-24T05:00:00Z', 2) }]);
  assert.deepEqual(result.map(r => r.status).sort(), [201, 409]);
  assert.equal(result.find(r => r.status === 409)?.code, 'COMPANY_ACTIVE_MEETING');
});

test('concurrent reschedules to one slot are serialized and the losing history is unchanged', { timeout: 20_000 }, async t => {
  const path = fileDatabase(t);
  const seed = openDatabase(path);
  const first = createMeeting(seed, slot(company(seed, 1).id));
  const second = createMeeting(seed, slot(company(seed, 2).id, '2026-11-23T07:00:00Z'));
  seed.close();
  const operations = [first, second].map(m => ({ operation: 'reschedule', meetingId: m.id, body: { startsAt: '2026-11-24T05:00:00Z' } }));
  const result = await compete(t, path, operations);
  assert.deepEqual(result.map(r => r.status).sort(), [200, 409]);
  const db = openDatabase(path);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meeting_history').get()?.count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meetings WHERE starts_at = ?').get(Date.parse('2026-11-24T05:00:00Z'))?.count, 1);
  } finally { db.close(); }
});

test('lock exhaustion maps to 503; retry after releasing the lock succeeds', t => {
  const path = fileDatabase(t);
  const holder = openDatabase(path);
  const contender = openDatabase(path);
  try {
    company(holder);
    contender.exec('PRAGMA busy_timeout = 20');
    holder.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => createMeeting(contender, slot(1)), error => {
        assert.equal(toAppError(error).status, 503);
        assert.equal(toAppError(error).code, 'DATABASE_BUSY');
        return true;
      });
    } finally { holder.exec('ROLLBACK'); }
    assert.doesNotThrow(() => createMeeting(contender, slot(1)));
  } finally { holder.close(); contender.close(); }
});

test('file persistence and idempotent migrations preserve records and seed managers', t => {
  const path = fileDatabase(t);
  const first = openDatabase(path);
  company(first);
  createMeeting(first, slot(1));
  first.close();
  const second = openDatabase(path);
  try {
    assert.equal(second.prepare('SELECT COUNT(*) AS count FROM companies').get()?.count, 1);
    assert.equal(second.prepare('SELECT COUNT(*) AS count FROM meetings').get()?.count, 1);
    assert.equal(second.prepare('SELECT COUNT(*) AS count FROM managers').get()?.count, 2);
    assert.equal(second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count, 1);
    assert.equal(second.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  } finally { second.close(); }
});

test('eight simultaneous writers reserve a manager slot exactly once', { timeout: 20_000 }, async t => {
  const path = fileDatabase(t);
  const seed = openDatabase(path);
  for (let i = 1; i <= 8; i++) company(seed, i);
  seed.close();
  const result = await compete(t, path, Array.from({ length: 8 }, (_, i) => ({ body: slot(i + 1) })));
  assert.equal(result.filter(outcome => outcome.status === 201).length, 1);
  assert.equal(result.filter(outcome => outcome.status === 409 && outcome.code === 'MANAGER_OVERLAP').length, 7);
});

test('a meeting_set call racing cancellation is either recorded before it or rejected after it', { timeout: 20_000 }, async t => {
  const path = fileDatabase(t);
  const seed = openDatabase(path);
  const meeting = createMeeting(seed, slot(company(seed).id));
  seed.close();
  const results = await compete(t, path, [
    { operation: 'cancel', meetingId: meeting.id, body: { status: 'cancelled' } },
    { operation: 'call', body: { companyId: 1, result: 'meeting_set', meetingId: meeting.id } },
  ]);
  assert.equal(results[0].status, 200);
  assert.ok([201, 422].includes(results[1].status));
  const db = openDatabase(path);
  try {
    assert.equal(db.prepare('SELECT status FROM meetings WHERE id = ?').get(meeting.id)?.status, 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calls').get()?.count, results[1].status === 201 ? 1 : 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meeting_history').get()?.count, 2);
  } finally { db.close(); }
});
