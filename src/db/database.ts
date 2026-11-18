import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Synchronous callback only: never hold a SQLite transaction across an await. */
export function transaction<T>(db: DatabaseSync, work: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(path = ':memory:'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    transaction(db, () => {
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY) STRICT;');
      const directory = new URL('./migrations/', import.meta.url);
      for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
        if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) continue;
        db.exec(readFileSync(new URL(name, directory), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
