import { SandboxError } from '@opencoredev/sandbox-sdk';
import type { Labels, Provider, SandboxInfo } from '@opencoredev/sandbox-sdk/provider';
import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { jobOperations, interruptRetained } from './jobs.js';
import { createLifecycle } from './lifecycle.js';
import { createTransport } from './ssh.js';
import { cloudsshOptionsSchema } from './contracts.js';
import type { GuestTransport, KeepAliveStatus, ReconnectInput, SandboxRecord, CloudsshNative, CloudsshOptions } from './contracts.js';

export type { CloudsshOptions, CloudsshNative, ReconnectInput, KeepAliveStatus } from './contracts.js';

export type CloudsshProvider = Provider<CloudsshNative, never> & {
  guest(id: string): Promise<GuestTransport>;
  close(id: string): Promise<void>;
  reconnect(id: string, input: ReconnectInput): Promise<SandboxInfo>;
  keepAlive(id: string, enabled?: boolean): Promise<KeepAliveStatus>;
};

const name = 'cloudssh';

function failure(message: string, code: 'not_found' | 'unsupported' | 'outcome_unknown' | 'provider', id?: string) {
  return new SandboxError(message, { code, provider: name, sandboxId: id });
}

function usable(record: SandboxRecord) {
  if (record.phase !== 'ready') {
    throw failure(`Session is ${record.phase}; inspect or destroy it before retrying creation`, 'outcome_unknown', record.id);
  }
  if (Date.now() >= record.createdAt + record.timeoutMs) {
    throw failure('SSH access expired, not a missing VM. Reconnect explicitly with provider.reconnect(id, { timeoutMs }) or raft resume BOX --ttl SECONDS; no replacement is allocated', 'provider', record.id);
  }
}

/** One provider owns a private controller registry and lazily attached SSH transports. */
export function cloudssh(options: CloudsshOptions): CloudsshProvider {
  let settings: CloudsshOptions;
  try {
    settings = cloudsshOptionsSchema.parse(options);
  } catch (cause) {
    if (!(cause instanceof z.ZodError)) throw cause;
    throw new SandboxError('Invalid CloudSSH options. Use absolute helperRoot and stateDirectory paths and only documented options', {
      code: 'invalid_argument', provider: name,
    });
  }
  const lifecycle = createLifecycle(settings);
  const records = new Map<string, SandboxRecord>();
  const connections = new Map<string, Promise<{ guest: GuestTransport; release: () => Promise<void> }>>();

  function remember(record: SandboxRecord): SandboxInfo {
    records.set(record.id, record);
    return {
      id: record.id,
      key: record.key,
      labels: { ...record.labels },
      createdAt: record.createdAt,
      state: record.phase === 'ready' && Date.now() < record.createdAt + record.timeoutMs ? 'running' : 'stopped',
    };
  }

  async function open(id: string) {
    const release = await lifecycle.acquire(id);
    try {
      const access = await lifecycle.access(id);
      return { guest: createTransport(access), release };
    } catch (cause) {
      await release();
      throw cause;
    }
  }

  async function guest(id: string) {
    const record = await lifecycle.get(id);
    usable(record);
    records.set(id, record);
    let pending = connections.get(id);
    if (!pending) {
      pending = open(id);
      connections.set(id, pending);
      const current = pending;
      void pending.catch(() => {
        if (connections.get(id) === current) connections.delete(id);
      });
    }
    return (await pending).guest;
  }

  async function close(id: string) {
    const pending = connections.get(id);
    if (!pending) return;
    connections.delete(id);
    const attached = await pending;
    try {
      await attached.guest.close();
    } finally {
      await attached.release();
    }
  }
  async function collectJobs(id: string) {
    const directory = join(settings.stateDirectory, id, 'jobs');
    let names: string[];
    try { names = await readdir(directory); }
    catch (cause) {
      if (z.object({ code: z.literal('ENOENT') }).safeParse(cause).success) return;
      throw cause;
    }
    if (names.length === 0) return;
    const record = await lifecycle.get(id);
    const location = z.string().parse(record.labels['raft.location']);
    await jobOperations(await guest(id), record, directory, `${location}:${id}`).finish();
  }


  return {
    name,
    keyMode: 'best-effort',
    capabilities: new Set<never>(),
    // Each command is an isolated process group. Persistent background jobs are not advertised.
    processMode: 'unsupported',
    commandShell: 'bash',
    async create(input) {
      const record = await lifecycle.create(input);
      return remember(record);
    },
    async reconnect(id, input) {
      await close(id);
      return remember(await lifecycle.resume(id, input));
    },
    keepAlive: lifecycle.keepAlive,
    async find(key) {
      const record = await lifecycle.find(key);
      if (!record) return undefined;
      usable(record);
      return remember(record);
    },
    async connect(id) {
      const record = await lifecycle.get(id);
      if (record.phase === 'deleted') throw failure('Sandbox has been deleted', 'not_found', id);
      return remember(record);
    },
    async list(labels: Labels) {
      const found: SandboxInfo[] = [];
      for (const record of await lifecycle.list()) {
        if (Object.entries(labels).every(([key, value]) => record.labels[key] === value)) found.push(remember(record));
      }
      return found;
    },
    async destroy(id) {
      const record = await lifecycle.get(id);
      let collectionError: unknown;
      if (record.phase !== 'deleted') {
        try { await collectJobs(id); }
        catch (cause) { collectionError = cause; }
      }
      try {
        await close(id);
      } finally {
        // Confirm cloud revocation even if SSH or pre-deletion log collection failed.
        await lifecycle.destroy(id);
        if (record.labels['raft.location']) {
          await interruptRetained(join(settings.stateDirectory, id, 'jobs'), `${record.labels['raft.location']}:${id}`);
        }
        records.delete(id);
      }
      if (collectionError) throw new SandboxError('Cloud resources were deleted, but detached-job output collection failed', {
        code: 'provider', provider: name, sandboxId: id,
        cause: collectionError instanceof Error ? collectionError.message : undefined,
      });
    },
    async exec(id, input) {
      if (input.signal?.aborted) return { exitCode: null, timedOut: false };
      const transport = await guest(id);
      const record = records.get(id);
      if (!record) throw failure('Missing session metadata', 'not_found', id);
      return transport.exec({ ...input, env: { ...record.env, ...input.env } });
    },
    files: {
      transfer: 'files',
      writeSupportsMode: true,
      async read(id, path) { return (await guest(id)).files.read(path); },
      async write(id, path, bytes, writeOptions) { await (await guest(id)).files.write(path, bytes, writeOptions); },
      async list(id, path) { return (await guest(id)).files.list(path); },
      async stat(id, path) { return (await guest(id)).files.stat(path); },
      async remove(id, path, removeOptions) { await (await guest(id)).files.remove(path, removeOptions); },
      async mkdir(id, path) { await (await guest(id)).files.mkdir(path); },
    },
    async previewUrl(id) {
      throw failure('CloudSSH does not expose authenticated HTTP previews or SSH forwarding', 'unsupported', id);
    },
    native(id) {
      const record = records.get(id);
      if (!record) throw failure('Connect the sandbox before requesting native metadata', 'not_found', id);
      return { id, sessionDirectory: lifecycle.sessionDirectory(id), phase: record.phase };
    },
    guest,
    close,
  };
}

export default cloudssh;
