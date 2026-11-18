export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function invalid(message: string): never {
  throw new AppError(422, 'VALIDATION_ERROR', message);
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // Only translate known SQLite conditions. Unexpected failures remain real 500s.
  if (error && typeof error === 'object' && 'errcode' in error) {
    const sqlite = error as { errcode: number; message: string };
    if ((sqlite.errcode & 255) === 5 || (sqlite.errcode & 255) === 6) {
      return new AppError(503, 'DATABASE_BUSY', 'Database is busy. Retry the request shortly.');
    }
    if ((sqlite.errcode & 255) === 19) {
      if (sqlite.message.includes('manager_overlap')) return new AppError(409, 'MANAGER_OVERLAP', 'Manager already has a meeting during this time.');
      if (sqlite.message.includes('meetings.company_id')) return new AppError(409, 'COMPANY_ACTIVE_MEETING', 'Company already has an active meeting.');
      if (sqlite.message.includes('companies.bin')) return new AppError(409, 'DUPLICATE_BIN', 'A company with this BIN already exists.');
      if (sqlite.message.includes('meeting_required')) return new AppError(422, 'MEETING_REQUIRED', 'meeting_set requires an active meeting belonging to the same company.');
    }
  }
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
}
