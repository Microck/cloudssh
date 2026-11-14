import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import type { Client as SshClient, ClientChannel } from 'ssh2';
import { SandboxError } from '@opencoredev/sandbox-sdk';
import type { ExecInput, ExecResult, WriteOptions } from '@opencoredev/sandbox-sdk/provider';
import { z } from 'zod';
import type { GuestTransport, RemoteFiles, SshAccess } from './contracts.js';
const { Client, utils } = ssh2;


const provider = 'workssh';
const maxFileBytes = 32 * 1024 * 1024;
const maxLineBytes = 96 * 1024 * 1024;
const fileInfo = z.object({ path: z.string(), type: z.enum(['file', 'directory', 'symlink']), size: z.number().nonnegative(), modifiedAt: z.number() });
const failed = z.object({ ok: z.literal(false), error: z.string(), errno: z.number().optional() });
const fileReply = z.union([failed, z.object({ ok: z.literal(true), data: z.string().optional(), item: fileInfo.optional(), items: z.array(fileInfo).optional() })]);
const execReply = z.union([
  failed,
  z.object({ type: z.literal('chunk'), stream: z.enum(['stdout', 'stderr']), data: z.string() }),
  z.object({ type: z.literal('done'), exitCode: z.number().int().min(0).max(255).nullable(), timedOut: z.boolean() }),
]);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type FileRequest =
  | { op: 'read' | 'stat' | 'list' | 'mkdir'; path: string }
  | { op: 'write'; path: string; data: string; mode?: number }
  | { op: 'remove'; path: string; recursive: boolean }
  | { op: 'kill'; id: string; markerDir: string };

interface ExecRequest {
  op: 'exec'; id: string; markerDir: string;
  command: string; cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number;
}

/** A proxy carries SSH bytes only. Public-key authentication and an independent host pin remain mandatory. */
export function createTransport(access: SshAccess): GuestTransport {
  const pin = utils.parseKey(access.hostPublicKey);
  if (pin instanceof Error || Array.isArray(pin)) throw new SandboxError('Invalid host public key', { code: 'invalid_argument', provider });
  const expected = pin.getPublicSSH();
  const markerDir = posix.join(access.scratchDirectory, `.sandbox-sdk-${randomBytes(16).toString('hex')}`);
  let source: Promise<string> | undefined;
  let ssh: SshClient | undefined;
  let connecting: Promise<SshClient> | undefined;
  let ready = false;
  let closed = false;
  let lost: Error | undefined;
  let proxy: ChildProcessWithoutNullStreams | undefined;
  let proxyClosed: Promise<void> | undefined;
  let usedExec = false;
  const operations = new Map<string, { stop(reason: 'abort' | 'timeout' | 'close'): void; settled: Promise<void> }>();

  function error(message: string, code: 'provider' | 'unavailable' | 'outcome_unknown' | 'file_not_found' | 'invalid_argument' | 'auth', cause?: unknown) {
    return new SandboxError(message, { code, provider, sandboxId: access.id, cause: cause instanceof Error ? cause.message : undefined });
  }

  function getClient(): Promise<SshClient> {
    if (lost) return Promise.reject(error('SSH connection was lost; inspect remote state before retrying', 'outcome_unknown', lost));
    if (ready && ssh) return Promise.resolve(ssh);
    if (connecting) return connecting;
    if (closed) return Promise.reject(error('SSH transport is closed', 'unavailable'));
    const connected = Promise.withResolvers<SshClient>();
    const exited = Promise.withResolvers<void>();
    proxy = spawn(access.proxyCommand[0], access.proxyCommand.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    proxyClosed = exited.promise;
    const socket = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
    const instance = new Client();
    ssh = instance;
    let pinRejected = false;
    proxy.stderr.resume();
    socket.on('error', (cause) => { lost = cause; instance.destroy(); });
    proxy.once('error', (cause) => {
      lost = cause;
      connected.reject(error('Could not launch the SSH proxy', 'unavailable', cause));
      instance.destroy();
    });
    proxy.once('close', () => {
      exited.resolve();
      if (!closed) lost = new Error('SSH proxy closed');
      instance.destroy();
    });
    instance.once('ready', () => { ready = true; connected.resolve(instance); });
    instance.on('error', (cause) => {
      lost = cause;
      connected.reject(error(pinRejected ? 'SSH host key does not match the independent pin' : 'SSH authentication or connection failed', pinRejected ? 'auth' : 'unavailable', cause));
    });
    instance.on('close', () => {
      ready = false;
      if (!closed) lost ??= new Error('SSH connection closed');
      connected.reject(error('SSH connection closed before becoming ready', 'unavailable'));
    });
    connecting = connected.promise;
    instance.connect({
      sock: socket, username: 'root', privateKey: access.privateKey, readyTimeout: 20_000,
      hostVerifier(key: Buffer) {
        const matches = key.length === expected.length && timingSafeEqual(key, expected);
        pinRejected = !matches;
        return matches;
      },
    });
    return connecting;
  }

  async function request(payload: FileRequest | ExecRequest, onLine: (line: string) => void, deadlineMs = 30_000) {
    const body = Buffer.from(`${JSON.stringify(payload)}\n`);
    if (body.length > 64 * 1024 * 1024) throw error('Guest request exceeds 64 MiB', 'invalid_argument');
    source ??= readFile(new URL('./guest.py', import.meta.url), 'utf8');
    const command = `python3 -c ${quote(await source)}`;
    const client = await getClient();
    const result = Promise.withResolvers<void>();
    let channel: ClientChannel | undefined;
    let completed = false;
    const timer = setTimeout(() => finish(error('SSH operation deadline exceeded; remote outcome is unknown', 'outcome_unknown')), deadlineMs);
    function finish(cause?: Error) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (cause) {
        channel?.close();
        result.reject(cause);
      } else result.resolve();
    }
    client.exec(command, { pty: false }, (cause, stream) => {
      if (cause) { finish(error('SSH execution request failed', 'unavailable', cause)); return; }
      channel = stream;
      if (completed) { stream.close(); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on('data', (chunk: Buffer) => {
        if (completed) return;
        try {
          let start = 0;
          while (start < chunk.length) {
            const end = chunk.indexOf(10, start);
            const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
            chunks.push(piece);
            length += piece.length;
            if (length > maxLineBytes) throw error('Guest response line exceeds the transfer bound', 'provider');
            if (end < 0) break;
            onLine(Buffer.concat(chunks, length).toString('utf8'));
            chunks.length = 0;
            length = 0;
            start = end + 1;
          }
        } catch (failure) {
          finish(failure instanceof Error ? failure : error('Invalid guest response', 'provider'));
        }
      });
      stream.stderr.resume();
      stream.once('error', (failure: Error) => finish(error('SSH stream failed; remote outcome is unknown', 'outcome_unknown', failure)));
      stream.once('close', (code: number | undefined) => {
        if (lost || length || code !== 0) finish(error('SSH channel closed without a confirmed complete response', 'outcome_unknown', lost));
        else finish();
      });
      stream.end(body);
    });
    return result.promise;
  }

  async function fileRequest(payload: FileRequest) {
    let response: z.infer<typeof fileReply> | undefined;
    await request(payload, (line) => { response = fileReply.parse(JSON.parse(line)); });
    if (!response) throw error('Guest omitted its file/control result', 'provider');
    if (!response.ok) throw error(response.error, response.errno === 2 ? 'file_not_found' : response.errno === 22 ? 'invalid_argument' : 'provider');
    return response;
  }

  async function publicFile(payload: FileRequest) {
    if (closed) throw error('SSH transport is closed', 'unavailable');
    return fileRequest(payload);
  }

  const files: RemoteFiles = {
    async read(path) {
      const response = await publicFile({ op: 'read', path });
      if (response.data === undefined) throw error('Guest omitted file bytes', 'provider');
      return Buffer.from(response.data, 'base64');
    },
    async write(path, data, options?: WriteOptions) {
      if (data.byteLength > maxFileBytes) throw error('File transfer exceeds 32 MiB', 'invalid_argument');
      await publicFile({ op: 'write', path, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'), mode: options?.mode });
    },
    async list(path) {
      const response = await publicFile({ op: 'list', path });
      if (!response.items) throw error('Guest omitted directory entries', 'provider');
      return response.items;
    },
    async stat(path) {
      const response = await publicFile({ op: 'stat', path });
      if (!response.item) throw error('Guest omitted file metadata', 'provider');
      return response.item;
    },
    async remove(path, options) { await publicFile({ op: 'remove', path, recursive: options.recursive }); },
    async mkdir(path) { await publicFile({ op: 'mkdir', path }); },
  };

  return {
    files,
    async exec(input: ExecInput): Promise<ExecResult> {
      if (closed) throw error('SSH transport is closed', 'unavailable');
      if (input.signal?.aborted) return { exitCode: null, timedOut: false };
      if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw error('Execution timeout must be positive finite milliseconds', 'invalid_argument');
      const id = randomBytes(16).toString('hex');
      const begun = Date.now();
      const stopped = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      let reason: 'abort' | 'timeout' | 'close' | undefined;
      let started = false;
      let cancellation: Promise<z.infer<typeof fileReply>> | undefined;
      function stop(why: 'abort' | 'timeout' | 'close') {
        if (reason) return;
        reason = why;
        stopped.resolve();
        if (started) {
          cancellation = fileRequest({ op: 'kill', id, markerDir });
          void cancellation.catch(() => {});
        }
      }
      operations.set(id, { stop, settled: settled.promise });
      const abort = () => stop('abort');
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      const timer = setTimeout(() => stop('timeout'), input.timeoutMs);
      try {
        await Promise.race([getClient(), stopped.promise]);
        if (reason) return { exitCode: null, timedOut: reason === 'timeout' };
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        let outcome: ExecResult | undefined;
        started = true;
        usedExec = true;
        const running = request({
          op: 'exec', id, markerDir, command: input.command, cwd: input.cwd, env: input.env,
          stdin: Buffer.from(input.stdin ?? '').toString('base64'), timeoutMs: Math.max(1, input.timeoutMs - (Date.now() - begun)),
        }, (line) => {
          const frame = execReply.parse(JSON.parse(line));
          if ('ok' in frame) throw error(frame.error, 'provider');
          if (frame.type === 'done') outcome = { exitCode: frame.exitCode, timedOut: frame.timedOut };
          else {
            const text = decoders[frame.stream].decode(Buffer.from(frame.data, 'base64'), { stream: true });
            if (text) input.onChunk({ stream: frame.stream, text });
          }
        }, Math.max(1000, input.timeoutMs + 5000));
        const cancellationLimit = stopped.promise.then(async () => {
          await delay(4500, undefined, { ref: false });
          throw error('Remote process termination could not be confirmed before the cancellation bound', 'outcome_unknown');
        });
        await Promise.race([running, cancellationLimit]);
        if (cancellation) await cancellation;
        for (const stream of ['stdout', 'stderr'] as const) {
          const tail = decoders[stream].decode();
          if (tail) input.onChunk({ stream, text: tail });
        }
        if (!outcome) throw error('Guest omitted execution outcome', 'outcome_unknown');
        return reason ? { exitCode: null, timedOut: reason === 'timeout' } : outcome;
      } catch (cause) {
        if (started && (reason || lost)) throw error('Remote command outcome could not be confirmed', 'outcome_unknown', cause);
        throw cause;
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        operations.delete(id);
        settled.resolve();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const pending = [...operations.values()];
      for (const operation of pending) operation.stop('close');
      await Promise.all(pending.map((operation) => operation.settled));
      try {
        if (ready && usedExec && !lost) await fileRequest({ op: 'remove', path: markerDir, recursive: true });
      } finally {
        ssh?.destroy();
        if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
          proxy.kill('SIGTERM');
          if (proxyClosed) await Promise.race([proxyClosed, delay(1000, undefined, { ref: false })]);
          if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill('SIGKILL');
        }
        if (proxyClosed) await proxyClosed;
      }
    },
  };
}
