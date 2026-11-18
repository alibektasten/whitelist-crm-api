import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { requireCompany } from './companies.ts';
import { AppError, invalid } from './errors.ts';
import { choice, id, object, text } from './validation.ts';
import { iso } from './time.ts';

export const CALL_RESULTS = ['no_answer', 'refused', 'meeting_set'] as const;

export function createCall(db: DatabaseSync, value: unknown, now = Date.now()) {
  const body = object(value, ['companyId', 'result', 'meetingId', 'notes'], ['companyId', 'result']);
  const companyId = id(body.companyId, 'companyId');
  const result = choice(body.result, 'result', CALL_RESULTS);
  const notes = body.notes === undefined ? null : text(body.notes, 'notes', 2000);
  let meetingId: number | null = null;
  if (result === 'meeting_set') {
    if (body.meetingId === undefined) throw new AppError(422, 'MEETING_REQUIRED', 'meeting_set requires meetingId referencing an existing active meeting.');
    meetingId = id(body.meetingId, 'meetingId');
  } else if (body.meetingId !== undefined) invalid('meetingId is only allowed for result meeting_set.');

  return transaction(db, () => {
    requireCompany(db, companyId);
    if (meetingId !== null && !db.prepare("SELECT 1 FROM meetings WHERE id = ? AND company_id = ? AND status = 'scheduled'").get(meetingId, companyId)) {
      throw new AppError(422, 'MEETING_REQUIRED', 'meetingId must reference an active meeting belonging to the same company.');
    }
    const inserted = db.prepare('INSERT INTO calls(company_id, result, meeting_id, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(companyId, result, meetingId, notes, now);
    return { id: Number(inserted.lastInsertRowid), companyId, result, meetingId, notes, createdAt: iso(now) };
  });
}
