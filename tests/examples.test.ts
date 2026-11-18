import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { httpFixture } from './helpers/fixture.ts';

test('every documented .http request runs in order with its advertised status code', async t => {
  const api = await httpFixture(t);
  const file = readFileSync(new URL('../examples/requests.http', import.meta.url), 'utf8');
  const variables = Object.fromEntries([...file.matchAll(/^@(\w+)\s*=\s*(.+)$/gm)].map(match => [match[1], match[2]]));
  const requests = file.split(/^### /m).slice(1);
  assert.ok(requests.length >= 15);
  for (const block of requests) {
    const expanded = block.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      assert.ok(key in variables, `Unknown example variable ${key}`);
      return variables[key];
    });
    const [label, ...lines] = expanded.trim().split('\n');
    const expected = /-> (\d{3})/.exec(label);
    assert.ok(expected, `Missing expected status in example: ${label}`);
    const requestIndex = lines.findIndex(line => /^(GET|POST|PATCH) /.test(line));
    assert.ok(requestIndex >= 0, label);
    const [method, address] = lines[requestIndex].split(' ');
    const url = new URL(address);
    const bodyIndex = lines.indexOf('', requestIndex + 1);
    const body = bodyIndex === -1 ? '' : lines.slice(bodyIndex + 1).join('\n').trim();
    const response = await api.raw(method, url.pathname + url.search, body);
    assert.equal(response.status, Number(expected[1]), label);
  }
  assert.deepEqual(api.errors, []);
});
