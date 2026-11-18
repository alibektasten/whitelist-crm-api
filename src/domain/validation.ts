import { invalid } from './errors.ts';

export function object(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Request body must be a JSON object.');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!allowed.includes(key)) invalid(`Unknown field: ${key}.`);
  for (const key of required) if (!(key in input)) invalid(`Missing required field: ${key}.`);
  return input;
}

export function id(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(`${field} must be a positive integer.`);
  return value;
}

export function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

export function choice<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(`${field} must be one of: ${options.join(', ')}.`);
  return value as T;
}

export function queryInteger(value: string | null, field: string, defaultValue: number, max: number): number {
  if (value === null) return defaultValue;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) invalid(`${field} must be an integer between 1 and ${max}.`);
  return Number(value);
}
