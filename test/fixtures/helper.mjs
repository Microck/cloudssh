import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A deterministic local control plane. It never imports the real cloud helper or contacts a cloud API. */
export async function createFixtureHelper(root, options = {}) {
  const directory = path.join(root, 'tunnel', 'src');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let { privateKey, hostPublicKey } = options;
  if (!privateKey || !hostPublicKey) {
    const host = path.join(root, 'fixture-host');
    const identity = path.join(root, 'fixture-client');
    for (const file of [host, identity]) {
      const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    privateKey = await readFile(identity);
    hostPublicKey = (await readFile(`${host}.pub`, 'utf8')).trim();
  }
  const fixture = {
    privateKey: privateKey.toString('utf8'), hostPublicKey,
    port: options.port ?? 0, scratchDirectory: options.scratchDirectory ?? path.join(root, 'guest-scratch'),
    mode: options.mode ?? 'ready',
  };
  await writeFile(path.join(root, 'fixture.json'), JSON.stringify(fixture), { mode: 0o600 });
  await writeFile(path.join(directory, 'codex-cloud.mjs'), `
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const root = new URL('../../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('fixture.json', root), 'utf8'));
const directory = args[args.indexOf('--state-dir') + 1];
const file = path.join(directory, 'session.json');
const save = (name, value) => writeFile(path.join(directory, name), JSON.stringify(value), { mode: 0o600 });
if (args[0] === 'up') {
  // Mirror the real helper's refusal to overwrite an existing session directory.
  await mkdir(directory, { mode: 0o700 });
  const state = { version: 1, phase: 'creating', count: 1, vms: [], workerOwned: true, configId: 'fixture-config', vaultId: 'fixture-vault', relayToken: 'local-fixture-relay-token-not-a-cloud-credential' };
  await save('session.json', state);
  await mkdir(path.join(directory, '.lock'), { mode: 0o700 });
  await writeFile(path.join(directory, '.lock/pid'), String(process.pid), { mode: 0o600 });
  if (fixture.mode === 'wait') {
    await writeFile(new URL('started', root), 'waiting');
    const stopped = Promise.withResolvers();
    process.once('SIGINT', () => { process.exitCode = 130; stopped.resolve(); });
    const hold = setInterval(() => {}, 1000);
    await stopped.promise;
    clearInterval(hold);
  } else {
    await mkdir(fixture.scratchDirectory, { recursive: true, mode: 0o700 });
    state.phase = fixture.mode === 'bad' ? 'failed' : 'ready';
    state.vms = [{ index: 1, runtimeId: 'fixture-runtime', agentDeadline: new Date(Number(args[args.indexOf('--agent-deadline') + 1])).toISOString(), hostPublicKey: fixture.hostPublicKey, scratch: fixture.scratchDirectory, offline: false }];
    await save('session.json', state);
    await writeFile(path.join(directory, 'client_key'), fixture.privateKey, { mode: 0o600 });
    await save('vm-1.json', { workerUrl: 'https://fixture.invalid', relayToken: state.relayToken, tunnelId: '0'.repeat(32), transport: 'websocket' });
    await rm(path.join(directory, '.lock'), { recursive: true });
    process.stdout.write(JSON.stringify({ phase: state.phase, count: 1, vms: [{ index: 1, ready: state.phase === 'ready', offline: false }] }));
  }
} else if (args[0] === 'resume') {
  const state = JSON.parse(await readFile(file, 'utf8'));
  if (state.closed || state.phase !== 'ready') throw new Error('Cannot resume deleted fixture');
  if (fixture.mode === 'resume-denied') throw new Error('Fixture recovery approval denied');
  const vm = state.vms[0];
  if (Date.parse(vm.agentDeadline) <= Date.now()) vm.agentDeadline = new Date(Number(args[args.indexOf('--agent-deadline') + 1])).toISOString();
  if (fixture.mode === 'resume-changed-runtime') vm.runtimeId = 'replacement-runtime';
  await save('session.json', state);
  process.stdout.write(JSON.stringify({ phase: state.phase, count: 1, vms: [{ index: 1, ready: true, offline: false }] }));
} else if (args[0] === 'down') {
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.phase = 'deleted'; state.closed = true;
  const confirmed = fixture.mode !== 'unconfirmed';
  state.workerDeleted = confirmed; state.configDeleted = confirmed; state.vaultDeleted = confirmed;
  state.vms = state.vms.map(vm => ({ ...vm, offline: confirmed }));
  if (confirmed) {
    delete state.relayToken;
    for (const name of ['client_key', 'vm-1.json']) await rm(path.join(directory, name), { force: true });
  }
  await save('session.json', state);
  process.stdout.write(JSON.stringify({ phase: 'deleted', count: 1, vms: state.vms.map(vm => ({ index: 1, ready: false, offline: vm.offline })) }));
} else { throw new Error('Unexpected local fixture command'); }
`, { mode: 0o600 });
  await writeFile(path.join(directory, 'proxy.mjs'), `
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
const fixture = JSON.parse(await readFile(new URL('../../fixture.json', import.meta.url), 'utf8'));
if (!fixture.port) throw new Error('This local fixture has no SSH backend');
const socket = connect({ host: '127.0.0.1', port: fixture.port });
socket.pipe(process.stdout); process.stdin.pipe(socket);
socket.once('error', () => process.exit(1));
socket.once('close', () => process.exit());
`, { mode: 0o600 });
}
