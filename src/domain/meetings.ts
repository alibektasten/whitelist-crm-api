import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { requireCompany } from './companies.ts';
import { AppError, invalid } from './errors.ts';
import { id, object } from './validation.ts';
import { iso, localDate, meetingWindow, parseDate, TIME_ZONE } from './time.ts';

type MeetingRow = {
  id: number; company_id: number; manager_id: number; starts_at: number; ends_at: number;
  original_starts_at: number; status: 'scheduled' | 'cancelled'; created_at: number; updated_at: number;
};
type HistoryRow = { id: number; action: string; previous_starts_at: number | null; next_starts_at: number | null; changed_at: number };
const serialize = (row: MeetingRow) => ({
  id: row.id, companyId: row.company_id, managerId: row.manager_id,
  startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), originalStartsAt: iso(row.original_starts_at),
  status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

export function requireManager(db: DatabaseSync, managerId: number): void {
  if (!db.prepare('SELECT 1 FROM managers WHERE id = ?').get(managerId)) throw new AppError(404, 'MANAGER_NOT_FOUND', 'Manager was not found.');
}

export function getMeetingRow(db: DatabaseSync, meetingId: number): MeetingRow {
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) as MeetingRow | undefined;
  if (!row) throw new AppError(404, 'MEETING_NOT_FOUND', 'Meeting was not found.');
  return row;
}

function meetingWithHistory(db: DatabaseSync, meetingId: number) {
  const row = getMeetingRow(db, meetingId);
  const history = db.prepare('SELECT * FROM meeting_history WHERE meeting_id = ? ORDER BY id').all(meetingId) as HistoryRow[];
  return { ...serialize(row), history: history.map(event => ({
    id: event.id, action: event.action,
    previousStartsAt: event.previous_starts_at === null ? null : iso(event.previous_starts_at),
    nextStartsAt: event.next_starts_at === null ? null : iso(event.next_starts_at), changedAt: iso(event.changed_at),
  })) };
}

export function getMeeting(db: DatabaseSync, meetingId: number) {
  return transaction(db, () => meetingWithHistory(db, meetingId), 'DEFERRED');
}

function checkAvailability(db: DatabaseSync, companyId: number, managerId: number, startsAt: number, endsAt: number, excludeId = 0) {
  if (db.prepare("SELECT 1 FROM meetings WHERE company_id = ? AND status = 'scheduled' AND id != ?").get(companyId, excludeId)) {
    throw new AppError(409, 'COMPANY_ACTIVE_MEETING', 'Company already has an active meeting. Cancel it or reschedule the existing meeting.');
  }
  if (db.prepare("SELECT 1 FROM meetings WHERE manager_id = ? AND status = 'scheduled' AND id != ? AND starts_at < ? AND ends_at > ?")
    .get(managerId, excludeId, endsAt, startsAt)) {
    throw new AppError(409, 'MANAGER_OVERLAP', 'Manager already has a meeting during this time.');
  }
}

export function createMeeting(db: DatabaseSync, value: unknown, now = Date.now()) {
  const body = object(value, ['companyId', 'managerId', 'startsAt']);
  const companyId = id(body.companyId, 'companyId');
  const managerId = id(body.managerId, 'managerId');
  const { startsAt, endsAt } = meetingWindow(body.startsAt);
  return transaction(db, () => {
    requireCompany(db, companyId);
    requireManager(db, managerId);
    checkAvailability(db, companyId, managerId, startsAt, endsAt);
    const result = db.prepare(`INSERT INTO meetings
      (company_id, manager_id, starts_at, ends_at, original_starts_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(companyId, managerId, startsAt, endsAt, startsAt, now, now);
    return meetingWithHistory(db, Number(result.lastInsertRowid));
  });
}

export function updateMeeting(db: DatabaseSync, meetingId: number, value: unknown, now = Date.now()) {
  const body = object(value, ['startsAt', 'status'], []);
  if (Object.keys(body).length !== 1) invalid('Provide exactly one of startsAt (reschedule) or status: cancelled.');
  if ('status' in body && body.status !== 'cancelled') invalid('status can only be changed to cancelled.');
  const window = 'startsAt' in body ? meetingWindow(body.startsAt) : undefined;
  return transaction(db, () => {
    const row = getMeetingRow(db, meetingId);
    if (window) {
      if (row.status === 'cancelled') throw new AppError(409, 'MEETING_CANCELLED', 'A cancelled meeting cannot be rescheduled. Create a new meeting.');
      checkAvailability(db, row.company_id, row.manager_id, window.startsAt, window.endsAt, meetingId);
      if (window.startsAt !== row.starts_at) db.prepare('UPDATE meetings SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?')
        .run(window.startsAt, window.endsAt, now, meetingId);
    } else if (row.status !== 'cancelled') {
      db.prepare("UPDATE meetings SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, meetingId);
    }
    return meetingWithHistory(db, meetingId);
  });
}

export function getSchedule(db: DatabaseSync, managerId: number, value: unknown) {
  const date = parseDate(value);
  requireManager(db, managerId);
  // A bounded UTC window uses the index; Intl then selects the exact Almaty date.
  // No fixed +05 offset: historical Almaty dates also work with ICU's zone data.
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  const day = 24 * 60 * 60 * 1000;
  const rows = db.prepare(`SELECT * FROM meetings WHERE manager_id = ? AND status = 'scheduled'
    AND starts_at >= ? AND starts_at < ? ORDER BY starts_at, id`).all(managerId, midnightUtc - day, midnightUtc + 2 * day) as MeetingRow[];
  return { managerId, date, timeZone: TIME_ZONE, meetings: rows.filter(row => localDate(row.starts_at) === date).map(serialize) };
}
