import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real CLI startup, TCP requests, persistence and graceful SIGTERM', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'whitelist-server-'));
  const port = 19_000 + Math.floor(Math.random() * 10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => rm(directory, { recursive: true, force: true }));

  async function start() {
    const process = spawn(globalThis.process.execPath, ['src/server.ts'], {
      cwd: new URL('../', import.meta.url),
      env: { ...globalThis.process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: join(directory, 'crm.sqlite') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (process.exitCode === null) process.kill('SIGKILL'); });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      process.stdout.on('data', data => { output += data; if (output.includes('CRM API is listening')) resolve(); });
      process.once('error', reject);
      process.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
    });
    return process;
  }
  async function stop(process: ReturnType<typeof spawn>) {
    const exit = new Promise<number | null>(resolve => process.once('exit', resolve));
    process.kill('SIGTERM');
    assert.equal(await exit, 0);
  }

  const first = await start();
  assert.equal((await fetch(baseUrl + '/health')).status, 200);
  const created = await fetch(baseUrl + '/companies', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Persistent company', bin: '000000000001', phone: '+77010000001' }),
  });
  assert.equal(created.status, 201);
  await created.arrayBuffer();
  await stop(first);
  const second = await start();
  const companies = await (await fetch(baseUrl + '/companies')).json();
  assert.equal(companies.pagination.total, 1);
  await stop(second);
});
