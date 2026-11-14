#!/usr/bin/env node
import { access, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createSandbox } from '@opencoredev/sandbox-sdk';
import { workssh } from './index.js';
import { createLifecycle } from './lifecycle.js';
import { worksshOptionsSchema } from './contracts.js';
import { hostOperations } from './host.js';
import { jobOperations, retainedStatus, retainedLogs } from './jobs.js';
import type { Labels } from '@opencoredev/sandbox-sdk/provider';
import type { SandboxRecord, Lifecycle, WorksshOptions } from './contracts.js';
import type { WorksshProvider } from './index.js';
import type { GuestUsage } from './host.js';
import type { JobStatus } from './jobs.js';

const commands = ['new', 'resume', 'list', 'info', 'exec', 'ssh', 'upload', 'download', 'logs', 'status', 'cancel', 'usage', 'capacity', 'doctor', 'gc', 'destroy'] as const;
const actionSchema = z.enum(commands);
const requestSchema = z.object({
  protocol: z.literal(1), location: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  options: z.record(z.string(), z.json()), args: z.record(z.string(), z.json()),
});
const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const argument = z.string().refine((value) => !value.includes('\0'), 'NUL is not permitted');
const pathSchema = argument.refine((value) => value.startsWith('/') && !value.endsWith('/') && !value.split('/').includes('..'), 'Expected an absolute POSIX path without ..');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const terminalStates = { completed: true, cancelled: true, interrupted: true, failed: true } satisfies Partial<Record<JobStatus['state'], true>>;
type Request = z.infer<typeof requestSchema>;
type Action = z.infer<typeof actionSchema>;

function validate(action: Action, request: Request) {
  const { args, location } = request;
  if (args.action !== action || args.location !== location) throw new Error('Action or location mismatch');
  const allowed = {
    new: ['ttl', 'disposable', 'purpose', 'owner', 'next'], resume: ['ttl'], list: [], info: [], destroy: [],
    exec: ['command', 'detach'], ssh: [], usage: [], capacity: ['json'], doctor: [], gc: [],
    logs: ['job'], status: ['job'], cancel: ['job'],
    upload: ['source', 'destination', 'recursive'], download: ['source', 'destination', 'recursive'],
  }[action];
  for (const [key, value] of Object.entries(args)) {
    if (!['action', 'location', 'box', 'json_output', ...allowed].includes(key) && value !== null && value !== false) throw new Error(`Unsupported argument: ${key}`);
  }
  if (action === 'new' && args.disposable !== true) throw new Error('new requires --disposable; VM pause and persistent stop are not supported');
  if (action === 'ssh' && args.json_output) throw new Error('Interactive SSH does not support global JSON output');
}

function nativeId(handle: Request['args']['box'] | undefined, location: string) {
  const value = z.string().parse(handle);
  if (!value.startsWith(`${location}:`)) throw new Error('Box belongs to a different Raft location');
  return idSchema.parse(value.slice(location.length + 1));
}
function owns(record: Pick<SandboxRecord, 'labels'>, labels: Labels) {
  return Object.entries(labels).every(([key, value]) => record.labels[key] === value);
}
function note(labels: Labels) {
  const purpose = labels['raft.purpose'], owner = labels['raft.owner'], next = labels['raft.next'];
  return purpose === undefined && owner === undefined && next === undefined ? null : { purpose, owner, next };
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Operation failed'; }
function json<T>(value: T) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function atomicDownload(destination: string, bytes: Uint8Array) {
  const target = resolve(destination);
  const staging = await mkdtemp(join(dirname(target), '.workssh-download-'));
  try {
    const file = join(staging, 'file');
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await rename(file, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function stdin(signal: AbortSignal) {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => process.stdin.destroy(new Error('Interrupted while reading stdin', { cause: signal.reason }));
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    for await (const chunk of process.stdin) {
      const bytes = z.instanceof(Buffer).parse(chunk);
      size += bytes.length;
      if (size > 16 * 1024 * 1024) throw new Error('Raft exec text stdin exceeds 16 MiB');
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { signal.removeEventListener('abort', abort); }
}

interface ProbeResult {
  health: { status: 'reachable' | 'unknown' | 'unavailable'; checkedAt: string; reason?: string };
  resources: GuestUsage | null;
}
interface Environment {
  options: WorksshOptions;
  provider: WorksshProvider;
  lifecycle: Lifecycle;
  expected: Labels;
  qualified(id: string): string;
  jobsDirectory(id: string): string;
  records(): Promise<SandboxRecord[]>;
  record(): Promise<SandboxRecord>;
  probe(record: SandboxRecord): Promise<ProbeResult>;
}

function environment(request: Request): Environment {
  const options = worksshOptionsSchema.parse(request.options);
  const provider = workssh(options);
  const lifecycle = createLifecycle(options);
  const expected: Labels = { 'sandbox-sdk': '1', 'raft.location': request.location };
  const qualified = (id: string) => `${request.location}:${idSchema.parse(id)}`;
  const jobsDirectory = (id: string) => join(options.stateDirectory, id, 'jobs');
  async function records() { return (await lifecycle.list()).filter((candidate) => owns(candidate, expected)); }
  async function record() {
    const id = nativeId(request.args.box, request.location);
    const found = await lifecycle.get(id);
    if (!owns(found, expected)) throw new Error('Sandbox belongs to another Raft location');
    return found;
  }
  async function probe(saved: SandboxRecord): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    if (saved.phase !== 'ready' || Date.now() >= saved.createdAt + saved.timeoutMs) {
      return { health: { status: 'unavailable', checkedAt, reason: saved.phase === 'ready' ? 'SSH access expired; use raft resume BOX --ttl SECONDS. VM shutdown is not confirmed' : saved.phase }, resources: null };
    }
    try {
      const resources = await hostOperations(await provider.guest(saved.id)).usage();
      return { health: { status: 'reachable', checkedAt }, resources };
    } catch (cause) {
      return { health: { status: 'unknown', checkedAt, reason: message(cause) }, resources: null };
    } finally { await provider.close(saved.id); }
  }
  return { options, provider, lifecycle, expected, qualified, jobsDirectory, records, record, probe };
}

async function report(action: Action, context: Environment, location: string) {
  const records = await context.records();
  if (action === 'capacity') {
    json({ location, provider: 'workssh', notice: 'No configured local VM-count limit; provider capacity and account quota are unknown.',
      localLimit: null, providerLimit: null, available: null, host: null, boxes: records.length,
      activeBoxes: null, allocated: null, reserve: null, headroom: null, estimates: [],
      warnings: ['No allocation or quota guarantee. Per-VM resources are measured by info or usage.'] });
    return 0;
  }
  if (action === 'gc') {
    let failed = false;
    for (const record of records) {
      if (Date.now() < record.createdAt + record.timeoutMs) continue;
      try { await context.provider.destroy(record.id); json({ box: context.qualified(record.id), destroyed: true }); }
      catch (cause) { failed = true; process.stderr.write(`${context.qualified(record.id)}: ${message(cause)}\n`); }
    }
    return failed ? 1 : 0;
  }
  if (action === 'doctor') {
    // Inspect paths, not credential contents; health probes never allocate a VM.
    await access(join(context.options.helperRoot, 'tunnel/src/codex-cloud.mjs'));
    await access(join(context.options.helperRoot, 'tunnel/src/proxy.mjs'));
  }
  let unhealthy = false;
  for (const record of records) {
    const observed = await context.probe(record);
    if (observed.health.status !== 'reachable') unhealthy = true;
    if (action === 'list') {
      json({ box: context.qualified(record.id), state: observed.health.status === 'reachable' ? 'Running' : 'Unknown',
        stopAt: '', deleteAt: '', disk: null, note: note(record.labels), phase: record.phase, ...observed });
    } else json({ box: context.qualified(record.id), ...observed });
  }
  if (action === 'doctor' && records.length === 0) json({ location, status: 'configured', boxes: 0, notice: 'Helper found. No live VM was available to probe; account credentials and allowance were not tested.' });
  return action === 'doctor' && unhealthy ? 1 : 0;
}

async function job(action: Action, context: Environment, record: SandboxRecord, value: Request['args']['job'] | undefined) {
  const id = z.string().regex(/^rfcmd-[a-f0-9]{32}$/).parse(value);
  const directory = context.jobsDirectory(record.id), box = context.qualified(record.id);
  const cached = await retainedStatus(directory, box, id);
  if (Object.hasOwn(terminalStates, cached.state)) {
    if (action === 'logs') process.stdout.write(await retainedLogs(directory, box, id));
    else json(cached);
    return 0;
  }
  if (record.phase === 'deleted') throw new Error('VM was deleted without a terminal job record; retained outcome is unknown');
  const jobs = jobOperations(await context.provider.guest(record.id), record, directory, box);
  if (action === 'logs') process.stdout.write(await jobs.logs(id));
  else json(action === 'cancel' ? await jobs.cancel(id) : await jobs.status(id));
  return 0;
}

async function operate(action: Action, request: Request, context: Environment, signal: AbortSignal) {
  const { args } = request;
  const record = await context.record();
  try {
    if (['logs', 'status', 'cancel'].includes(action)) return await job(action, context, record, args.job);
    if (action === 'destroy') { await context.provider.destroy(record.id); return 0; }
    if (record.phase === 'deleted') throw new Error('Sandbox has been deleted');
    if (action === 'info') {
      json({ box: context.qualified(record.id), id: record.id, provider: 'workssh', phase: record.phase, labels: record.labels,
        createdAt: record.createdAt, agentExpiresAt: record.createdAt + record.timeoutMs, commands: [...commands], ...await context.probe(record) });
      return 0;
    }
    if (signal.aborted) throw signal.reason;
    if (action === 'resume') {
      const ttl = z.number().int().min(60).max(2_592_000).parse(args.ttl);
      await context.provider.reconnect(record.id, { timeoutMs: ttl * 1000, signal });
      const resumed = await context.lifecycle.get(record.id);
      json({ box: context.qualified(record.id), agentExpiresAt: resumed.createdAt + resumed.timeoutMs, vmRestarted: false });
      return 0;
    }
    const guest = await context.provider.guest(record.id);
    const host = hostOperations(guest);
    if (action === 'usage') { json({ box: context.qualified(record.id), ...await host.usage() }); return 0; }
    if (action === 'ssh') {
      const raw = process.stdin.isTTY && !process.stdin.isRaw;
      if (raw) process.stdin.setRawMode(true);
      try { return await guest.shell({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal, term: process.env.TERM }); }
      finally { if (raw) process.stdin.setRawMode(false); process.stdin.pause(); }
    }
    if (action === 'exec') {
      const argv = z.array(argument).nonempty().parse(args.command);
      if (args.detach) {
        const id = await jobOperations(guest, record, context.jobsDirectory(record.id), context.qualified(record.id)).start(argv, context.options.operationTimeoutMs ?? 600_000);
        process.stdout.write(`${id}\n`);
        return 0;
      }
      const input = await stdin(signal);
      const result = await context.provider.exec(record.id, { command: argv.map(quote).join(' '), cwd: '/workspace', env: {}, stdin: input,
        timeoutMs: context.options.operationTimeoutMs ?? 600_000, signal, streaming: true,
        onChunk(chunk) { process[chunk.stream].write(chunk.text); } });
      return result.timedOut ? 124 : result.exitCode ?? 137;
    }
    const source = argument.parse(args.source), destination = argument.parse(args.destination);
    if (args.recursive) {
      if (action === 'upload') await host.uploadTree(source, pathSchema.parse(destination));
      else await host.downloadTree(pathSchema.parse(source), destination);
    } else if (action === 'upload') {
      const file = await open(source, 'r');
      try {
        if (!(await file.stat()).isFile()) throw new Error('Upload source must be a regular file');
        await guest.files.write(pathSchema.parse(destination), await file.readFile());
      } finally { await file.close(); }
    } else {
      if ((await guest.files.stat(pathSchema.parse(source))).type !== 'file') throw new Error('Download source must be a regular file, not a directory or symlink');
      const bytes = await guest.files.read(source);
      if (signal.aborted) throw signal.reason;
      await atomicDownload(destination, bytes);
    }
    return 0;
  } finally { await context.provider.close(record.id); }
}

async function dispatch(action: Action, request: Request, signal: AbortSignal) {
  const context = environment(request);
  if (['capacity', 'doctor', 'gc', 'list'].includes(action)) return report(action, context, request.location);
  if (action === 'new') {
    const labels = { ...context.expected };
    for (const key of ['purpose', 'owner', 'next']) {
      const value = request.args[key];
      if (value !== null && value !== undefined) labels[`raft.${key}`] = z.string().parse(value);
    }
    const ttl = z.number().int().min(60).max(2_592_000).parse(request.args.ttl ?? 600);
    const box = await createSandbox(context.provider, { labels, timeoutMs: ttl * 1000, signal });
    await box.close();
    process.stdout.write(`${context.qualified(box.id)}\n`);
    return 0;
  }
  return operate(action, request, context, signal);
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('WorkSSH Raft protocol 1 plugin. Register: raft plugin add openai -- node /absolute/path/to/dist/raft.js\nHost operations: SSH, exec/detached jobs, transfers, health, usage, capacity and explicit expired-session gc. See README.md.\n');
    return 0;
  }
  const request = requestSchema.parse(JSON.parse(process.env.RAFT_PLUGIN_REQUEST ?? 'null'));
  if (process.argv.at(-1) === 'describe') { json({ protocol: 1, commands: [...commands] }); return 0; }
  const action = actionSchema.parse(process.argv.at(-1));
  validate(action, request);
  const controller = new AbortController();
  let cancelled: number | undefined;
  const cancel = (code: number) => {
    if (cancelled !== undefined) return;
    cancelled = code;
    process.stderr.write('Operation cancelled; inspect retained state before retrying an uncertain mutation.\n');
    controller.abort(new Error('Raft operation cancelled'));
    setTimeout(() => process.exit(code), 5000).unref();
  };
  const interrupt = () => cancel(130), terminate = () => cancel(143);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const timeout = z.number().int().positive().max(2_147_483_647).parse(request.options.operationTimeoutMs ?? 600_000);
  const deadline = action === 'ssh' ? undefined : setTimeout(() => cancel(124), timeout);
  try { return await dispatch(action, request, controller.signal); }
  finally {
    clearTimeout(deadline); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    if (cancelled !== undefined) process.exitCode = cancelled;
  }
}

try {
  const code = await main();
  process.exitCode ??= code;
  await Promise.all([process.stdout, process.stderr].map((stream) => {
    const flushed = Promise.withResolvers<void>();
    stream.write('', (cause) => cause ? flushed.reject(cause) : flushed.resolve());
    return flushed.promise;
  }));
} catch (cause) {
  process.stderr.write(`workssh-raft: ${cause instanceof z.ZodError ? 'Invalid plugin request or unsupported option value' : message(cause)}\n`);
  process.exitCode ??= 1;
}
