import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createLifecycle } from '../dist/lifecycle.js';
import { createFixtureHelper } from './fixtures/helper.mjs';

async function setup(t, mode = 'ready') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudssh-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { helperRoot: path.join(root, 'helper'), stateDirectory: path.join(root, 'state') };
  await createFixtureHelper(options.helperRoot, { mode });
  return { root, options, lifecycle: createLifecycle(options) };
}

test('a new process can reconnect by key, but cannot steal a lease or destroy its active session', async (t) => {
  const { options, lifecycle } = await setup(t);
  const created = await lifecycle.create({ key: 'compiler-check', labels: { task: 'fixture' }, env: { PRIVATE_VALUE: 'local-test-data' } });
  const other = createLifecycle(options);
  assert.equal((await other.find('compiler-check')).id, created.id);
  const file = path.join(options.stateDirectory, created.id, 'record.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(options.stateDirectory)).mode & 0o777, 0o700);
  const release = await lifecycle.acquire(created.id);
  await assert.rejects(other.acquire(created.id), /busy|lease/);
  await assert.rejects(other.destroy(created.id), /busy|lease/);
  assert.equal((await other.get(created.id)).phase, 'ready');
  await release();
  await other.destroy(created.id);
  await other.destroy(created.id);
  const deleted = await lifecycle.get(created.id);
  assert.equal(deleted.phase, 'deleted');
  assert.deepEqual(deleted.env, {});
  assert.deepEqual(await lifecycle.list(), []);
});

test('lookup on an empty registry, unsupported options and pre-abort do not allocate state', async (t) => {
  const { options, lifecycle } = await setup(t);
  assert.deepEqual(await lifecycle.list(), []);
  assert.equal(await lifecycle.find('first-key'), undefined);
  for (const unsupported of [{ ports: [] }, { network: 'none' }, { size: 'small' }, { from: 'snapshot' }, { idleTimeoutMs: 1000 }]) {
    await assert.rejects(lifecycle.create({ labels: {}, ...unsupported }), { code: 'unsupported' });
  }
  await assert.rejects(lifecycle.create({ labels: {}, signal: AbortSignal.abort() }), { code: 'aborted' });
  await assert.rejects(access(options.stateDirectory), { code: 'ENOENT' });
});

test('failed readiness retains an inspectable ID and blocks an uncertain key from allocating again', async (t) => {
  const { lifecycle } = await setup(t, 'bad');
  let id;
  await assert.rejects(lifecycle.create({ labels: {}, key: 'uncertain' }), (cause) => {
    id = cause.sandboxId;
    return cause.code === 'outcome_unknown' && /^[a-f0-9]{32}$/.test(id);
  });
  assert.equal((await lifecycle.get(id)).phase, 'failed');
  await assert.rejects(lifecycle.find('uncertain'), { code: 'outcome_unknown' });
  assert.deepEqual((await lifecycle.list()).map((record) => record.id), [id]);
  await lifecycle.destroy(id);
  assert.deepEqual(await lifecycle.list(), []);
});

test('aborted helper creation retains its journal and cleanup clears only its recorded dead lock', async (t) => {
  const { lifecycle, options } = await setup(t, 'wait');
  const controller = new AbortController();
  const creation = lifecycle.create({ labels: {}, key: 'interrupted', signal: controller.signal });
  let id;
  const rejected = assert.rejects(creation, (cause) => { id = cause.sandboxId; return cause.code === 'outcome_unknown'; });
  const started = path.join(options.helperRoot, 'started');
  const deadline = Date.now() + 5000;
  while (true) {
    try { await access(started); break; }
    catch (cause) { if (cause.code !== 'ENOENT' || Date.now() >= deadline) throw cause; }
    await delay(20);
  }
  controller.abort();
  await rejected;
  const lock = path.join(lifecycle.sessionDirectory(id), '.lock');
  await access(lock);
  await lifecycle.destroy(id);
  await assert.rejects(access(lock), { code: 'ENOENT' });
  assert.equal((await lifecycle.get(id)).phase, 'deleted');
});

test('unconfirmed teardown retains credentials and does not mark the session deleted', async (t) => {
  const { lifecycle } = await setup(t, 'unconfirmed');
  const created = await lifecycle.create({ labels: {}, env: { PRIVATE_VALUE: 'fixture' } });
  await assert.rejects(lifecycle.destroy(created.id), { code: 'outcome_unknown' });
  const record = await lifecycle.get(created.id);
  assert.equal(record.phase, 'deleting');
  assert.equal(record.env.PRIVATE_VALUE, 'fixture');
  await access(path.join(lifecycle.sessionDirectory(created.id), 'client_key'));
});

test('exposed journals are rejected rather than trusting their ownership metadata', async (t) => {
  const { options, lifecycle } = await setup(t);
  const created = await lifecycle.create({ labels: {} });
  const file = path.join(options.stateDirectory, created.id, 'record.json');
  await chmod(file, 0o644);
  await assert.rejects(lifecycle.get(created.id), /private regular file/);
  await chmod(file, 0o600);
  await lifecycle.destroy(created.id);
});

test('explicit resume refuses a replacement runtime and retains the prior access window', async (t) => {
  const { options, lifecycle } = await setup(t, 'resume-changed-runtime');
  const created = await lifecycle.create({ labels: { owner: 'isolated-resume' }, timeoutMs: 28_800_000 });
  const sessionFile = path.join(lifecycle.sessionDirectory(created.id), 'session.json');
  const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
  saved.vms[0].agentDeadline = '2000-01-01T00:00:00Z';
  await writeFile(sessionFile, JSON.stringify(saved));
  await assert.rejects(lifecycle.resume(created.id, { timeoutMs: 60_000 }), { code: 'outcome_unknown' });
  const retained = await lifecycle.get(created.id);
  assert.equal(retained.timeoutMs, created.timeoutMs);
  assert.equal(retained.createdAt, created.createdAt);
  assert.deepEqual(retained.labels, created.labels);
  await assert.rejects(access(path.join(options.stateDirectory, created.id, '.ssh-lease')), { code: 'ENOENT' });
  await lifecycle.destroy(created.id);
});

test('busy sessions and rejected recovery cannot change the access deadline', async (t) => {
  const { lifecycle } = await setup(t, 'resume-denied');
  const created = await lifecycle.create({ labels: {} });
  const release = await lifecycle.acquire(created.id);
  await assert.rejects(lifecycle.resume(created.id, { timeoutMs: 60_000 }), /busy|lease/);
  await release();
  await assert.rejects(lifecycle.resume(created.id, { timeoutMs: 60_000 }), /approval denied/);
  assert.equal((await lifecycle.get(created.id)).timeoutMs, created.timeoutMs);
  await lifecycle.destroy(created.id);
});
