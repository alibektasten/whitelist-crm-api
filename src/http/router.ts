import type { DatabaseSync } from 'node:sqlite';
import { createCompany, getCompany, listCompanies, COMPANY_STATUSES } from '../domain/companies.ts';
import { createCall } from '../domain/calls.ts';
import { createMeeting, getMeeting, getSchedule, updateMeeting } from '../domain/meetings.ts';
import { AppError, invalid } from '../domain/errors.ts';
import { choice, queryInteger } from '../domain/validation.ts';

export type ApiResponse = { status: number; body: unknown; headers?: Record<string, string> };
export type ApiRequest = { method: string; url: string; body?: unknown };
export type Clock = () => number;

function query(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) invalid(`Unknown query parameter: ${key}.`);
    if (url.searchParams.getAll(key).length !== 1) invalid(`Query parameter ${key} must appear only once.`);
  }
}

function pathId(value: string, field: string): number {
  return queryInteger(value, field, 0, Number.MAX_SAFE_INTEGER);
}

function methods(method: string, allowed: string[]): void {
  if (!allowed.includes(method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', `Allowed methods: ${allowed.join(', ')}.`);
}

export function route(db: DatabaseSync, request: ApiRequest, clock: Clock = Date.now): ApiResponse {
  const { method, body } = request;
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/health') {
    methods(method, ['GET']);
    query(url, []);
    db.prepare('SELECT 1').get();
    return { status: 200, body: { status: 'ok' } };
  }
  if (path === '/companies') {
    methods(method, ['GET', 'POST']);
    if (method === 'POST') {
      query(url, []);
      const company = createCompany(db, body, clock());
      return { status: 201, headers: { location: `/companies/${company.id}` }, body: company };
    }
    query(url, ['status', 'page', 'pageSize']);
    const status = url.searchParams.has('status') ? choice(url.searchParams.get('status'), 'status', COMPANY_STATUSES) : undefined;
    const page = queryInteger(url.searchParams.get('page'), 'page', 1, 1_000_000);
    const pageSize = queryInteger(url.searchParams.get('pageSize'), 'pageSize', 20, 100);
    return { status: 200, body: listCompanies(db, page, pageSize, status) };
  }
  const companyMatch = /^\/companies\/([^/]+)$/.exec(path);
  if (companyMatch) {
    methods(method, ['GET']);
    query(url, []);
    return { status: 200, body: getCompany(db, pathId(companyMatch[1], 'companyId')) };
  }
  if (path === '/calls') {
    methods(method, ['POST']);
    query(url, []);
    return { status: 201, body: createCall(db, body, clock()) };
  }
  if (path === '/meetings') {
    methods(method, ['POST']);
    query(url, []);
    const meeting = createMeeting(db, body, clock());
    return { status: 201, headers: { location: `/meetings/${meeting.id}` }, body: meeting };
  }
  const meetingMatch = /^\/meetings\/([^/]+)$/.exec(path);
  if (meetingMatch) {
    methods(method, ['GET', 'PATCH']);
    query(url, []);
    const meetingId = pathId(meetingMatch[1], 'meetingId');
    return { status: 200, body: method === 'GET' ? getMeeting(db, meetingId) : updateMeeting(db, meetingId, body, clock()) };
  }
  if (path === '/managers') {
    methods(method, ['GET']);
    query(url, []);
    return { status: 200, body: { data: db.prepare('SELECT id, name FROM managers ORDER BY id').all() } };
  }
  const scheduleMatch = /^\/managers\/([^/]+)\/schedule$/.exec(path);
  if (scheduleMatch) {
    methods(method, ['GET']);
    query(url, ['date']);
    return { status: 200, body: getSchedule(db, pathId(scheduleMatch[1], 'managerId'), url.searchParams.get('date')) };
  }
  throw new AppError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
}
