import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real CLI startup, TCP requests, persistence and graceful SIGTERM', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'whitelist-server-'));
  const children = new Set<ChildProcess>();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function start() {
    const process = spawn(globalThis.process.execPath, ['src/server.ts'], {
      cwd: new URL('../', import.meta.url),
      env: { ...globalThis.process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: join(directory, 'crm.sqlite') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(process);
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      let stderr = '';
      process.stderr.on('data', data => { stderr += data; });
      process.stdout.on('data', data => {
        output += data;
        const match = /CRM API is listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]);
      });
      process.once('error', reject);
      process.once('exit', code => reject(new Error(`Server exited before startup: ${code}\n${stderr}`)));
    });
    return { process, baseUrl };
  }
  async function stop(process: ReturnType<typeof spawn>) {
    const exit = new Promise<number | null>(resolve => process.once('exit', resolve));
    process.kill('SIGTERM');
    assert.equal(await exit, 0);
  }

  const first = await start();
  const baseUrl = first.baseUrl;
  assert.equal((await fetch(baseUrl + '/health')).status, 200);
  const created = await fetch(baseUrl + '/companies', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Persistent company', bin: '000000000001', phone: '+77010000001' }),
  });
  assert.equal(created.status, 201);
  await created.arrayBuffer();
  await stop(first.process);
  const second = await start();
  const companies = await (await fetch(second.baseUrl + '/companies')).json();
  assert.equal(companies.pagination.total, 1);
  await stop(second.process);
});
