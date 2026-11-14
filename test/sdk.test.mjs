import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSandbox, connectSandbox, listSandboxes } from '@opencoredev/sandbox-sdk';
import { workssh } from '../dist/index.js';
import { startSshd } from './fixtures/sshd.mjs';
import { createFixtureHelper } from './fixtures/helper.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workssh-sdk-'));
  const server = await startSshd({ directory: join(directory, 'sshd') });
  const options = { helperRoot: join(directory, 'helper'), stateDirectory: join(directory, 'state') };
  await createFixtureHelper(options.helperRoot, { ...server, scratchDirectory: join(directory, 'remote-scratch') });
  const provider = workssh(options);
  let id;
  t.after(async () => {
    try { if (id) await provider.destroy(id); }
    finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
  return { directory, options, provider, created: (value) => { id = value; } };
}

async function childScript(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text) => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
  const completed = Promise.withResolvers();
  child.once('error', completed.reject);
  child.once('close', (code) => code === 0 ? completed.resolve() : completed.reject(new Error(stderr)));
  child.stdin.end(source);
  await completed.promise;
  return stdout;
}

test('published SDK preserves files, environment, labels, guest exit status and reconnect across processes', { timeout: 20_000 }, async (t) => {
  const { directory, options, provider, created } = await setup(t);
  const box = await createSandbox(provider, { key: 'consumer-build', labels: { project: 'sdk-test' }, env: { BASE_ENV: 'persisted fixture value' } });
  created(box.id);
  const file = join(directory, 'consumer.bin');
  const bytes = new Uint8Array([0, 255, 128, 10, 65]);
  await box.files.write(file, bytes, { mode: 0o600 });
  assert.deepEqual(Buffer.from(await box.files.read(file, { as: 'bytes' })), Buffer.from(bytes));
  const result = await box.run(`printf '%s' "$BASE_ENV"; printf 'diagnostic' >&2; exit 7`, { cwd: directory });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'persisted fixture value');
  assert.equal(result.stderr, 'diagnostic');
  assert.equal((await listSandboxes(provider, { labels: { project: 'sdk-test' } }))[0].id, box.id);
  assert.deepEqual(await listSandboxes(provider, { labels: { project: 'other' } }), []);
  const same = await createSandbox(provider, { key: 'consumer-build' });
  assert.equal(same.id, box.id);
  assert.equal(same.created, false);
  await same.close();
  await box.close();
  const output = await childScript(`
import { connectSandbox } from '@opencoredev/sandbox-sdk';
import { workssh } from './dist/index.js';
const provider=workssh(${JSON.stringify(options)});
const box=await connectSandbox(provider,${JSON.stringify(box.id)},{recoverSecrets:false});
try{const result=await box.run('printf "%s" "$BASE_ENV"',{cwd:${JSON.stringify(directory)}});console.log(JSON.stringify({pid:process.pid,exit:result.exitCode,text:result.stdout}));}finally{await box.close();}
`);
  const reconnected = JSON.parse(output);
  assert.notEqual(reconnected.pid, process.pid);
  assert.equal(reconnected.exit, 0);
  assert.equal(reconnected.text, 'persisted fixture value');
});

test('SDK cancellation is a result and SDK secrets remain redacted from real guest output', { timeout: 15_000 }, async (t) => {
  const { directory, provider, created } = await setup(t);
  const original = await createSandbox(provider, { labels: {} });
  created(original.id);
  await original.close();
  const secret = 'private-consumer-value';
  const box = await connectSandbox(provider, original.id, { recoverSecrets: false, secrets: { TEST_SECRET: secret } });
  try {
    const visible = await box.run(`printf 'visible:%s' "$TEST_SECRET"; python3 -c 'import hashlib,os; print(hashlib.sha256(os.environ["TEST_SECRET"].encode()).hexdigest())' >&2`, { cwd: directory });
    assert.equal(visible.stdout.startsWith('visible:'), true);
    assert.equal(visible.stdout.includes(secret), false);
    assert.equal(visible.stderr.trim(), createHash('sha256').update(secret).digest('hex'));
    const timed = await box.run('sleep 30', { cwd: directory, timeoutMs: 200 });
    assert.equal(timed.exitCode, null);
    assert.equal(timed.timedOut, true);
    const cancelled = await box.run('sleep 30', { cwd: directory, signal: AbortSignal.abort() });
    assert.equal(cancelled.exitCode, null);
    assert.equal(cancelled.ok, false);
  } finally { await box.close(); }
});

test('unsupported capabilities are refused before allocation', async (t) => {
  const { provider, options } = await setup(t);
  await assert.rejects(createSandbox(provider, { size: 'small' }), { code: 'unsupported' });
  await assert.rejects(createSandbox(provider, { network: 'none' }), { code: 'unsupported' });
  await assert.rejects(readFile(options.stateDirectory), { code: 'ENOENT' });
});
