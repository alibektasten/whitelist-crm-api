import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, company, slot } from './helpers/fixture.ts';
import { createMeeting, updateMeeting, getMeeting, getSchedule } from '../src/domain/meetings.ts';
import { createCall } from '../src/domain/calls.ts';
import { AppError, toAppError } from '../src/domain/errors.ts';

test('same manager: exact, left and right overlap rejected; adjacent meetings allowed', t => {
  const db = fixture(t);
  createMeeting(db, slot(company(db, 1).id));
  const other = company(db, 2);
  for (const startsAt of ['2026-11-23T05:00:00Z', '2026-11-23T04:30:00Z', '2026-11-23T05:30:00Z']) {
    assert.throws(() => createMeeting(db, slot(other.id, startsAt)), { status: 409, code: 'MANAGER_OVERLAP' });
  }
  assert.doesNotThrow(() => createMeeting(db, slot(other.id, '2026-11-23T06:00:00Z')));
  assert.doesNotThrow(() => createMeeting(db, slot(company(db, 3).id, '2026-11-23T04:00:00Z')));
});

test('different managers can share a slot for different companies', t => {
  const db = fixture(t);
  createMeeting(db, slot(company(db, 1).id));
  assert.doesNotThrow(() => createMeeting(db, slot(company(db, 2).id, '2026-11-23T05:00:00Z', 2)));
});

test('company cannot have a second active meeting, even on a different day and manager', t => {
  const db = fixture(t);
  const c = company(db);
  createMeeting(db, slot(c.id));
  assert.throws(() => createMeeting(db, slot(c.id, '2026-11-24T06:00:00Z', 2)), { status: 409, code: 'COMPANY_ACTIVE_MEETING' });
});

test('rescheduling preserves original appointment, creation time and every change', t => {
  const db = fixture(t);
  const created = createMeeting(db, slot(company(db).id), 1_000);
  updateMeeting(db, created.id, { startsAt: '2026-11-23T06:00:00Z' }, 2_000);
  const moved = updateMeeting(db, created.id, { startsAt: '2026-11-24T07:00:00Z' }, 3_000);
  assert.equal(moved.originalStartsAt, created.startsAt);
  assert.equal(moved.createdAt, created.createdAt);
  assert.equal(moved.updatedAt, '1970-01-01T00:00:03.000Z');
  assert.deepEqual(moved.history.map(h => h.action), ['created', 'rescheduled', 'rescheduled']);
  assert.equal(moved.history[2].previousStartsAt, '2026-11-23T06:00:00.000Z');
  assert.equal(moved.history[2].nextStartsAt, moved.startsAt);
  assert.deepEqual(getMeeting(db, created.id), moved);
});

test('failed reschedule rolls back time and history and leaves the old slot occupied', t => {
  const db = fixture(t);
  const original = createMeeting(db, slot(company(db, 1).id));
  createMeeting(db, slot(company(db, 2).id, '2026-11-23T06:00:00Z'));
  assert.throws(() => updateMeeting(db, original.id, { startsAt: '2026-11-23T06:30:00Z' }), { status: 409 });
  assert.deepEqual(getMeeting(db, original.id), original);
  assert.throws(() => createMeeting(db, slot(company(db, 3).id)), { status: 409 });
});

test('cancel releases manager and company; repeating cancellation adds no history', t => {
  const db = fixture(t);
  const c = company(db);
  const created = createMeeting(db, slot(c.id));
  const cancelled = updateMeeting(db, created.id, { status: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.history.at(-1)?.nextStartsAt, null);
  assert.deepEqual(updateMeeting(db, created.id, { status: 'cancelled' }), cancelled);
  assert.equal(getSchedule(db, 1, '2026-11-23').meetings.length, 0);
  assert.throws(() => updateMeeting(db, created.id, { startsAt: '2026-11-24T05:00:00Z' }), { status: 409, code: 'MEETING_CANCELLED' });
  assert.doesNotThrow(() => createMeeting(db, slot(c.id)));
});

test('rescheduling to the same instant is a no-op; moving frees the previous slot', t => {
  const db = fixture(t);
  const original = createMeeting(db, slot(company(db).id));
  assert.deepEqual(updateMeeting(db, original.id, { startsAt: original.startsAt }), original);
  updateMeeting(db, original.id, { startsAt: '2026-11-23T06:00:00Z' });
  assert.doesNotThrow(() => createMeeting(db, slot(company(db, 2).id)));
});

test('schedule filters by manager, local date and status, and sorts by time', t => {
  const db = fixture(t);
  createMeeting(db, slot(company(db, 1).id, '2026-11-23T07:00:00Z'));
  createMeeting(db, slot(company(db, 2).id, '2026-11-23T04:00:00Z'));
  createMeeting(db, slot(company(db, 3).id, '2026-11-24T05:00:00Z'));
  createMeeting(db, slot(company(db, 4).id, '2026-11-23T05:00:00Z', 2));
  const cancelled = createMeeting(db, slot(company(db, 5).id, '2026-11-23T10:00:00Z'));
  updateMeeting(db, cancelled.id, { status: 'cancelled' });
  const schedule = getSchedule(db, 1, '2026-11-23');
  assert.equal(schedule.timeZone, 'Asia/Almaty');
  assert.deepEqual(schedule.meetings.map(m => m.startsAt), ['2026-11-23T04:00:00.000Z', '2026-11-23T07:00:00.000Z']);
  assert.deepEqual(getSchedule(db, 1, '2026-11-22').meetings, []);
});

test('unknown references return 404; invalid PATCH forms return 422', t => {
  const db = fixture(t);
  const c = company(db);
  assert.throws(() => createMeeting(db, slot(999)), { status: 404, code: 'COMPANY_NOT_FOUND' });
  assert.throws(() => createMeeting(db, slot(c.id, '2026-11-23T05:00:00Z', 999)), { status: 404, code: 'MANAGER_NOT_FOUND' });
  assert.throws(() => getMeeting(db, 999), { status: 404 });
  assert.throws(() => getSchedule(db, 999, '2026-11-23'), { status: 404 });
  const m = createMeeting(db, slot(c.id));
  for (const body of [{}, { status: 'scheduled' }, { duration: 30 }, { startsAt: '2026-11-23T05:00:00Z', status: 'cancelled' }]) {
    assert.throws(() => updateMeeting(db, m.id, body), { status: 422 });
  }
});

test('meeting_set requires an existing active meeting belonging to the caller company', t => {
  const db = fixture(t);
  const first = company(db, 1);
  const other = company(db, 2);
  for (const meetingId of [undefined, 999]) {
    assert.throws(() => createCall(db, { companyId: first.id, result: 'meeting_set', ...(meetingId === undefined ? {} : { meetingId }) }), { status: 422, code: 'MEETING_REQUIRED' });
  }
  const m = createMeeting(db, slot(first.id));
  assert.throws(() => createCall(db, { companyId: other.id, result: 'meeting_set', meetingId: m.id }), { status: 422 });
  assert.equal(createCall(db, { companyId: first.id, result: 'meeting_set', meetingId: m.id }).meetingId, m.id);
  updateMeeting(db, m.id, { status: 'cancelled' });
  assert.throws(() => createCall(db, { companyId: first.id, result: 'meeting_set', meetingId: m.id }), { status: 422 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calls').get()?.count, 1);
});

test('SQLite enforces overlap on insert and update, duration, company uniqueness and valid call linkage', t => {
  const db = fixture(t);
  const first = company(db, 1);
  const second = company(db, 2);
  const m = createMeeting(db, slot(first.id));
  const insert = db.prepare('INSERT INTO meetings(company_id, manager_id, starts_at, ends_at, original_starts_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)');
  const start = Date.parse(m.startsAt);
  assert.throws(() => insert.run(second.id, 1, start, start + 3_600_000, start), error => toAppError(error).code === 'MANAGER_OVERLAP');
  assert.throws(() => insert.run(first.id, 2, start, start + 3_600_000, start), error => toAppError(error).code === 'COMPANY_ACTIVE_MEETING');
  assert.throws(() => insert.run(second.id, 2, start, start + 1, start), /CHECK/);
  const later = createMeeting(db, slot(second.id, '2026-11-23T07:00:00Z'));
  assert.throws(() => db.prepare('UPDATE meetings SET starts_at = ?, ends_at = ? WHERE id = ?').run(start, start + 3_600_000, later.id), /manager_overlap/);
  assert.throws(() => db.prepare('UPDATE meetings SET original_starts_at = 0 WHERE id = ?').run(m.id), /immutable_meeting_identity/);
  assert.throws(() => db.prepare("INSERT INTO calls(company_id, result, meeting_id, created_at) VALUES (?, 'meeting_set', ?, 0)").run(second.id, m.id), /meeting_required/);
  assert.equal(getMeeting(db, later.id).history.length, 1);
});
