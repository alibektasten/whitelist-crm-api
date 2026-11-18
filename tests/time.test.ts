import test from 'node:test';
import assert from 'node:assert/strict';
import { meetingWindow, parseUtc, parseDate, localDate } from '../src/domain/time.ts';
import { AppError } from '../src/domain/errors.ts';

test('working-day edges: 09:00 and 17:00 Almaty accepted; 08:59 and 17:30 rejected', () => {
  for (const time of ['04:00:00', '12:00:00']) assert.equal(meetingWindow(`2026-11-23T${time}Z`).endsAt - parseUtc(`2026-11-23T${time}Z`), 3_600_000);
  for (const time of ['03:59:59', '12:00:00.001', '12:30:00', '13:00:00', '23:00:00']) {
    assert.throws(() => meetingWindow(`2026-11-23T${time}Z`), { status: 422 });
  }
});

test('Saturday and Sunday rejected; Friday accepted', () => {
  for (const date of ['2026-11-21', '2026-11-22']) assert.throws(() => meetingWindow(`${date}T05:00:00Z`), AppError);
  assert.doesNotThrow(() => meetingWindow('2026-11-20T05:00:00Z'));
});

test('IANA zone data handles historical UTC+06 and modern UTC+05', () => {
  assert.doesNotThrow(() => meetingWindow('2024-01-15T03:00:00Z')); // 09:00 before the change
  assert.throws(() => meetingWindow('2026-11-23T03:00:00Z'), AppError); // 08:00 today
  assert.equal(localDate(parseUtc('2026-11-22T20:00:00Z')), '2026-11-23');
});

test('UTC parser validates real dates, UTC-only offsets and millisecond precision', () => {
  assert.equal(parseUtc('2026-11-23T05:00:00+00:00'), parseUtc('2026-11-23T05:00:00Z'));
  assert.equal(parseUtc('2026-11-23T05:00:00.1Z'), parseUtc('2026-11-23T05:00:00.100Z'));
  for (const value of ['2026-02-30T05:00:00Z', '2026-11-23T24:00:00Z', '2026-11-23T05:00:00+05:00', '2026-11-23T05:00:00', '2026-11-23', '2026-11-23T05:00:00.0001Z', null, 123]) {
    assert.throws(() => parseUtc(value), AppError);
  }
});

test('calendar dates reject nonexistent days, missing zero-padding and missing date', () => {
  assert.equal(parseDate('2024-02-29'), '2024-02-29');
  for (const value of ['2026-02-29', '2026-11-31', '2026-1-01', '', null]) assert.throws(() => parseDate(value), AppError);
});
