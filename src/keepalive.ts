import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxError } from '@opencoredev/sandbox-sdk';
import { z } from 'zod';
import { cloudsshOptionsSchema } from './contracts.js';
import type { KeepAliveIdentity, KeepAliveStatus, SandboxRecord, CloudsshOptions } from './contracts.js';

export const keepAliveIntervalMs = 7_200_000;
const identitySchema = z.object({ sessionId: z.string().min(1), threadId: z.string().min(1), runtimeId: z.string().min(1), hostKeySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const keepAliveFileSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-f0-9]{32}$/), unit: z.string(), options: cloudsshOptionsSchema,
  identity: identitySchema, enabled: z.boolean(), state: z.enum(['disabled', 'scheduled', 'running', 'stopped', 'expired', 'failed']),
  intervalMs: z.literal(keepAliveIntervalMs), nextAt: z.number().optional(), lastAttemptAt: z.number().optional(),
  lastSuccessAt: z.number().optional(), lastError: z.string().optional(), ssh: z.enum(['verified', 'busy']).optional(),
  attempt: z.object({ token: z.string(), state: z.enum(['issued', 'completed']) }).strict().optional(),
}).strict();
export type KeepAliveFile = z.infer<typeof keepAliveFileSchema>;
const errnoSchema = z.object({ code: z.string() }).passthrough();
const worker = fileURLToPath(new URL('./keepalive-worker.js', import.meta.url));

function failure(message: string, id?: string) {
  return new SandboxError(message, { code: 'provider', provider: 'cloudssh', sandboxId: id });
}

export function keepAliveDirectory(root: string, id: string) {
  if (!path.isAbsolute(root) || !/^[a-f0-9]{32}$/.test(id)) throw failure('Invalid keepalive registry or sandbox ID', id);
  return path.join(root, id);
}

async function privateText(file: string) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.mode & 0o077) throw failure('Keepalive state must be a private regular file');
  return readFile(file, 'utf8');
}

export async function readKeepAlive(root: string, id: string) {
  try {
    const value = keepAliveFileSchema.parse(JSON.parse(await privateText(path.join(keepAliveDirectory(root, id), 'keepalive.json'))));
    if (value.id !== id || value.options.stateDirectory !== root) throw failure('Keepalive registry identity changed', id);
    return value;
  } catch (cause) {
    const parsed = errnoSchema.safeParse(cause);
    if (parsed.success && parsed.data.code === 'ENOENT') return undefined;
    throw cause;
  }
}

export async function writeKeepAlive(value: KeepAliveFile) {
  const file = path.join(keepAliveDirectory(value.options.stateDirectory, value.id), 'keepalive.json');
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function command(executable: string, args: string[], timeoutMs = 10_000) {
  const result = Promise.withResolvers<{ code: number | null; stdout: string }>();
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout = (stdout + text).slice(-16_384); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.once('error', () => { clearTimeout(timer); result.reject(failure('Keepalive requires Linux systemd-run and a reachable user systemd manager')); });
  child.once('close', (code) => { clearTimeout(timer); result.resolve({ code, stdout: stdout.trim() }); });
  return result.promise;
}

export function keepAliveUnit(root: string, id: string) {
  keepAliveDirectory(root, id);
  return `cloudssh-keepalive-${createHash('sha256').update(root).digest('hex').slice(0, 12)}-${id}.service`;
}

async function activePid(unit: string) {
  const result = await command('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value']);
  if (result.code !== 0) {
    const manager = await command('systemctl', ['--user', 'show', '--property=Version']);
    if (manager.code !== 0) throw failure('Cannot confirm the keepalive worker stopped because its user manager is unavailable');
    return undefined;
  }
  if (!/^[0-9]+$/.test(result.stdout)) throw failure('User manager returned no valid owned-worker PID');
  return Number(result.stdout) || undefined;
}

async function checkWorker(root: string, id: string, unit: string) {
  if (unit !== keepAliveUnit(root, id)) throw failure('Keepalive service identity changed', id);
  const pid = await activePid(unit);
  if (pid === undefined) return false;
  const args = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0').filter(Boolean);
  const expected = [process.execPath, worker, root, id];
  if (args.length !== expected.length || args.some((arg, index) => arg !== expected[index])) throw failure('Keepalive service argv does not match this owned box; no process was stopped', id);
  return true;
}

interface Context {
  get(id: string): Promise<SandboxRecord>;
  identity(id: string): Promise<KeepAliveIdentity>;
}

/** Owns only this registry's transient user service; no controller-wide settings are changed. */
export function createKeepAlive(options: CloudsshOptions, context: Context) {
  const root = options.stateDirectory;
  async function prepare() {
    if (process.platform !== 'linux') throw failure('Keepalive requires Linux with a user systemd manager');
    const manager = await command('systemctl', ['--user', 'show', '--property=Version']);
    if (manager.code !== 0) throw failure('Keepalive requires a reachable user systemd manager; no box was allocated');
    const help = await command(process.execPath, [path.join(options.helperRoot, 'tunnel/src/codex-cloud.mjs'), '--help']);
    if (help.code !== 0 || !/\bkeepalive\b/.test(help.stdout)) throw failure('Update the WorkSSH helper to one supporting native keepalive; no box was allocated');
  }
  async function status(id: string): Promise<KeepAliveStatus> {
    const record = await context.get(id);
    const value = await readKeepAlive(root, id);
    if (!value) return { enabled: record.keepAlive === true, state: record.keepAlive ? 'stopped' : 'disabled', intervalMs: keepAliveIntervalMs };
    if (value.unit !== keepAliveUnit(root, id)) throw failure('Keepalive service identity changed', id);
    const manager = await command('systemctl', ['--user', 'is-active', value.unit]).catch(() => ({ code: null, stdout: 'unavailable' }));
    if (manager.stdout === 'active' && !await checkWorker(root, id, value.unit)) manager.stdout = 'inactive';
    const { enabled, state, intervalMs, nextAt, lastAttemptAt, lastSuccessAt, lastError, ssh } = value;
    return { enabled, state: manager.stdout !== 'active' && (state === 'running' || state === 'scheduled') ? 'stopped' : state,
      intervalMs, nextAt, lastAttemptAt, lastSuccessAt, lastError: lastError ?? (manager.stdout === 'unavailable' ? 'User systemd manager unavailable' : undefined), ssh, managerState: manager.stdout || 'unknown' };
  }
  async function stop(id: string, disabled = false) {
    await context.get(id);
    const value = await readKeepAlive(root, id);
    if (!value) return;
    if (await checkWorker(root, id, value.unit)) {
      const result = await command('systemctl', ['--user', 'stop', value.unit], 65_000);
      if (result.code !== 0 || await activePid(value.unit) !== undefined) throw failure('Owned keepalive worker did not stop; helper mutation was not started', id);
    }
    const final = await readKeepAlive(root, id);
    if (final) await writeKeepAlive({ ...final, enabled: disabled ? false : final.enabled, state: disabled ? 'disabled' : final.state === 'failed' ? 'failed' : 'stopped', nextAt: undefined });
  }
  async function start(id: string, afterRecovery = false) {
    await prepare();
    const record = await context.get(id);
    if (record.phase !== 'ready' || record.createdAt + record.timeoutMs <= Date.now()) throw failure('Keepalive cannot enable an unavailable or expired box; recover explicitly first', id);
    const previous = await readKeepAlive(root, id);
    if (previous && await checkWorker(root, id, previous.unit)) return status(id);
    if (!afterRecovery && previous && (previous.attempt?.state === 'issued' || previous.lastError)) throw failure('Previous keepalive attempt failed or has an uncertain outcome; inspect it and recover explicitly, not by retrying maintenance', id);
    const value: KeepAliveFile = { version: 1, id, unit: keepAliveUnit(root, id), options, identity: await context.identity(id),
      enabled: true, state: 'scheduled', intervalMs: keepAliveIntervalMs, nextAt: Date.now() };
    await writeKeepAlive(value);
    const result = await command('systemd-run', ['--user', `--unit=${value.unit}`, '--collect', '--service-type=exec',
      '--property=Restart=no', '--property=TimeoutStopSec=60s', '--property=UMask=0077',
      `--property=RuntimeMaxSec=${Math.ceil((record.createdAt + record.timeoutMs - Date.now()) / 1000)}s`,
      process.execPath, worker, root, id]);
    if (result.code !== 0) {
      await writeKeepAlive({ ...value, state: 'failed', lastError: 'User systemd manager did not start the keepalive worker' });
      throw failure('Keepalive service could not start; the box is retained for inspection or destruction', id);
    }
    return status(id);
  }
  return { prepare, status, start, stop };
}
