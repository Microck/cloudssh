#!/usr/bin/env node
import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createSandbox, connectSandbox } from '@opencoredev/sandbox-sdk';
import { workssh } from './index.js';
import { worksshOptionsSchema } from './contracts.js';
import type { Labels, SandboxInfo } from '@opencoredev/sandbox-sdk/provider';

const commands = ['new', 'list', 'info', 'exec', 'upload', 'download', 'destroy'] as const;
const actionSchema = z.enum(commands);
const requestSchema = z.object({
  protocol: z.literal(1),
  location: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  options: z.record(z.string(), z.json()),
  args: z.record(z.string(), z.json()),
});
const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const argument = z.string().refine((value) => !value.includes('\0'), 'NUL is not permitted');
const pathSchema = argument.refine((value) => value.startsWith('/') && !value.endsWith('/') && !value.split('/').includes('..'), 'Expected an absolute POSIX file path without ..');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type Request = z.infer<typeof requestSchema>;
type Action = z.infer<typeof actionSchema>;

function validate(action: Action, request: Request) {
  const { args, location } = request;
  if (args.action !== action || args.location !== location) throw new Error('Action or location mismatch');
  const allowed = {
    new: ['ttl', 'disposable', 'purpose', 'owner', 'next'],
    list: [], info: [], destroy: [],
    exec: ['command', 'detach'],
    upload: ['source', 'destination', 'recursive'],
    download: ['source', 'destination', 'recursive'],
  }[action];
  for (const [key, value] of Object.entries(args)) {
    if (!['action', 'location', 'box', 'json_output', ...allowed].includes(key) && value !== null && value !== false) {
      throw new Error(`Unsupported argument: ${key}`);
    }
  }
  if (action === 'new' && args.disposable !== true) throw new Error('new requires --disposable; persistent stop is not supported');
  if (action === 'exec' && args.detach) throw new Error('Detached exec is not supported');
  if ((action === 'upload' || action === 'download') && args.recursive) throw new Error('Recursive Raft transfers are not supported');
}

function nativeId(handle: Request['args']['box'] | undefined, location: string) {
  const value = z.string().parse(handle);
  if (!value.startsWith(`${location}:`)) throw new Error('Box belongs to a different Raft location');
  return idSchema.parse(value.slice(location.length + 1));
}


function owns(box: Pick<SandboxInfo, 'labels'>, expected: Labels) {
  return Object.entries(expected).every(([key, value]) => box.labels[key] === value);
}

function note(values: Labels) {
  const purpose = values['raft.purpose'];
  const owner = values['raft.owner'];
  const next = values['raft.next'];
  return purpose === undefined && owner === undefined && next === undefined ? null : { purpose, owner, next };
}

async function atomicDownload(destination: string, bytes: Uint8Array) {
  const target = resolve(destination);
  const staging = await mkdtemp(join(dirname(target), '.workssh-download-'));
  try {
    const file = join(staging, 'file');
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await rename(file, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** SDK stdin is text and closed before execution, not an interactive terminal stream. */
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
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function dispatch(action: Action, request: Request, signal: AbortSignal) {
  const { args, location } = request;
  const options = worksshOptionsSchema.parse(request.options);
  const provider = workssh(options);
  const expected: Labels = { 'sandbox-sdk': '1', 'raft.location': location };
  const qualified = (id: string) => `${location}:${idSchema.parse(id)}`;
  if (action === 'list') {
    for (const box of await provider.list(expected)) {
      if (owns(box, expected)) process.stdout.write(`${JSON.stringify({ box: qualified(box.id), state: box.state, stopAt: '', deleteAt: '', disk: null, note: note(box.labels) })}\n`);
    }
    return 0;
  }

  let box;
  let download: { destination: string; bytes: Uint8Array } | undefined;
  let code = 0;
  try {
    if (action === 'new') {
      const ttl = z.number().int().min(60).max(7200).parse(args.ttl ?? 600);
      for (const key of ['purpose', 'owner', 'next']) {
        const value = args[key];
        if (value !== null && value !== undefined) expected[`raft.${key}`] = z.string().parse(value);
      }
      box = await createSandbox(provider, { labels: expected, timeoutMs: ttl * 1000, signal });
      await box.close();
      process.stdout.write(`${qualified(box.id)}\n`);
      return 0;
    }
    const id = nativeId(args.box, location);
    // Ownership precedes connect: a provider must not activate a foreign sandbox as a side effect.
    const candidates = await provider.list(expected);
    if (!candidates.some((candidate) => candidate.id === id && owns(candidate, expected))) throw new Error('Sandbox is absent or belongs to another Raft location');
    box = await connectSandbox(provider, id, { recoverSecrets: false });
    if (!owns(box, expected)) throw new Error('Sandbox ownership changed');
    if (signal.aborted) throw signal.reason;
    switch (action) {
      case 'info':
        process.stdout.write(`${JSON.stringify({ box: qualified(id), id, provider: box.provider, labels: box.labels, capabilities: [...box.capabilities], native: box.native })}\n`);
        break;
      case 'destroy':
        await box.destroy();
        break;
      case 'exec': {
        const command = z.array(argument).nonempty().parse(args.command).map(quote).join(' ');
        const input = await stdin(signal);
        const result = await provider.exec(id, {
          command, cwd: '/workspace', env: {}, stdin: input,
          timeoutMs: options.operationTimeoutMs ?? 600_000, signal, streaming: true,
          onChunk(chunk) { process[chunk.stream].write(chunk.text); },
        });
        code = result.timedOut ? 124 : result.exitCode ?? 137;
        break;
      }
      case 'upload': {
        const source = await open(argument.parse(args.source), 'r');
        try {
          if (!(await source.stat()).isFile()) throw new Error('Upload source must be a regular file');
          await box.files.write(pathSchema.parse(args.destination), await source.readFile());
        } finally {
          await source.close();
        }
        break;
      }
      case 'download': {
        const source = pathSchema.parse(args.source);
        if ((await box.files.stat(source)).type !== 'file') throw new Error('Download source must be a regular file, not a directory or symlink');
        download = { destination: argument.parse(args.destination), bytes: await box.files.read(source, { as: 'bytes' }) };
        break;
      }
    }
  } finally {
    await box?.close();
  }
  if (signal.aborted) throw signal.reason;
  if (download) await atomicDownload(download.destination, download.bytes);
  return code;
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('WorkSSH Raft protocol 1 plugin. Register with: raft plugin add work -- node /absolute/path/to/dist/raft.js\nSee README.md for options and lifecycle limits.\n');
    return 0;
  }
  const request = requestSchema.parse(JSON.parse(process.env.RAFT_PLUGIN_REQUEST ?? 'null'));
  if (process.argv.at(-1) === 'describe') {
    process.stdout.write(`${JSON.stringify({ protocol: 1, commands })}\n`);
    return 0;
  }
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
  const interrupt = () => cancel(130);
  const terminate = () => cancel(143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const timeout = z.number().int().positive().max(2_147_483_647).parse(request.options.operationTimeoutMs ?? 600_000);
  const deadline = setTimeout(() => cancel(124), timeout);
  try {
    return await dispatch(action, request, controller.signal);
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (cancelled !== undefined) process.exitCode = cancelled;
  }
}

try {
  const code = await main();
  process.exitCode ??= code;
  await Promise.all([process.stdout, process.stderr].map((stream) => {
    const flushed = Promise.withResolvers<void>();
    stream.write('', (error) => {
      if (error) flushed.reject(error);
      else flushed.resolve();
    });
    return flushed.promise;
  }));
} catch (cause) {
  const message = cause instanceof z.ZodError ? 'Invalid plugin request or unsupported option value' : cause instanceof Error ? cause.message : 'Plugin failed';
  process.stderr.write(`workssh-raft: ${message}\n`);
  process.exitCode ??= 1;
}
