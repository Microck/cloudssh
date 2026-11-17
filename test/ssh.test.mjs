import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createTransport } from '../dist/ssh.js';
import { startSshd } from './fixtures/sshd.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudssh-test-'));
  const server = await startSshd({ directory: join(directory, 'sshd') });
  const access = {
    id: 'fixture',
    proxyCommand: [process.execPath, new URL('./fixtures/proxy.mjs', import.meta.url).pathname, String(server.port)],
    privateKey: server.privateKey, hostPublicKey: server.hostPublicKey,
    scratchDirectory: join(directory, 'remote-scratch'),
  };
  const transport = createTransport(access);
  t.after(async () => {
    try { await transport.close(); }
    finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
  return { transport, directory, server, access };
}

async function run(transport, directory, command) {
  let stdout = '';
  const result = await transport.exec({ command, cwd: directory, env: {}, timeoutMs: 10_000, onChunk(chunk) { if (chunk.stream === 'stdout') stdout += chunk.text; } });
  assert.equal(result.exitCode, 0);
  return stdout;
}


test('runs an interactive command through an authenticated PTY and preserves its exit code', async (t) => {
  const { transport } = await setup(t);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.columns = 97;
  stdout.rows = 31;
  let output = '';
  stdout.on('data', (chunk) => { output += chunk.toString(); });
  const shell = transport.shell({ stdin, stdout, stderr, term: 'xterm-test' });
  stdin.end("printf 'CLOUDSSH_PTY_READY:%s:%s\\n' \"$TERM\" \"$(stty size)\"; exit 7\n");
  assert.equal(await shell, 7);
  assert.match(output, /CLOUDSSH_PTY_READY:xterm-test:31 97/);
});
test('binary replacement is atomic, honors mode and removes symlinks without following their targets', async (t) => {
  const { transport, directory } = await setup(t);
  const remote = join(directory, 'files');
  await transport.files.mkdir(remote);
  await transport.files.mkdir(remote);
  const file = join(remote, 'binary.dat');
  const link = join(remote, 'link');
  const bytes = Buffer.from([0, 255, 1, 128, 10]);
  await transport.files.write(file, bytes, { mode: 0o640 });
  assert.deepEqual(Buffer.from(await transport.files.read(file)), bytes);
  assert.equal(await run(transport, directory, `stat -c %a ${quote(file)}`), '640\n');
  await run(transport, directory, `ln -s ${quote(file)} ${quote(link)}`);
  assert.equal((await transport.files.stat(link)).type, 'symlink');
  await transport.files.remove(link, { recursive: true });
  assert.deepEqual(Buffer.from(await transport.files.read(file)), bytes);
  await assert.rejects(transport.files.write(file, Buffer.from('replacement'), { mode: -1 }), { code: 'invalid_argument' });
  assert.deepEqual(Buffer.from(await transport.files.read(file)), bytes);
});

test('streams more than the SDK subscription queue without dropping stdout or stderr', async (t) => {
  const { transport, directory } = await setup(t);
  const output = { stdout: '', stderr: '' };
  const result = await transport.exec({
    command: `python3 -c 'import os; os.write(1, b"a"*3000000); os.write(2, b"b"*2000000); raise SystemExit(7)'`,
    cwd: directory, env: {}, timeoutMs: 10_000, streaming: true,
    onChunk(chunk) { output[chunk.stream] += chunk.text; },
  });
  assert.deepEqual(result, { exitCode: 7, timedOut: false });
  assert.equal(output.stdout, 'a'.repeat(3_000_000));
  assert.equal(output.stderr, 'b'.repeat(2_000_000));
});

test('output arrives while a command is running and a second channel can release it', async (t) => {
  const { transport, directory } = await setup(t);
  const release = join(directory, 'release');
  const ready = Promise.withResolvers();
  let output = '';
  const execution = transport.exec({
    command: `printf ready; while [ ! -f ${quote(release)} ]; do sleep 0.02; done; printf done`,
    cwd: directory, env: {}, timeoutMs: 5000,
    onChunk(chunk) { output += chunk.text; if (output.includes('ready')) ready.resolve(); },
  });
  await ready.promise;
  await transport.files.write(release, new Uint8Array());
  assert.deepEqual(await execution, { exitCode: 0, timedOut: false });
  assert.equal(output, 'readydone');
});

test('rejects a genuinely different host key blob rather than accepting an altered comment', async (t) => {
  const { access, server, directory } = await setup(t);
  const wrong = createTransport({ ...access, hostPublicKey: server.clientPublicKey });
  try {
    await assert.rejects(wrong.exec({ command: 'true', cwd: directory, env: {}, timeoutMs: 5000, onChunk() {} }), { code: 'auth' });
  } finally { await wrong.close(); }
});

for (const mode of ['timeout', 'abort', 'close']) {
  test(`${mode} terminates descendants before settling rather than only killing the shell`, { timeout: 15_000 }, async (t) => {
    const { transport, directory } = await setup(t);
    await run(transport, directory, 'true');
    const sentinel = join(directory, `${mode}-survivor`);
    const release = join(directory, `${mode}-release`);
    const started = Promise.withResolvers();
    const controller = new AbortController();
    const execution = transport.exec({
      command: `(while [ ! -f ${quote(release)} ]; do sleep 0.02; done; touch ${quote(sentinel)}) & printf STARTED; wait`,
      cwd: directory, env: {}, timeoutMs: mode === 'timeout' ? 1000 : 8000, signal: controller.signal,
      onChunk(chunk) { if (chunk.text.includes('STARTED')) started.resolve(); },
    });
    await started.promise;
    if (mode === 'abort') controller.abort();
    if (mode === 'close') await transport.close();
    assert.deepEqual(await execution, { exitCode: null, timedOut: mode === 'timeout' });
    // The fixture guest is a real local subprocess. Releasing it after cancellation
    // would create this file if any descendant survived the process-group kill.
    await writeFile(release, 'released');
    await delay(150);
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
  });
}
