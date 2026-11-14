import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startSshd } from './fixtures/sshd.mjs';
import { createFixtureHelper } from './fixtures/helper.mjs';

const executable = process.env.RAFT_TEST_CLI ?? 'raft';
const entry = fileURLToPath(new URL('../dist/raft.js', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'workssh-raft-integration-'));
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const server = await startSshd({ directory: join(root, 'sshd') });
  const options = { helperRoot: join(root, 'helper'), stateDirectory: join(root, 'state') };
  await createFixtureHelper(options.helperRoot, { ...server, scratchDirectory: join(root, 'scratch') });
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, 'cache'), RAFT_NO_UPDATE_CHECK: '1' };
  let handle;
  async function command(args, expected = 0, input = '', pty = false) {
    const child = pty
      ? spawn('script', ['-qefc', [executable, ...args].map(quote).join(' '), '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 })
      : spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    const ended = Promise.withResolvers();
    child.once('error', ended.reject);
    child.once('close', code => ended.resolve(code));
    child.stdin.end(input);
    const code = await ended.promise;
    if (expected === 'failure') assert.notEqual(code, 0, stdout);
    else assert.equal(code, expected, `${args.join(' ')}: ${stderr}\n${stdout}`);
    return { stdout, stderr };
  }
  t.after(async () => {
    try { if (handle) await command(['destroy', handle]); }
    finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });
  await command(['plugin', 'add', 'openai', '--', process.execPath, entry]);
  const configuration = join(home, '.config/raft/incus.json');
  const locations = JSON.parse(await readFile(configuration, 'utf8'));
  locations.openai.options = options;
  locations.foreign = { ...locations.openai };
  await writeFile(configuration, JSON.stringify(locations));
  return { root, command, options, create: async (ttl = 600) => {
    handle = (await command(['new', '--location', 'openai', '--disposable', '--ttl', String(ttl), '--purpose', 'isolated CLI acceptance', '--owner', 'plugin tests'])).stdout.trim();
    assert.match(handle, /^openai:[a-f0-9]{32}$/);
    return handle;
  }, destroyed: () => { handle = undefined; } };
}

test('actual Raft supports host reports, terminal SSH, safe trees and retained detached jobs', { timeout: 90_000 }, async t => {
  const { root, command, create, destroyed } = await setup(t);
  const empty = JSON.parse((await command(['capacity', '--location', 'openai', '--json'])).stdout);
  assert.equal(empty.available, null); assert.equal(empty.localLimit, null); assert.equal(empty.boxes, 0);
  const handle = await create();
  const info = JSON.parse((await command(['info', handle])).stdout);
  assert.equal(info.health.status, 'reachable');
  assert.ok(info.resources.hostname);
  const listed = JSON.parse((await command(['list', '--location', 'openai'])).stdout);
  assert.equal(listed.state, 'Running'); assert.equal(listed.health.status, 'reachable');
  assert.equal(JSON.parse((await command(['usage', handle])).stdout).box, handle);
  await command(['doctor', '--location', 'openai']);
  const terminal = await command(['ssh', handle], 0, "printf 'REMOTE_%s\\n' TTY_OK; test -t 0; exit $?\n", true);
  assert.match(terminal.stdout, /REMOTE_TTY_OK/);
  assert.equal((await command(['exec', handle, '--', 'printf', '%s', "literal '$HOME; argument"])).stdout, "literal '$HOME; argument");
  assert.equal((await command(['exec', handle, '--', 'cat'], 0, 'stdin payload\n')).stdout, 'stdin payload\n');

  const tree = join(root, 'tree'), remote = join(root, 'remote-tree'), copied = join(root, 'copied');
  await mkdir(join(tree, 'empty'), { recursive: true });
  const bytes = Buffer.from([0, 255, 128, 10]);
  await writeFile(join(tree, 'tool'), bytes); await chmod(join(tree, 'tool'), 0o751);
  await link(join(tree, 'tool'), join(tree, 'hard')); await symlink('tool', join(tree, 'relative'));
  await command(['upload', handle, tree, remote, '--recursive']);
  await command(['download', handle, remote, copied, '--recursive']);
  assert.deepEqual(await readFile(join(copied, 'tool')), bytes);
  assert.equal((await stat(join(copied, 'tool'))).mode & 0o777, 0o751);
  assert.equal((await stat(join(copied, 'hard'))).ino, (await stat(join(copied, 'tool'))).ino);
  assert.equal((await lstat(join(copied, 'relative'))).isSymbolicLink(), true);
  await access(join(copied, 'empty'));
  await command(['download', handle, remote, copied, '--recursive'], 'failure');
  await symlink('../outside', join(tree, 'escape'));
  const rejected = join(root, 'rejected');
  await command(['upload', handle, tree, rejected, '--recursive'], 'failure');
  await assert.rejects(access(rejected), { code: 'ENOENT' });

  const job = (await command(['exec', '--detach', handle, '--', 'bash', '-c', 'printf detached-output; exit 7'])).stdout.trim();
  assert.match(job, /^rfcmd-[a-f0-9]{32}$/);
  let state;
  const deadline = Date.now() + 10_000;
  do {
    state = JSON.parse((await command(['status', handle, job])).stdout);
    if (state.state === 'completed') break;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(state.state, 'completed'); assert.equal(state.exitCode, 7);
  assert.equal((await command(['logs', handle, job])).stdout, 'detached-output');
  const active = (await command(['exec', '--detach', handle, '--', 'sleep', '30'])).stdout.trim();
  assert.equal((await command(['exec', handle, '--', 'printf', 'parallel-channel'])).stdout, 'parallel-channel');
  const cancelled = JSON.parse((await command(['cancel', handle, active])).stdout);
  assert.equal(cancelled.state, 'cancelled');
  await command(['destroy', handle.replace('openai:', 'foreign:')], 'failure');
  await command(['destroy', handle]); destroyed();
  assert.equal(JSON.parse((await command(['status', handle, job])).stdout).exitCode, 7);
  assert.equal((await command(['logs', handle, job])).stdout, 'detached-output');
  assert.equal((await command(['list', '--location', 'openai'])).stdout, '');
});

test('gc deletes only expired sessions owned by its selected location', { timeout: 30_000 }, async t => {
  const { command, options, create, destroyed } = await setup(t);
  const handle = await create();
  const file = join(options.stateDirectory, handle.split(':')[1], 'record.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.createdAt = Date.now() - record.timeoutMs - 1000;
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await command(['gc', '--location', 'foreign']);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).phase, 'ready');
  const result = JSON.parse((await command(['gc', '--location', 'openai'])).stdout);
  assert.equal(result.box, handle); assert.equal(result.destroyed, true);
  const deleted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(deleted.phase, 'deleted'); assert.deepEqual(deleted.env, {});
  destroyed();
});

test('expired access resumes the same sandbox and preserves files without implicit renewal', { timeout: 45_000 }, async t => {
  const { root, command, options, create } = await setup(t);
  const handle = await create(28_800);
  const id = handle.split(':')[1];
  const recordFile = join(options.stateDirectory, id, 'record.json');
  const sessionFile = join(options.stateDirectory, id, 'cloud/session.json');
  const initial = JSON.parse(await readFile(recordFile, 'utf8'));
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(Date.parse(session.vms[0].agentDeadline), initial.createdAt + 28_800_000);
  const marker = join(root, 'retained.bin');
  const before = (await command(['exec', handle, '--', 'python3', '-c', 'import hashlib,sys; from pathlib import Path; p=Path(sys.argv[1]); p.write_bytes(bytes(range(256))); print(hashlib.sha256(p.read_bytes()).hexdigest())', marker])).stdout;
  await writeFile(recordFile, JSON.stringify({ ...initial, timeoutMs: 1 }));
  session.vms[0].agentDeadline = '2000-01-01T00:00:00Z';
  await writeFile(sessionFile, JSON.stringify(session));
  const expired = await command(['exec', handle, '--', 'touch', join(root, 'must-not-execute')], 'failure');
  assert.match(expired.stderr, /SSH access expired/);
  await assert.rejects(access(join(root, 'must-not-execute')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).timeoutMs, 1);
  await command(['resume', handle.replace('openai:', 'foreign:'), '--ttl', '28800'], 'failure');
  const resumed = JSON.parse((await command(['resume', handle, '--ttl', '28800'])).stdout);
  assert.equal(resumed.box, handle);
  assert.equal(resumed.vmRestarted, false);
  const after = (await command(['exec', handle, '--', 'python3', '-c', 'import hashlib,sys; from pathlib import Path; print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())', marker])).stdout;
  assert.equal(after, before);
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  const recovered = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(record.createdAt, initial.createdAt);
  assert.deepEqual(record.labels, initial.labels);
  assert.equal(recovered.vms[0].runtimeId, session.vms[0].runtimeId);
  assert.equal(recovered.vms[0].hostPublicKey, session.vms[0].hostPublicKey);
  assert.equal(record.createdAt + record.timeoutMs, Date.parse(recovered.vms[0].agentDeadline));
  const stillRunning = JSON.parse((await command(['resume', handle, '--ttl', '43200'])).stdout);
  assert.equal(stillRunning.agentExpiresAt, resumed.agentExpiresAt, 'explicit reconnect must not silently extend an already-running supervisor');
});
