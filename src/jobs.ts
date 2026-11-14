import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { GuestTransport, SandboxRecord } from './contracts.js';

const jobId = z.string().regex(/^rfcmd-[a-f0-9]{32}$/);
const boxId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*:[a-f0-9]{32}$/);
const statusSchema = z.object({
  job: jobId, box: boxId, state: z.enum(['starting', 'running', 'completed', 'cancelled', 'interrupted', 'failed']),
  exitCode: z.number().int().min(0).max(255).nullable(), startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(), droppedBytes: z.number().int().nonnegative(), error: z.string().optional(),
}).strict();
export type JobStatus = z.infer<typeof statusSchema>;
const entrySchema = statusSchema.extend({ deadline: z.number().finite() }).strict();
type Entry = z.infer<typeof entrySchema>;
function publicStatus(entry: Entry): JobStatus {
  const { deadline: _deadline, ...status } = entry;
  return status;
}
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({ ok: z.literal(true), status: statusSchema, output: z.string() }),
]);
const errorCode = z.object({ code: z.string() }).passthrough();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const maxOutput = 1024 * 1024;
const retentionSeconds = 7 * 86400;
let source: Promise<string> | undefined;

function missing(cause: unknown) {
  const result = errorCode.safeParse(cause);
  return result.success && result.data.code === 'ENOENT';
}
async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) throw new Error('Jobs directory must be private and owned');
}
async function privateFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) throw new Error('Job file must be private and owned');
}
async function atomicFile(file: string, content: string | Uint8Array) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function load(directory: string, box: string, job: string): Promise<Entry> {
  jobId.parse(job); boxId.parse(box);
  await privateDirectory(directory);
  const file = join(directory, `${job}.json`);
  await privateFile(file);
  const entry = entrySchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (entry.job !== job || entry.box !== box) throw new Error('Job identity mismatch');
  if (entry.finishedAt !== null && Date.now() / 1000 - entry.finishedAt >= retentionSeconds) {
    await rm(file); await rm(join(directory, `${job}.log`), { force: true });
    throw new Error('Retained job result expired after seven days');
  }
  return entry;
}
async function save(directory: string, entry: Entry) { await atomicFile(join(directory, `${entry.job}.json`), JSON.stringify(entry)); }
async function entries(directory: string, box: string) {
  let files: string[];
  try { await privateDirectory(directory); files = await readdir(directory); }
  catch (cause) { if (missing(cause)) return []; throw cause; }
  const found: Entry[] = [];
  for (const file of files) {
    if (!file.endsWith('.json') || !jobId.safeParse(file.slice(0, -5)).success) continue;
    const path = join(directory, file);
    await privateFile(path);
    const entry = entrySchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (entry.box !== box || entry.job !== file.slice(0, -5)) throw new Error('Job identity mismatch');
    if (entry.finishedAt !== null && Date.now() / 1000 - entry.finishedAt >= retentionSeconds) {
      await rm(path); await rm(join(directory, `${entry.job}.log`), { force: true });
    } else found.push(entry);
  }
  return found;
}
interface JobRequest {
  op: 'start' | 'status' | 'cancel'; job: string; box: string; scratch: string;
  argv?: string[]; env?: Record<string, string>; deadline?: number;
}
async function invoke(guest: GuestTransport, payload: JobRequest) {
  source ??= readFile(new URL('./jobs.py', import.meta.url), 'utf8');
  let stdout = '';
  const result = await guest.exec({
    command: `python3 -c ${quote(await source)}`, cwd: '/workspace', env: {}, stdin: JSON.stringify(payload), timeoutMs: 10_000,
    onChunk(chunk) {
      if (chunk.stream === 'stdout') {
        stdout += chunk.text;
        if (stdout.length > 2 * maxOutput) throw new Error('Guest job response exceeded its bound');
      }
    },
  });
  const reply = responseSchema.parse(JSON.parse(stdout));
  if (!reply.ok) throw new Error(`Guest job operation failed: ${reply.error}`);
  if (result.exitCode !== 0 || result.timedOut) throw new Error('Guest job outcome could not be confirmed');
  if (reply.status.job !== payload.job || reply.status.box !== payload.box) throw new Error('Guest job identity mismatch');
  const bytes = Buffer.from(reply.output, 'base64');
  if (bytes.length > maxOutput) throw new Error('Guest job log exceeded its retention bound');
  return { status: reply.status, bytes };
}

export function jobOperations(guest: GuestTransport, record: SandboxRecord, directory: string, box: string) {
  boxId.parse(box);
  if (box.slice(box.indexOf(':') + 1) !== record.id) throw new Error('Job box differs from sandbox identity');
  async function collect(job: string, operation: 'status' | 'cancel' = 'status'): Promise<Entry> {
    const previous = await load(directory, box, job);
    if (previous.finishedAt !== null) return previous;
    const reply = await invoke(guest, { op: operation, job, box, scratch: guest.scratchDirectory });
    const entry = { ...reply.status, deadline: previous.deadline };
    // Publish the captured prefix before a terminal result so retained readers
    // cannot see confirmed completion with an uncommitted final log.
    await atomicFile(join(directory, `${job}.log`), reply.bytes);
    await save(directory, entry);
    return entry;
  }
  async function cancel(job: string): Promise<JobStatus> { return publicStatus(await collect(job, 'cancel')); }
  async function logs(job: string) {
    await collect(job);
    return retainedLogs(directory, box, job);
  }
  return {
    async start(argv: string[], timeoutMs: number) {
      z.array(z.string().refine(value => !value.includes('\0'))).nonempty().parse(argv);
      z.number().int().positive().parse(timeoutMs);
      const deadline = Math.min(Date.now() + timeoutMs, record.createdAt + record.timeoutMs);
      if (deadline <= Date.now()) throw new Error('Sandbox agent lifetime has elapsed');
      await privateDirectory(directory, true);
      if ((await entries(directory, box)).length >= 512) throw new Error('Job store is full; terminal records expire after seven days');
      const job = `rfcmd-${randomBytes(16).toString('hex')}`;
      const entry: Entry = { job, box, state: 'starting', exitCode: null, startedAt: null, finishedAt: null, droppedBytes: 0, deadline };
      await atomicFile(join(directory, `${job}.log`), new Uint8Array());
      await save(directory, entry);
      const reply = await invoke(guest, { op: 'start', job, box, scratch: guest.scratchDirectory, argv, env: record.env, deadline: deadline / 1000 });
      await atomicFile(join(directory, `${job}.log`), reply.bytes);
      await save(directory, { ...reply.status, deadline });
      return job;
    },
    async status(job: string): Promise<JobStatus> { return publicStatus(await collect(job)); },
    logs, cancel,
    async finish() {
      for (const entry of await entries(directory, box)) {
        if (entry.finishedAt === null) await cancel(entry.job);
        await logs(entry.job);
      }
    },
  };
}

export async function retainedStatus(directory: string, box: string, job: string): Promise<JobStatus> {
  const entry = await load(directory, box, job);
  return publicStatus(entry);
}
export async function retainedLogs(directory: string, box: string, job: string): Promise<Uint8Array> {
  await load(directory, box, job);
  const file = join(directory, `${job}.log`);
  await privateFile(file);
  const bytes = await readFile(file);
  if (bytes.length > maxOutput) throw new Error('Retained log exceeded its bound');
  return bytes;
}
export async function interruptRetained(directory: string, box: string) {
  for (const entry of await entries(directory, box)) {
    if (entry.finishedAt === null) await save(directory, { ...entry, state: 'interrupted', exitCode: null, finishedAt: Math.floor(Date.now() / 1000), error: 'VM was destroyed before a final command result was collected' });
  }
}
