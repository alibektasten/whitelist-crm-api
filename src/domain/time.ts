import { invalid } from './errors.ts';

export const TIME_ZONE = 'Asia/Almaty';
export const MEETING_DURATION_MS = 60 * 60 * 1000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function localParts(timestamp: number): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
}

export function localDate(timestamp: number): string {
  const parts = localParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function parseUtc(value: unknown, field = 'startsAt'): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|\+00:00)$/.test(value)) {
    invalid(`${field} must be an ISO 8601 UTC timestamp, e.g. 2026-11-23T05:00:00Z.`);
  }
  const normalized = value.replace(/\+00:00$/, 'Z');
  const date = new Date(normalized);
  // Reject Date's silent normalization of impossible dates such as February 30.
  const expected = normalized.includes('.')
    ? normalized.replace(/\.(\d{1,3})Z$/, (_, digits: string) => `.${digits.padEnd(3, '0')}Z`)
    : normalized.replace('Z', '.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== expected) invalid(`${field} is not a valid calendar timestamp.`);
  return date.getTime();
}

export function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('date must use YYYY-MM-DD.');
  parseUtc(`${value}T00:00:00Z`, 'date');
  return value;
}

export function meetingWindow(value: unknown): { startsAt: number; endsAt: number } {
  const startsAt = parseUtc(value);
  const endsAt = startsAt + MEETING_DURATION_MS;
  const start = localParts(startsAt);
  const end = localParts(endsAt);
  const millisecondsOfDay = (parts: Record<string, string>, timestamp: number) =>
    ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000
      + ((timestamp % 1000) + 1000) % 1000;

  if (['Sat', 'Sun'].includes(start.weekday)
      || localDate(startsAt) !== localDate(endsAt)
      || millisecondsOfDay(start, startsAt) < 9 * MEETING_DURATION_MS
      || millisecondsOfDay(end, endsAt) > 18 * MEETING_DURATION_MS) {
    invalid('A 60-minute meeting must fit within Monday–Friday, 09:00–18:00 Asia/Almaty (latest start 17:00).');
  }
  return { startsAt, endsAt };
}

export const iso = (timestamp: number): string => new Date(timestamp).toISOString();
