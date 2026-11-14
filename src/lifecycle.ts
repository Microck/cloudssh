import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, lstat, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxError } from '@opencoredev/sandbox-sdk';
import type { ErrorCode } from '@opencoredev/sandbox-sdk';
import type { CreateInput } from '@opencoredev/sandbox-sdk/provider';
import { z } from 'zod';
import { accessTimeoutSchema } from './contracts.js';
import type { Lifecycle, SandboxRecord, SshAccess, WorksshOptions } from './contracts.js';

const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const recordSchema = z.object({
  version: z.literal(1), id: idSchema, key: z.string().optional(),
  labels: z.record(z.string(), z.string()), env: z.record(z.string(), z.string()),
  createdAt: z.number().finite(), timeoutMs: z.number().finite(),
  phase: z.enum(['creating', 'ready', 'failed', 'deleting', 'deleted']), helperPid: z.number().int().positive().optional(),
}).strict();
const sessionVmSchema = z.object({ index: z.literal(1), hostPublicKey: z.string().optional(), runtimeId: z.string().optional(), agentDeadline: z.string().optional(), offline: z.boolean().optional(), scratch: z.string() }).passthrough();
const sessionSchema = z.object({
  version: z.literal(1), phase: z.string(), closed: z.boolean().optional(), count: z.literal(1),
  configId: z.string().optional(), configDeleted: z.boolean().optional(),
  vaultId: z.string().optional(), vaultDeleted: z.boolean().optional(),
  workerOwned: z.boolean().optional(), workerDeleted: z.boolean().optional(), relayToken: z.string().optional(),
  vms: z.array(sessionVmSchema),
}).passthrough();
const readySessionSchema = sessionSchema.extend({
  phase: z.literal('ready'), closed: z.literal(false).optional(),
  configDeleted: z.literal(false).optional(), vaultDeleted: z.literal(false).optional(), workerDeleted: z.literal(false).optional(),
  vms: z.tuple([sessionVmSchema.extend({
    hostPublicKey: z.string().min(1), runtimeId: z.string().min(1),
    agentDeadline: z.iso.datetime({ offset: true }), offline: z.literal(false).optional(),
  })]),
});
const outputSchema = z.object({ phase: z.string(), count: z.literal(1), vms: z.array(z.object({ index: z.literal(1), ready: z.boolean(), offline: z.boolean() }).passthrough()) }).passthrough();
const vmConfigSchema = z.object({ workerUrl: z.url().startsWith('https://'), relayToken: z.string().min(32), tunnelId: z.string().regex(/^[a-f0-9]{32}$/), transport: z.literal('websocket') }).strict();
const leaseSchema = z.object({ pid: z.number().int().positive(), token: idSchema }).strict();
const systemError = z.object({ code: z.string() }).passthrough();
const provider = 'workssh';

function hasCode(cause: unknown, code: string) {
  const parsed = systemError.safeParse(cause);
  return parsed.success && parsed.data.code === code;
}

function failure(message: string, code: ErrorCode, sandboxId?: string, cause?: unknown) {
  return new SandboxError(message, {
    code, provider, sandboxId,
    cause: cause instanceof Error ? cause.message : undefined,
    hint: code === 'outcome_unknown' ? 'Inspect the retained sandbox ID and destroy it before creating a replacement.' : undefined,
  });
}

function accessTimeout(value: number) {
  const parsed = accessTimeoutSchema.safeParse(value);
  if (!parsed.success) throw failure('timeoutMs must be integer milliseconds from 60000 through 2592000000', 'invalid_argument');
  return parsed.data;
}

async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o077)) throw failure(`Expected a private real directory: ${directory}`, 'provider');
}

async function privateText(file: string) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077)) throw failure(`Expected a private regular file: ${file}`, 'provider');
  return readFile(file, 'utf8');
}

/** Durable controller state is separate from the helper's private provisioning journal. */
export function createLifecycle(options: WorksshOptions): Lifecycle {
  const root = options.stateDirectory;
  const helper = path.join(options.helperRoot, 'tunnel/src/codex-cloud.mjs');
  const proxy = path.join(options.helperRoot, 'tunnel/src/proxy.mjs');
  const operationTimeout = options.operationTimeoutMs ?? 600_000;

  function directory(id: string) {
    if (!idSchema.safeParse(id).success) throw failure('Invalid sandbox ID', 'invalid_argument', id);
    return path.join(root, id);
  }
  const sessionDirectory = (id: string) => path.join(directory(id), 'cloud');

  async function save(record: SandboxRecord) {
    const file = path.join(directory(record.id), 'record.json');
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function get(id: string): Promise<SandboxRecord> {
    try {
      await privateDirectory(root);
      await privateDirectory(directory(id));
      const record = recordSchema.parse(JSON.parse(await privateText(path.join(directory(id), 'record.json'))));
      if (record.id !== id) throw failure('Sandbox journal identity differs from its directory', 'provider', id);
      return record;
    } catch (cause) {
      if (hasCode(cause, 'ENOENT')) throw failure('Sandbox is not in this controller registry', 'not_found', id);
      throw cause;
    }
  }

  async function session(id: string) {
    await privateDirectory(sessionDirectory(id));
    return sessionSchema.parse(JSON.parse(await privateText(path.join(sessionDirectory(id), 'session.json'))));
  }

  async function list(): Promise<SandboxRecord[]> {
    try { await privateDirectory(root); }
    catch (cause) { if (hasCode(cause, 'ENOENT')) return []; throw cause; }
    const records: SandboxRecord[] = [];
    for (const name of await readdir(root)) {
      if (!idSchema.safeParse(name).success) continue;
      const record = await get(name);
      if (record.phase !== 'deleted') records.push(record);
    }
    return records;
  }

  async function acquire(id: string) {
    await get(id);
    const lease = path.join(directory(id), '.ssh-lease');
    try { await mkdir(lease, { mode: 0o700 }); }
    catch (cause) {
      if (hasCode(cause, 'EEXIST')) throw failure(`Session is busy or has a stale lease at ${lease}. Inspect owner.json and confirm its PID has ended before manual removal`, 'provider', id);
      throw cause;
    }
    const owner = { pid: process.pid, token: randomBytes(16).toString('hex') };
    try { await writeFile(path.join(lease, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (cause) { await rm(lease, { recursive: true, force: true }); throw cause; }
    return async () => {
      const current = leaseSchema.parse(JSON.parse(await privateText(path.join(lease, 'owner.json'))));
      if (current.pid !== owner.pid || current.token !== owner.token) throw failure('Lease ownership changed; refusing release', 'provider', id);
      await rm(lease, { recursive: true });
    };
  }

  async function clearOwnedDeadLock(id: string, record: SandboxRecord) {
    const lock = path.join(sessionDirectory(id), '.lock');
    try { await privateDirectory(lock); }
    catch (cause) { if (hasCode(cause, 'ENOENT')) return; throw cause; }
    const pid = z.string().regex(/^[1-9][0-9]*$/).parse((await privateText(path.join(lock, 'pid'))).trim());
    if (record.helperPid !== Number(pid)) throw failure('Helper lock is not from the recorded helper PID; inspect it manually', 'outcome_unknown', id);
    try { process.kill(record.helperPid, 0); }
    catch (cause) {
      if (hasCode(cause, 'ESRCH')) { await rm(lock, { recursive: true }); return; }
      throw cause;
    }
    throw failure('The recorded helper is still running; no lock was removed', 'outcome_unknown', id);
  }

  async function invoke(id: string, action: 'up' | 'resume' | 'down', extra: string[], signal?: AbortSignal) {
    if (signal?.aborted) throw failure('Operation was aborted before helper start', 'aborted', id);
    // Up must create this directory itself. Precreating it makes the helper refuse creation.
    if (action !== 'up') await privateDirectory(sessionDirectory(id));
    const args = [helper, action, '--state-dir', sessionDirectory(id), '--json', ...extra];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const exit = Promise.withResolvers<{ code: number | null; cause?: Error }>();
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout = (stdout + text).slice(-1024 * 1024); });
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-8000); });
    child.once('error', (cause) => exit.resolve({ code: null, cause }));
    child.once('close', (code) => exit.resolve({ code }));
    const cancelled = Promise.withResolvers<void>();
    let timedOut = false;
    const abort = () => cancelled.resolve();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, operationTimeout);
    function stop(number: NodeJS.Signals) {
      if (!child.pid) return;
      try { process.kill(-child.pid, number); }
      catch (cause) { if (!hasCode(cause, 'ESRCH')) throw cause; }
    }
    try {
      const record = await get(id);
      await save({ ...record, helperPid: child.pid });
      const outcome = await Promise.race([
        exit.promise.then((value) => ({ kind: 'exit' as const, value })),
        cancelled.promise.then(() => ({ kind: 'cancel' as const })),
      ]);
      if (outcome.kind === 'cancel') {
        stop('SIGINT');
        const ended = await Promise.race([exit.promise.then(() => true), delay(2000, undefined, { ref: false }).then(() => false)]);
        if (!ended) { stop('SIGKILL'); await exit.promise; }
        throw failure(timedOut ? 'Helper deadline exceeded; remote outcome is unknown' : 'Helper was interrupted; remote outcome is unknown', 'outcome_unknown', id);
      }
      if (outcome.value.cause || outcome.value.code !== 0) {
        const code = stderr.includes('Included Codex allowance is exhausted') ? 'quota' : action === 'down' ? 'provider' : 'outcome_unknown';
        throw failure(`Helper ${action} did not complete${stderr.trim() ? `: ${stderr.trim()}` : ''}`, code, id, outcome.value.cause);
      }
      try { return outputSchema.parse(JSON.parse(stdout)); }
      catch (cause) { throw failure('Helper returned no valid completion record; inspect its journal', 'outcome_unknown', id, cause); }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) {
        stop('SIGKILL');
        await exit.promise;
      }
    }
  }

  function helperCredentials() {
    const args: string[] = [];
    if (options.authFile) args.push('--auth-file', options.authFile);
    if (options.cloudflareEnv) args.push('--cloudflare-env', options.cloudflareEnv);
    if (options.accountId) args.push('--account-id', options.accountId);
    return args;
  }

  return {
    async create(input: CreateInput) {
      if (input.signal?.aborted) throw failure('Create was aborted before state was written', 'aborted');
      if (input.size !== undefined || input.from !== undefined || input.ports !== undefined || input.idleTimeoutMs !== undefined || (input.network !== undefined && input.network !== 'all')) throw failure('WorkSSH does not support resizing, snapshots, ports, idle expiry or restrictive network policy', 'unsupported');
      const timeoutMs = accessTimeout(input.timeoutMs ?? 600_000);
      const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).parse(input.env ?? {});
      const labels = z.record(z.string(), z.string()).parse(input.labels);
      if (input.key !== undefined) z.string().min(1).parse(input.key);
      await privateDirectory(root, true);
      const record: SandboxRecord = { version: 1, id: randomBytes(16).toString('hex'), key: input.key, labels, env, createdAt: Date.now(), timeoutMs, phase: 'creating' };
      await mkdir(directory(record.id), { mode: 0o700 });
      await save(record);
      const release = await acquire(record.id);
      try {
        const args = [...helperCredentials(), '--count', '1', '--agent-deadline', String(record.createdAt + timeoutMs), '--model', options.model ?? 'gpt-6-luna'];
        if (options.allowCredits === true) args.push('--allow-credits');
        const output = await invoke(record.id, 'up', args, input.signal);
        const saved = readySessionSchema.safeParse(await session(record.id));
        if (output.phase !== 'ready' || output.vms.length !== 1 || !output.vms[0]?.ready || output.vms[0].offline || !saved.success || Date.parse(saved.data.vms[0].agentDeadline) !== record.createdAt + timeoutMs) throw failure('Helper did not confirm one ready pinned VM with the requested access deadline', 'outcome_unknown', record.id);
        record.phase = 'ready';
        await save(record);
        return record;
      } catch (cause) {
        const current = await get(record.id);
        await save({ ...current, phase: 'failed' });
        if (cause instanceof SandboxError) throw cause;
        throw failure('Creation failed; retained its ID for inspection and destruction', 'outcome_unknown', record.id, cause);
      } finally { await release(); }
    },
    async resume(id, input) {
      const timeoutMs = accessTimeout(input.timeoutMs);
      if (input.signal?.aborted) throw failure('Resume was aborted before helper start', 'aborted', id);
      const release = await acquire(id);
      try {
        const record = await get(id);
        if (record.phase !== 'ready') throw failure(`Cannot resume a ${record.phase} session; inspect its retained state`, 'provider', id);
        const before = readySessionSchema.safeParse(await session(id));
        if (!before.success) throw failure('Session teardown or incomplete setup prevents access recovery', 'provider', id);
        const original = before.data.vms[0];
        await clearOwnedDeadLock(id, record);
        const requestedDeadline = Date.now() + timeoutMs;
        const args = [...helperCredentials(), '--agent-deadline', String(requestedDeadline)];
        if (options.allowCredits === true) args.push('--allow-credits');
        const output = await invoke(id, 'resume', args, input.signal);
        const saved = readySessionSchema.safeParse(await session(id));
        if (output.phase !== 'ready' || output.vms.length !== 1 || !output.vms[0]?.ready || output.vms[0].offline || !saved.success) throw failure('Recovery did not confirm one ready pinned VM; prior deadline retained', 'outcome_unknown', id);
        const vm = saved.data.vms[0];
        const deadline = Date.parse(vm.agentDeadline);
        if (vm.runtimeId !== original.runtimeId || vm.hostPublicKey.trim().split(/\s+/).slice(0, 2).join(' ') !== original.hostPublicKey.trim().split(/\s+/).slice(0, 2).join(' ')) throw failure('Recovery changed the runtime or host pin; prior deadline retained', 'outcome_unknown', id);
        if (deadline <= Date.now() || deadline > requestedDeadline) throw failure('Recovery did not confirm a bounded access deadline; prior deadline retained', 'outcome_unknown', id);
        // A live supervisor may be reused. Its confirmed deadline, not the request,
        // determines access; creation time, labels and environment stay unchanged.
        record.timeoutMs = deadline - record.createdAt;
        await save(record);
        return record;
      } finally { await release(); }
    },
    get,
    list,
    async find(key) {
      const matches = (await list()).filter((record) => record.key === key);
      if (matches.length > 1 || matches.some((record) => record.phase !== 'ready')) throw failure('Key has an uncertain or duplicate existing allocation; inspect before retrying', 'outcome_unknown', matches[0]?.id);
      return matches[0];
    },
    async access(id): Promise<SshAccess> {
      const record = await get(id);
      const saved = await session(id);
      const vm = saved.vms[0];
      if (record.phase !== 'ready' || saved.phase !== 'ready' || saved.closed || saved.vms.length !== 1 || !vm?.hostPublicKey || vm.offline) throw failure('Session is not ready for SSH access', 'not_found', id);
      const config = path.join(sessionDirectory(id), 'vm-1.json');
      vmConfigSchema.parse(JSON.parse(await privateText(config)));
      return { id, proxyCommand: [process.execPath, proxy, '--config', config], privateKey: Buffer.from(await privateText(path.join(sessionDirectory(id), 'client_key'))), hostPublicKey: vm.hostPublicKey, scratchDirectory: vm.scratch };
    },
    acquire,
    async destroy(id) {
      let record = await get(id);
      if (record.phase === 'deleted') return;
      const release = await acquire(id);
      try {
        record = await get(id);
        await clearOwnedDeadLock(id, record);
        let saved: z.infer<typeof sessionSchema>;
        try { saved = await session(id); }
        catch (cause) {
          if (!hasCode(cause, 'ENOENT')) throw cause;
          await save({ ...record, phase: 'deleted', env: {} });
          return;
        }
        if (!saved.closed) {
          await save({ ...record, phase: 'deleting' });
          await invoke(id, 'down', [...helperCredentials(), '--yes']);
          saved = await session(id);
        }
        if (!saved.closed || saved.phase !== 'deleted' || saved.relayToken || saved.vms.some((vm) => !vm.offline) || (saved.configId && !saved.configDeleted) || (saved.vaultId && !saved.vaultDeleted) || (saved.workerOwned && !saved.workerDeleted)) throw failure('Cloud resource deletion or runtime shutdown is not confirmed; state retained', 'outcome_unknown', id);
        await save({ ...record, phase: 'deleted', env: {} });
      } catch (cause) {
        if (cause instanceof SandboxError) throw cause;
        throw failure('Destroy did not confirm cloud cleanup; state retained for inspection', 'outcome_unknown', id, cause);
      } finally { await release(); }
    },
    sessionDirectory,
  };
}
