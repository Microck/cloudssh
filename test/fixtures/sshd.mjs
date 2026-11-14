import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import { z } from 'zod';

const { Server, utils } = ssh2;

/** Real SSH public-key authentication and exec channels, backed only by owned guest subprocesses. */
export async function startSshd({ directory } = {}) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'workssh-sshd-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const host = join(root, 'host_ed25519');
  const identity = join(root, 'client_ed25519');
  for (const file of [host, identity]) {
    const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { encoding: 'utf8' });
    if (generated.status !== 0) throw new Error(generated.stderr || 'ssh-keygen failed');
  }
  const allowed = utils.parseKey(await readFile(`${identity}.pub`));
  if (allowed instanceof Error || Array.isArray(allowed)) throw new Error('Invalid fixture identity');
  const clients = new Set();
  const children = new Set();
  const server = new Server({ hostKeys: [await readFile(host)] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (context.username !== 'root' || context.method !== 'publickey' || !context.key.data.equals(allowed.getPublicSSH())) {
        context.reject(); return;
      }
      if (!context.signature || allowed.verify(context.blob, context.signature, context.hashAlgo) === true) context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      let hasPty = false;
      let ptyRows = 24;
      let ptyColumns = 80;
      let ptyTerm = 'vt100';
      session.on('pty', (acceptPty, _rejectPty, info) => {
        hasPty = true;
        ptyRows = info.rows;
        ptyColumns = info.cols;
        ptyTerm = info.term;
        acceptPty();
      });
      session.on('shell', (acceptShell) => {
        if (!hasPty) return;
        const channel = acceptShell();
        const child = spawn('/usr/bin/script', ['-qefc', `stty rows ${ptyRows} cols ${ptyColumns}; exec /bin/bash --noprofile --norc -i`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: ptyTerm } });
        children.add(child);
        channel.pipe(child.stdin);
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        child.stdin.on('error', () => {});
        channel.on('error', () => {});
        channel.once('close', () => { if (child.exitCode === null) child.kill('SIGHUP'); });
        child.once('error', () => { channel.exit(1); channel.end(); });
        child.once('close', (code, signal) => {
          children.delete(child);
          if (signal) channel.exit(signal);
          else channel.exit(code ?? 1);
          channel.end();
        });
      });
      session.on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec();
        const child = spawn('/bin/bash', ['-lc', info.command], { stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
        channel.pipe(child.stdin);
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        child.stdin.on('error', () => {});
        channel.on('error', () => {});
        channel.once('close', () => { if (child.exitCode === null) child.kill('SIGHUP'); });
        child.once('error', () => { channel.exit(1); channel.end(); });
        child.once('close', (code) => {
          children.delete(child);
          channel.exit(code ?? 1);
          channel.end();
        });
      });
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  return {
    port: address.port,
    privateKey: await readFile(identity),
    hostPublicKey: (await readFile(`${host}.pub`, 'utf8')).trim(),
    clientPublicKey: (await readFile(`${identity}.pub`, 'utf8')).trim(),
    async close() {
      for (const client of clients) client.end();
      for (const child of children) child.kill('SIGHUP');
      await Promise.all([...children].map((child) => once(child, 'close').catch(() => {})));
      const closed = Promise.withResolvers();
      server.close(() => closed.resolve());
      await closed.promise;
      await rm(root, { recursive: true, force: true });
    },
  };
}
