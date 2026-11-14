import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { GuestTransport } from './contracts.js';

const chunkBytes = 1024 * 1024;
const sourcePath = fileURLToPath(new URL('./host.py', import.meta.url));
const usageSchema = z.object({
  hostname: z.string(), architecture: z.string(),
  memoryCurrentBytes: z.number().nonnegative().nullable(), memoryLimitBytes: z.number().nonnegative().nullable(),
  cpuQuota: z.number().nonnegative().nullable(), cpuPeriod: z.number().positive().nullable(), cpuTime: z.record(z.string(), z.string()),
  filesystemUsedBytes: z.number().nonnegative(), filesystemAvailableBytes: z.number().nonnegative(), filesystemTotalBytes: z.number().nonnegative(),
  filesystemScope: z.string(),
}).strict();
export type GuestUsage = z.infer<typeof usageSchema>;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
let source: Promise<string> | undefined;

async function localArchive(operation: 'pack' | 'unpack', path: string, archive: string) {
  const child = spawn('python3', [sourcePath, operation, path], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8000); });
  const ended = Promise.withResolvers<{ code: number | null; cause?: Error }>();
  child.once('error', cause => ended.resolve({ code: null, cause }));
  child.once('close', code => ended.resolve({ code }));
  const transfer = operation === 'pack'
    ? pipeline(child.stdout, createWriteStream(archive, { mode: 0o600, flags: 'wx' }))
    : pipeline(createReadStream(archive), child.stdin);
  if (operation === 'pack') child.stdin.end();
  else child.stdout.resume();
  try {
    await Promise.all([transfer, ended.promise.then(outcome => {
      if (outcome.cause) throw outcome.cause;
      if (outcome.code !== 0) throw new Error(stderr.trim() || `Directory ${operation} failed`);
    })]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended.promise;
  }
}

export function hostOperations(guest: GuestTransport) {
  async function remote(args: string[]) {
    source ??= readFile(sourcePath, 'utf8');
    let stdout = '', stderr = '';
    const result = await guest.exec({
      command: `python3 -c ${quote(await source)} ${args.map(quote).join(' ')}`,
      cwd: '/', env: {}, timeoutMs: 60_000,
      onChunk(chunk) {
        if (chunk.stream === 'stdout') {
          stdout += chunk.text;
          if (stdout.length > 2 * chunkBytes) throw new Error('Archive control response exceeded its bound');
        } else stderr = (stderr + chunk.text).slice(-8000);
      },
    });
    if (result.exitCode !== 0 || result.timedOut) throw new Error(stderr.trim() || 'Guest host operation failed');
    return stdout;
  }
  return {
    async usage(): Promise<GuestUsage> { return usageSchema.parse(JSON.parse(await remote(['usage']))); },
    async uploadTree(input: string, destination: string) {
      const local = await mkdtemp(join(tmpdir(), 'workssh-upload-'));
      const stage = `${guest.scratchDirectory}/.workssh-transfer-${randomBytes(16).toString('hex')}`;
      let prepared = false;
      try {
        const archive = join(local, 'tree.tar');
        await localArchive('pack', resolve(input), archive);
        await remote(['prepare', stage]); prepared = true;
        let count = 0;
        for await (const bytes of createReadStream(archive, { highWaterMark: chunkBytes })) {
          await guest.files.write(`${stage}/${count++}`, bytes);
        }
        await remote(['unpack-chunks', destination, stage, String(count), String((await stat(archive)).size)]);
      } finally {
        try { if (prepared) await guest.files.remove(stage, { recursive: true }); }
        finally { await rm(local, { recursive: true, force: true }); }
      }
    },
    async downloadTree(input: string, destination: string) {
      const local = await mkdtemp(join(tmpdir(), 'workssh-download-'));
      const stage = `${guest.scratchDirectory}/.workssh-transfer-${randomBytes(16).toString('hex')}`;
      let prepared = false;
      try {
        await remote(['prepare', stage]); prepared = true;
        const remoteArchive = `${stage}/tree.tar`, archive = join(local, 'tree.tar');
        await remote(['pack-file', input, remoteArchive]);
        const metadata = await guest.files.stat(remoteArchive);
        if (metadata.type !== 'file' || !Number.isSafeInteger(metadata.size)) throw new Error('Invalid guest archive metadata');
        const file = await open(archive, 'wx', 0o600);
        try {
          for (let offset = 0; offset < metadata.size; offset += chunkBytes) {
            const encoded = await remote(['read-chunk', remoteArchive, String(offset)]);
            const bytes = Buffer.from(encoded.trim(), 'base64');
            if (bytes.length !== Math.min(chunkBytes, metadata.size - offset)) throw new Error('Guest archive transfer was incomplete');
            await file.writeFile(bytes);
          }
        } finally { await file.close(); }
        await localArchive('unpack', resolve(destination), archive);
      } finally {
        try { if (prepared) await guest.files.remove(stage, { recursive: true }); }
        finally { await rm(local, { recursive: true, force: true }); }
      }
    },
  };
}
