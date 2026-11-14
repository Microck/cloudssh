import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { jobOperations, retainedLogs, retainedStatus } from '../dist/jobs.js';
import { createTransport } from '../dist/ssh.js';
import { startSshd } from './fixtures/sshd.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'workssh-jobs-'));
  const server = await startSshd({ directory: join(root, 'sshd') });
  const access = { id: 'fixture', proxyCommand: [process.execPath, new URL('./fixtures/proxy.mjs', import.meta.url).pathname, String(server.port)],
    privateKey: server.privateKey, hostPublicKey: server.hostPublicKey, scratchDirectory: join(root, 'remote-scratch') };
  const id = 'a'.repeat(32), box = `openai:${id}`;
  const record = { version: 1, id, labels: {}, env: { JOB_FIXTURE: 'from-record' }, createdAt: Date.now(), timeoutMs: 60_000, phase: 'ready' };
  const directory = join(root, 'state', id, 'jobs');
  const connections = [];
  const connect = () => { const guest = createTransport(access); connections.push(guest); return { guest, jobs: jobOperations(guest, record, directory, box) }; };
  t.after(async () => {
    const cleanup = connect();
    try { await cleanup.jobs.finish(); }
    finally {
      try { await Promise.all(connections.map(guest => guest.close())); }
      finally { await server.close(); await rm(root, { recursive: true, force: true }); }
    }
  });
  return { ...connect(), root, box, directory, connect };
}
async function terminal(jobs, job) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const state = await jobs.status(job);
    if (state.finishedAt !== null) return state;
    await delay(40);
  }
  throw new Error('Detached job did not reach a terminal state');
}

test('detached jobs survive connection close and retain actual exit status, environment and both streams', { timeout: 20_000 }, async t => {
  const { guest, jobs, root, box, directory, connect } = await setup(t);
  const release = join(root, 'release');
  const source = `import os,sys,time\nprint(os.environ['JOB_FIXTURE'],flush=True)\nprint('stderr-value',file=sys.stderr,flush=True)\nwhile not os.path.exists(sys.argv[1]): time.sleep(.02)\nsys.exit(7)`;
  const job = await jobs.start(['python3', '-c', source, release], 10_000);
  await guest.close();
  const next = connect();
  await next.guest.files.write(release, new Uint8Array());
  const result = await terminal(next.jobs, job);
  assert.equal(result.state, 'completed'); assert.equal(result.exitCode, 7);
  await next.guest.close();
  assert.equal((await retainedStatus(directory, box, job)).exitCode, 7);
  const log = Buffer.from(await retainedLogs(directory, box, job)).toString();
  assert.equal(log, 'from-record\nstderr-value\n');
});

test('cancellation confirms descendant termination and foreign job handles cannot mutate the record', { timeout: 20_000 }, async t => {
  const { jobs, root, box, directory } = await setup(t);
  const release = join(root, 'release'), survivor = join(root, 'survivor');
  const command = '(while [ ! -f "$1" ]; do sleep .02; done; touch "$2") & printf STARTED; wait';
  const job = await jobs.start(['bash', '-c', command, 'job', release, survivor], 10_000);
  const cancelled = await jobs.cancel(job);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.exitCode, null);
  await writeFile(release, 'released'); await delay(150);
  await assert.rejects(readFile(survivor), { code: 'ENOENT' });
  await assert.rejects(retainedStatus(directory, `foreign:${'b'.repeat(32)}`, job));
  assert.equal((await retainedStatus(directory, box, job)).state, 'cancelled');
});

test('job output is drained but only its first MiB is retained, with exact dropped-byte accounting', { timeout: 20_000 }, async t => {
  const { jobs, directory, box } = await setup(t);
  const job = await jobs.start(['python3', '-c', 'import os; os.write(1,b"a"*2000000); os.write(2,b"b"*200000)'], 10_000);
  const result = await terminal(jobs, job);
  assert.equal(result.exitCode, 0); assert.equal(result.droppedBytes, 2_200_000 - 1024 * 1024);
  assert.deepEqual(Buffer.from(await jobs.logs(job)), Buffer.alloc(1024 * 1024, 'a'));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const file = join(directory, `${job}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await chmod(file, 0o644);
  await assert.rejects(retainedStatus(directory, box, job));
  await chmod(file, 0o600);
});

test('a detached command deadline is enforced by its guest worker after the launching channel exits', { timeout: 15_000 }, async t => {
  const { jobs } = await setup(t);
  const job = await jobs.start(['sleep', '30'], 500);
  const result = await terminal(jobs, job);
  assert.equal(result.state, 'failed'); assert.equal(result.exitCode, null);
});
