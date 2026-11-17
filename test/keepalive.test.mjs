import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { connectSandbox } from '@opencoredev/sandbox-sdk';
import { createLifecycle } from '../dist/lifecycle.js';
import { keepAliveStep } from '../dist/keepalive-worker.js';
import { keepAliveIntervalMs, keepAliveUnit, readKeepAlive, writeKeepAlive } from '../dist/keepalive.js';
import { cloudssh } from '../dist/index.js';
import { createFixtureHelper } from './fixtures/helper.mjs';
import { startSshd } from './fixtures/sshd.mjs';

async function command(args, env = process.env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: fileURLToPath(new URL('../', import.meta.url)) });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const result = Promise.withResolvers();
  child.once('error', result.reject);
  child.once('close', code => result.resolve({ code, stdout, stderr }));
  return result.promise;
}

async function setup(t, mode = 'ready') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudssh-keepalive-'));
  const server = await startSshd({ directory: path.join(root, 'sshd') });
  const options = {
    helperRoot: path.join(root, 'helper'), stateDirectory: path.join(root, 'state'),
    cloudflareEnv: path.join(root, 'fixture-cloudflare.env'), accountId: 'fixture-account',
  };
  await createFixtureHelper(options.helperRoot, { ...server, mode, scratchDirectory: path.join(root, 'scratch') });
  const lifecycle = createLifecycle(options);
  const ids = new Set();
  t.after(async () => {
    let cleaned = false;
    try {
      for (const record of await lifecycle.list()) ids.add(record.id);
      for (const id of ids) await lifecycle.destroy(id);
      cleaned = true;
    } finally {
      await server.close();
      if (cleaned) await rm(root, { recursive: true, force: true });
    }
  });
  return { root, options, lifecycle, track: value => { ids.add(value); } };
}

async function enableFixture(context, changes = {}) {
  const { lifecycle, options } = context;
  const record = await lifecycle.create({ labels: {} });
  context.track(record.id);
  const file = path.join(options.stateDirectory, record.id, 'record.json');
  await writeFile(file, JSON.stringify({ ...record, keepAlive: true, ...changes }), { mode: 0o600 });
  const session = JSON.parse(await readFile(path.join(lifecycle.sessionDirectory(record.id), 'session.json'), 'utf8'));
  const vm = session.vms[0];
  const value = { version: 1, id: record.id, unit: keepAliveUnit(options.stateDirectory, record.id), options,
    identity: { sessionId: session.id, threadId: vm.threadId, runtimeId: vm.runtimeId, hostKeySha256: createHash('sha256').update(vm.hostPublicKey.split(/\s+/).slice(0, 2).join(' ')).digest('hex') },
    enabled: true, state: 'scheduled', intervalMs: keepAliveIntervalMs, nextAt: Date.now() };
  await writeKeepAlive(value);
  return { record, value };
}

async function calls(options) {
  return (await readFile(path.join(options.helperRoot, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).action);
}

async function eventually(read, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error('Owned local service did not reach the expected state');
}

test('location default can be overridden per box without starting maintenance', async t => {
  const context = await setup(t);
  const lifecycle = createLifecycle({ ...context.options, keepAlive: true });
  const record = await lifecycle.create({ labels: { 'cloudssh.keepAlive': 'false' } });
  context.track(record.id);
  assert.equal(record.keepAlive, false);
  assert.equal((await lifecycle.keepAlive(record.id)).state, 'disabled');
  assert.deepEqual(await calls(context.options), ['up']);
  await assert.rejects(lifecycle.create({ labels: { 'cloudssh.keepAlive': 'yes' } }));
  assert.deepEqual(await calls(context.options), ['up']);
  assert.throws(() => cloudssh({ ...context.options, keepAlive: 'yes' }), { code: 'invalid_argument' });
});

test('native maintenance preserves deadlines and verifies real pinned SSH without model recovery', async t => {
  const context = await setup(t);
  const { record, value } = await enableFixture(context);
  const result = await keepAliveStep(context.lifecycle, value, new AbortController().signal);
  assert.equal(result.state, 'running');
  assert.equal(result.ssh, 'verified');
  assert.equal(result.attempt.state, 'completed');
  const saved = await context.lifecycle.get(record.id);
  assert.equal(saved.createdAt, record.createdAt);
  assert.equal(saved.timeoutMs, record.timeoutMs);
  assert.deepEqual(await calls(context.options), ['up', 'keepalive']);
});

test('an attached SSH client is not displaced and does not prevent native maintenance', async t => {
  const context = await setup(t);
  const { record, value } = await enableFixture(context);
  const release = await context.lifecycle.acquire(record.id);
  try {
    const result = await keepAliveStep(context.lifecycle, value, new AbortController().signal);
    assert.equal(result.state, 'running');
    assert.equal(result.ssh, 'busy');
    await assert.rejects(context.lifecycle.acquire(record.id), /busy|lease/);
    assert.deepEqual(await calls(context.options), ['up', 'keepalive']);
  } finally { await release(); }
});

test('denied native requests fail-stop and an issued attempt is never replayed', async t => {
  const context = await setup(t, 'keepalive-denied');
  const { value } = await enableFixture(context);
  const failed = await keepAliveStep(context.lifecycle, value, new AbortController().signal);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attempt.state, 'issued');
  assert.match(failed.lastError, /Native keepalive failed/);
  const repeated = await keepAliveStep(context.lifecycle, failed, new AbortController().signal);
  assert.equal(repeated.state, 'failed');
  assert.match(repeated.lastError, /uncertain/);
  assert.deepEqual(await calls(context.options), ['up', 'keepalive']);
});

test('a replaced runtime is refused before sending a native resume', async t => {
  const context = await setup(t);
  const { record, value } = await enableFixture(context);
  const file = path.join(context.lifecycle.sessionDirectory(record.id), 'session.json');
  const session = JSON.parse(await readFile(file, 'utf8'));
  session.vms[0].runtimeId = 'replacement-runtime';
  await writeFile(file, JSON.stringify(session), { mode: 0o600 });
  const failed = await keepAliveStep(context.lifecycle, value, new AbortController().signal);
  assert.equal(failed.state, 'failed');
  assert.match(failed.lastError, /identity|runtime|pin/);
  assert.deepEqual(await calls(context.options), ['up']);
});

test('a runtime changed by a native response stops maintenance without recovery', async t => {
  const context = await setup(t, 'keepalive-changed-runtime');
  const { value } = await enableFixture(context);
  const failed = await keepAliveStep(context.lifecycle, value, new AbortController().signal);
  assert.equal(failed.state, 'failed');
  assert.match(failed.lastError, /identity|runtime/);
  assert.deepEqual(await calls(context.options), ['up', 'keepalive']);
});

test('expired access causes no native request and cannot be renewed by keepalive', async t => {
  const context = await setup(t);
  const { record, value } = await enableFixture(context, { createdAt: Date.now() - 120_000, timeoutMs: 60_000 });
  const result = await keepAliveStep(context.lifecycle, value, new AbortController().signal);
  assert.equal(result.state, 'expired');
  assert.deepEqual(await calls(context.options), ['up']);
  await assert.rejects(context.lifecycle.maintain(record.id, value.identity), /expired/);
});

test('systemd worker survives creating CLI exit, can be disabled during attached SSH, and stops on destroy', { timeout: 30_000 }, async t => {
  const context = await setup(t);
  const options = { ...context.options, keepAlive: true };
  const creation = await command(['--input-type=module', '-e', `import { createSandbox } from '@opencoredev/sandbox-sdk';import { cloudssh } from './dist/index.js';const p=cloudssh(${JSON.stringify(options)});const b=await createSandbox(p,{labels:{'raft.location':'test'}});await b.close();console.log(b.id);`]);
  assert.equal(creation.code, 0, creation.stderr);
  const id = creation.stdout.trim();
  context.track(id);
  const running = await eventually(() => readKeepAlive(options.stateDirectory, id), value => value?.state === 'running' && value.attempt?.state === 'completed' && value.ssh !== undefined);
  assert.equal(running.enabled, true);
  assert.equal((await context.lifecycle.keepAlive(id)).managerState, 'active');
  const provider = cloudssh(options);
  const box = await connectSandbox(provider, id, { recoverSecrets: false });
  try {
    assert.equal((await box.run('printf before', { cwd: context.root })).stdout, 'before');
    assert.equal((await provider.keepAlive(id, false)).state, 'disabled');
    assert.equal((await box.run('printf after', { cwd: context.root })).stdout, 'after');
  } finally { await box.close(); }
  await provider.destroy(id);
  assert.equal((await context.lifecycle.get(id)).phase, 'deleted');
  assert.notEqual((await context.lifecycle.keepAlive(id)).managerState, 'active');
  assert.deepEqual((await calls(options)).filter(action => action === 'resume'), []);
});

test('standalone plugin management checks location ownership before changing per-box mode', async t => {
  const context = await setup(t);
  const record = await context.lifecycle.create({ labels: { 'sandbox-sdk': '1', 'raft.location': 'test' } });
  context.track(record.id);
  const file = path.join(context.root, 'options.json');
  await writeFile(file, JSON.stringify(context.options), { mode: 0o600 });
  const result = await command(['dist/raft.js', 'keepalive', `test:${record.id}`, '--options', file, '--disable']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).keepAlive.enabled, false);
  const wrong = await command(['dist/raft.js', 'keepalive', `other:${record.id}`, '--options', file, '--enable']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /another Raft location/);
  assert.deepEqual(await calls(context.options), ['up']);
});

test('the owned systemd service expires without deleting the cloud session', { timeout: 20_000 }, async t => {
  const context = await setup(t);
  const created = await context.lifecycle.create({ labels: {} });
  context.track(created.id);
  const file = path.join(context.options.stateDirectory, created.id, 'record.json');
  // An existing box can be enabled shortly before its original access deadline.
  await writeFile(file, JSON.stringify({ ...created, createdAt: Date.now() - 55_000, timeoutMs: 60_000 }), { mode: 0o600 });
  await context.lifecycle.keepAlive(created.id, true);
  const expired = await eventually(() => readKeepAlive(context.options.stateDirectory, created.id), value => value?.state === 'expired');
  assert.equal(expired.nextAt, undefined);
  assert.equal((await context.lifecycle.get(created.id)).phase, 'ready');
  const stopped = await eventually(() => context.lifecycle.keepAlive(created.id), value => value.managerState !== 'active');
  assert.equal(stopped.state, 'expired');
  assert.deepEqual(await calls(context.options), ['up', 'keepalive']);
});

test('an unavailable user manager rejects a default-enabled creation before allocation', async t => {
  const context = await setup(t);
  const options = { ...context.options, keepAlive: true };
  const result = await command(['--input-type=module', '-e', `import { cloudssh } from './dist/index.js';await cloudssh(${JSON.stringify(options)}).create({labels:{}});`],
    { ...process.env, XDG_RUNTIME_DIR: path.join(context.root, 'no-user-manager'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(context.root, 'absent-bus')}` });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /user systemd manager/);
  await assert.rejects(readFile(path.join(options.helperRoot, 'calls.jsonl')), { code: 'ENOENT' });
  await assert.rejects(readFile(options.stateDirectory), { code: 'ENOENT' });
});
