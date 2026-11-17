import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/raft.js', import.meta.url));

function invoke(action, request, home) {
  return spawnSync(process.execPath, [entry, action], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, RAFT_PLUGIN_REQUEST: JSON.stringify(request) },
    timeout: 10_000,
    input: '',
  });
}

test('protocol handshake works without credentials or configured helper and makes no state', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-protocol-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke('describe', { protocol: 1, location: 'work', options: {}, args: {} }, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).protocol, 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('unsupported actions and unsafe creation flags fail before touching provider state', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-refusal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateDirectory = path.join(home, 'provider-state');
  const options = { helperRoot: path.join(home, 'not-installed'), stateDirectory };
  const rows = [
    ['stop', { box: `work:${'a'.repeat(32)}` }],
    ['run', { command: ['true'] }],
    ['new', { ttl: 600, disposable: false }],
    ['new', { ttl: 600, disposable: true, cpu: 4 }],
    ['new', { ttl: 600, disposable: true, memory: '16GiB' }],
    ['new', { ttl: 600, disposable: true, disk: 'shared' }],
  ];
  for (const [action, args] of rows) {
    const result = invoke(action, { protocol: 1, location: 'work', options, args: { action, location: 'work', ...args } }, home);
    assert.equal(result.status, 1, `${action}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(stateDirectory), false);
  }
});

test('wrong protocol versions and action/location mismatches cannot execute', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-invalid-protocol-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rows = [
    { protocol: 2, location: 'work', options: {}, args: {} },
    { protocol: 1, location: 'work', options: {}, args: { action: 'destroy', location: 'different' } },
  ];
  for (const request of rows) {
    const result = invoke('destroy', request, home);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(fs.readdirSync(home), []);
  }
});

test('capacity distinguishes absent local limits from unknown provider availability without allocating', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-capacity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateDirectory = path.join(home, 'state');
  const result = invoke('capacity', { protocol: 1, location: 'openai', options: { helperRoot: path.join(home, 'missing-helper'), stateDirectory }, args: { action: 'capacity', location: 'openai', json: true } }, home);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.localLimit, null);
  assert.equal(report.providerLimit, null);
  assert.equal(report.available, null);
  assert.equal(report.host, null);
  assert.equal(report.boxes, 0);
  assert.equal(fs.existsSync(stateDirectory), false);
});
