import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, company, slot } from './helpers/fixture.ts';

test('HTTP end-to-end: create company, book, log call, filter, move, inspect history, cancel', async t => {
  const api = await httpFixture(t);
  const c = await api.request('POST', '/companies', { name: 'ТОО Көкжиек', bin: '000000000001', phone: '+77010000001' });
  assert.equal(c.status, 201);
  assert.equal(c.headers.get('location'), `/companies/${c.body.id}`);
  assert.equal(c.body.status, 'new');
  const m = await api.request('POST', '/meetings', slot(c.body.id));
  assert.equal(m.status, 201);
  assert.equal(m.body.endsAt, '2026-11-23T06:00:00.000Z');
  assert.equal((await api.request('POST', '/calls', { companyId: c.body.id, result: 'meeting_set', meetingId: m.body.id })).status, 201);
  const filtered = await api.request('GET', '/companies?status=meeting_set&page=1&pageSize=1');
  assert.equal(filtered.body.pagination.total, 1);
  assert.equal(filtered.body.data[0].id, c.body.id);
  assert.equal((await api.request('PATCH', `/meetings/${m.body.id}`, { startsAt: '2026-11-24T05:00:00Z' })).status, 200);
  const details = await api.request('GET', `/meetings/${m.body.id}`);
  assert.equal(details.body.history.length, 2);
  assert.equal(details.body.originalStartsAt, m.body.startsAt);
  assert.equal((await api.request('GET', '/managers/1/schedule?date=2026-11-24')).body.meetings.length, 1);
  assert.equal((await api.request('PATCH', `/meetings/${m.body.id}`, { status: 'cancelled' })).body.status, 'cancelled');
  assert.equal((await api.request('GET', '/managers/1/schedule?date=2026-11-24')).body.meetings.length, 0);
  assert.equal((await api.request('GET', '/companies/1')).body.status, 'meeting_set'); // latest call remains historical
  assert.deepEqual(api.errors, []);
});

test('HTTP conflicts use 409 and readable machine codes, never generic 500', async t => {
  const api = await httpFixture(t);
  const first = company(api.db, 1);
  const second = company(api.db, 2);
  await api.request('POST', '/meetings', slot(first.id));
  const overlap = await api.request('POST', '/meetings', slot(second.id));
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error.code, 'MANAGER_OVERLAP');
  assert.equal(typeof overlap.body.error.message, 'string');
  assert.equal(overlap.headers.get('x-request-id'), overlap.body.error.requestId);
  const duplicate = await api.request('POST', '/companies', { name: 'Duplicate', bin: first.bin, phone: first.phone });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'DUPLICATE_BIN');
  assert.deepEqual(api.errors, []);
});

test('HTTP workday boundary and missing meeting_set linkage return 422', async t => {
  const api = await httpFixture(t);
  const c = company(api.db);
  const bad = await api.request('POST', '/meetings', slot(c.id, '2026-11-23T12:30:00Z'));
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message, /Asia\/Almaty/);
  const call = await api.request('POST', '/calls', { companyId: c.id, result: 'meeting_set' });
  assert.equal(call.status, 422);
  assert.equal(call.body.error.code, 'MEETING_REQUIRED');
});

test('HTTP pagination is stable; company status follows the latest recorded call', async t => {
  const api = await httpFixture(t);
  const a = company(api.db, 1);
  const b = company(api.db, 2);
  company(api.db, 3);
  await api.request('POST', '/calls', { companyId: a.id, result: 'refused' });
  await api.request('POST', '/calls', { companyId: a.id, result: 'no_answer' });
  const page = await api.request('GET', '/companies?page=2&pageSize=1');
  assert.equal(page.body.data[0].id, b.id);
  assert.deepEqual(page.body.pagination, { page: 2, pageSize: 1, total: 3, totalPages: 3 });
  assert.equal((await api.request('GET', '/companies?status=refused')).body.pagination.total, 0);
  assert.equal((await api.request('GET', '/companies?status=no_answer')).body.data[0].id, a.id);
  const empty = await api.request('GET', '/companies?page=99');
  assert.deepEqual(empty.body.data, []);
  assert.equal(empty.body.pagination.total, 3);
});

test('HTTP rejects missing/wrong fields, unknown fields, bad BIN/phone and coercion', async t => {
  const api = await httpFixture(t);
  const valid = { name: 'Company', bin: '000000000001', phone: '+77010000001' };
  for (const body of [{}, [], null, { ...valid, name: '  ' }, { ...valid, bin: 123456789012 }, { ...valid, bin: '123' }, { ...valid, phone: '87010000001' }, { ...valid, unexpected: true }]) {
    assert.equal((await api.request('POST', '/companies', body)).status, 422, JSON.stringify(body));
  }
  const c = company(api.db);
  for (const body of [{ ...slot(c.id), companyId: String(c.id) }, { ...slot(c.id), managerId: 1.5 }, { ...slot(c.id), endsAt: '2026-11-23T06:00:00Z' }]) {
    assert.equal((await api.request('POST', '/meetings', body)).status, 422);
  }
  for (const body of [{ companyId: c.id, result: 'unknown' }, { companyId: c.id, result: 'no_answer', meetingId: 1 }, { companyId: c.id, result: 'refused', notes: 'x'.repeat(2001) }]) {
    assert.equal((await api.request('POST', '/calls', body)).status, 422);
  }
});

test('HTTP query validation rejects invalid ranges, duplicates and unknown keys', async t => {
  const api = await httpFixture(t);
  for (const query of ['page=0', 'page=1.5', 'page=1e2', 'pageSize=101', 'status=unknown', 'status=', 'page=1&page=2', 'typo=1']) {
    assert.equal((await api.request('GET', `/companies?${query}`)).status, 422, query);
  }
  for (const path of ['/managers/1/schedule', '/managers/1/schedule?date=2026-02-30', '/meetings/not-an-id']) {
    assert.equal((await api.request('GET', path)).status, 422);
  }
});

test('HTTP malformed JSON, wrong media type and oversized body have distinct codes', async t => {
  const api = await httpFixture(t);
  const malformed = await api.raw('POST', '/companies', '{bad');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_JSON');
  const media = await api.raw('POST', '/companies', '{}', 'text/plain');
  assert.equal(media.status, 415);
  const huge = await api.request('POST', '/companies', { name: 'x'.repeat(17_000) });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('HTTP not-found and method errors; health and manager seed discovery', async t => {
  const api = await httpFixture(t);
  assert.equal((await api.request('GET', '/health')).body.status, 'ok');
  assert.equal((await api.request('GET', '/managers')).body.data.length, 2);
  for (const path of ['/missing', '/meetings/99', '/companies/99', '/managers/99/schedule?date=2026-11-23']) {
    assert.equal((await api.request('GET', path)).status, 404);
  }
  const wrongMethod = await api.request('DELETE', '/companies');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
});
