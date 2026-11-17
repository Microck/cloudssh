import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxError } from '@opencoredev/sandbox-sdk';
import { z } from 'zod';
import { createLifecycle } from './lifecycle.js';
import { createTransport } from './ssh.js';
import { keepAliveDirectory, keepAliveIntervalMs, readKeepAlive, writeKeepAlive } from './keepalive.js';
import type { KeepAliveFile } from './keepalive.js';
import type { GuestTransport, Lifecycle } from './contracts.js';

function failure(message: string, id: string) {
  return new SandboxError(message, { code: 'provider', provider: 'cloudssh', sandboxId: id });
}

/** One durable issued marker covers one native RPC. A crash is never a retry signal. */
export async function keepAliveStep(lifecycle: Lifecycle, current: KeepAliveFile, signal: AbortSignal): Promise<KeepAliveFile> {
  let value = current;
  try {
    const record = await lifecycle.get(value.id);
    if (record.phase !== 'ready' || !record.keepAlive) return { ...value, enabled: false, state: 'disabled', nextAt: undefined };
    if (Date.now() >= record.createdAt + record.timeoutMs) return { ...value, state: 'expired', nextAt: undefined };
    if (value.attempt?.state === 'issued') throw failure('Previous native resume outcome is uncertain; no request was retried', value.id);
    signal.throwIfAborted();
    const token = randomBytes(16).toString('hex');
    value = { ...value, state: 'running', lastAttemptAt: Date.now(), attempt: { token, state: 'issued' } };
    await writeKeepAlive(value);
    await lifecycle.maintain(value.id, value.identity, signal);
    value = { ...value, lastSuccessAt: Date.now(), attempt: { token, state: 'completed' } };
    await writeKeepAlive(value);
    let release: (() => Promise<void>) | undefined;
    try { release = await lifecycle.acquire(value.id); }
    catch (cause) {
      if (!(cause instanceof SandboxError) || !cause.message.startsWith('Session is busy or has a stale lease at ')) throw cause;
      return { ...value, ssh: 'busy', nextAt: Date.now() + keepAliveIntervalMs };
    }
    let transport: GuestTransport | undefined;
    try {
      signal.throwIfAborted();
      const access = await lifecycle.access(value.id);
      transport = createTransport(access);
      const result = await transport.exec({ command: 'true', cwd: access.scratchDirectory, env: {}, timeoutMs: 10_000, signal,
        onChunk() { /* A health check uses the exit status, never guest output in service logs. */ } });
      if (result.exitCode !== 0 || result.timedOut) throw failure('SSH health failed after native resume; no model repair was requested', value.id);
      return { ...value, ssh: 'verified', nextAt: Date.now() + keepAliveIntervalMs };
    } finally {
      try { await transport?.close(); }
      finally { await release(); }
    }
  } catch (cause) {
    return { ...value, state: 'failed', nextAt: undefined, lastError: signal.aborted ? 'Keepalive was interrupted; inspect any issued request before recovery' : cause instanceof SandboxError ? cause.message : 'Keepalive failed; inspect its private state before explicit recovery' };
  }
}

async function releaseWorkerLease(lease: string, owner: { pid: number; token: string }, id: string) {
  const current = z.object({ pid: z.number(), token: z.string() }).strict().parse(JSON.parse(await readFile(path.join(lease, 'owner.json'), 'utf8')));
  if (current.pid !== owner.pid || current.token !== owner.token) throw failure('Keepalive worker lease owner changed; no lock was removed', id);
  await rm(lease, { recursive: true });
}

export async function runKeepAlive(root: string, id: string) {
  let value = await readKeepAlive(root, id);
  if (!value) throw failure('Missing keepalive controller state', id);
  const lifecycle = createLifecycle(value.options);
  await lifecycle.get(id);
  const lease = path.join(keepAliveDirectory(root, id), '.keepalive-worker-lease');
  const owner = { pid: process.pid, token: randomBytes(16).toString('hex') };
  const controller = new AbortController();
  const abort = () => controller.abort();
  await mkdir(lease, { mode: 0o700 });
  try {
    await writeFile(path.join(lease, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    process.once('SIGTERM', abort); process.once('SIGINT', abort);
    while (value.enabled) {
      const record = await lifecycle.get(id);
      const remaining = record.createdAt + record.timeoutMs - Date.now();
      if (remaining <= 0) { value.state = 'expired'; value.nextAt = undefined; break; }
      try { await delay(Math.max(0, Math.min(remaining, (value.nextAt ?? Date.now()) - Date.now())), undefined, { signal: controller.signal }); }
      catch (cause) { if (!controller.signal.aborted) throw cause; }
      if (controller.signal.aborted) { value.state = Date.now() >= record.createdAt + record.timeoutMs ? 'expired' : 'stopped'; value.nextAt = undefined; break; }
      value = await keepAliveStep(lifecycle, value, controller.signal);
      await writeKeepAlive(value);
      if (value.state !== 'running') break;
    }
    await writeKeepAlive(value);
    if (value.state === 'failed') throw failure('Keepalive stopped after a failed or uncertain attempt; no automatic retry', id);
  } finally {
    process.off('SIGTERM', abort); process.off('SIGINT', abort);
    await releaseWorkerLease(lease, owner, id);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, id] = process.argv.slice(2);
  if (!root || !id) throw new Error('Expected private controller registry and sandbox ID');
  await runKeepAlive(root, id).catch(() => {
    process.stderr.write('CloudSSH keepalive stopped. Inspect the box keepalive status; no model work, repair or retry was requested.\n');
    process.exitCode = 1;
  });
}
