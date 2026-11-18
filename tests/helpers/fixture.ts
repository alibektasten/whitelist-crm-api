import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Duplex } from 'node:stream';
import { openDatabase } from '../../src/db/database.ts';
import { createCompany } from '../../src/domain/companies.ts';
import { createApp } from '../../src/http/app.ts';

export function fixture(t: TestContext): DatabaseSync {
  const db = openDatabase();
  t.after(() => db.close());
  return db;
}

export function company(db: DatabaseSync, number = 1) {
  return createCompany(db, { name: `Company ${number}`, bin: String(number).padStart(12, '0'), phone: '+77010000001' });
}

export const slot = (companyId: number, startsAt = '2026-11-23T05:00:00Z', managerId = 1) => ({ companyId, managerId, startsAt });

export async function httpFixture(t: TestContext, options: { databasePath?: string } = {}) {
  const db = openDatabase(options.databasePath);
  const errors: unknown[] = [];
  const server = createApp(db, { logError: error => errors.push(error) });
  t.after(() => {
    server.close();
    db.close();
  });

  // Exercise Node's real HTTP parser and response writer without binding a port.
  // This is not a router mock: raw HTTP bytes go through the production server.
  async function raw(method: string, path: string, body = '', contentType = 'application/json') {
    const wire = Buffer.from(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const chunks: Buffer[] = [];
    const socket = Object.assign(new Duplex({
      read() {},
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    }), { setTimeout() { return this; }, setNoDelay() { return this; }, setKeepAlive() { return this; } });
    const finished = new Promise<void>((resolve, reject) => {
      socket.once('finish', resolve);
      socket.once('error', reject);
    });
    server.emit('connection', socket);
    socket.push(wire);
    await finished;
    socket.destroy();
    const response = Buffer.concat(chunks).toString('utf8');
    const [head, ...parts] = response.split('\r\n\r\n');
    const [statusLine, ...headerLines] = head.split('\r\n');
    const headers = new Headers(headerLines.map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }));
    return { status: Number(statusLine.split(' ')[1]), headers, body: JSON.parse(parts.join('\r\n\r\n')) };
  }

  return {
    db, errors, raw,
    async request(method: string, path: string, body?: unknown) {
      return raw(method, path, body === undefined ? '' : JSON.stringify(body));
    },
  };
}
