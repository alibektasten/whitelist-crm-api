import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { invalid, AppError } from './errors.ts';
import { object, text } from './validation.ts';
import { iso } from './time.ts';

export const COMPANY_STATUSES = ['new', 'no_answer', 'refused', 'meeting_set'] as const;
export type CompanyStatus = typeof COMPANY_STATUSES[number];
type CompanyRow = { id: number; name: string; bin: string; phone: string; created_at: number; status: CompanyStatus };
const selectCompanies = `SELECT companies.*,
  COALESCE((SELECT result FROM calls WHERE company_id = companies.id ORDER BY id DESC LIMIT 1), 'new') AS status
  FROM companies`;

const serialize = (row: CompanyRow) => ({
  id: row.id, name: row.name, bin: row.bin, phone: row.phone, status: row.status, createdAt: iso(row.created_at),
});

export function requireCompany(db: DatabaseSync, companyId: number): void {
  if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyId)) throw new AppError(404, 'COMPANY_NOT_FOUND', 'Company was not found.');
}

export function createCompany(db: DatabaseSync, value: unknown, now = Date.now()) {
  const body = object(value, ['name', 'bin', 'phone']);
  const name = text(body.name, 'name', 200);
  if (typeof body.bin !== 'string' || !/^\d{12}$/.test(body.bin)) invalid('bin must be a string of exactly 12 digits.');
  if (typeof body.phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(body.phone)) invalid('phone must be in E.164 format, e.g. +77010000001.');
  const result = db.prepare('INSERT INTO companies(name, bin, phone, created_at) VALUES (?, ?, ?, ?)').run(name, body.bin, body.phone, now);
  return getCompany(db, Number(result.lastInsertRowid));
}

export function getCompany(db: DatabaseSync, companyId: number) {
  const row = db.prepare(`${selectCompanies} WHERE companies.id = ?`).get(companyId) as CompanyRow | undefined;
  if (!row) throw new AppError(404, 'COMPANY_NOT_FOUND', 'Company was not found.');
  return serialize(row);
}

export function listCompanies(db: DatabaseSync, page: number, pageSize: number, status?: CompanyStatus) {
  return transaction(db, () => {
    const where = status ? ' WHERE status = ?' : '';
    const params = status ? [status] : [];
    const base = `WITH company_list AS (${selectCompanies})`;
    const { total } = db.prepare(`${base} SELECT COUNT(*) AS total FROM company_list${where}`).get(...params) as { total: number };
    const rows = db.prepare(`${base} SELECT * FROM company_list${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as CompanyRow[];
    return { data: rows.map(serialize), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }, 'DEFERRED');
}
