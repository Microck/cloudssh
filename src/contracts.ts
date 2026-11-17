import type { Readable, Writable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { CreateInput, ExecInput, ExecResult, FileInfo, Labels, WriteOptions } from '@opencoredev/sandbox-sdk/provider';

/** Credentials are file paths only; the helper reads its existing auth without changing it. */
const absolutePath = z.string().min(1).refine(isAbsolute, 'Expected an absolute path');

export const cloudsshOptionsSchema = z.object({
  helperRoot: absolutePath,
  stateDirectory: absolutePath,
  authFile: absolutePath.optional(),
  cloudflareEnv: absolutePath.optional(),
  accountId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  allowCredits: z.boolean().optional(),
  keepAlive: z.boolean().optional(),
  operationTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
}).strict();

export type CloudsshOptions = z.infer<typeof cloudsshOptionsSchema>;

/** Caller-authorized access window; matches Raft's 60-second to 30-day range. */
export const accessTimeoutSchema = z.number().int().min(60_000).max(2_592_000_000);
export interface ReconnectInput {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface KeepAliveIdentity {
  sessionId: string;
  threadId: string;
  runtimeId: string;
  hostKeySha256: string;
}

export interface KeepAliveStatus {
  enabled: boolean;
  state: 'disabled' | 'scheduled' | 'running' | 'stopped' | 'expired' | 'failed';
  intervalMs: number;
  nextAt?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  ssh?: 'verified' | 'busy';
  managerState?: string;
}

export interface SandboxRecord {
  version: 1;
  id: string;
  key?: string;
  labels: Labels;
  env: Record<string, string>;
  createdAt: number;
  timeoutMs: number;
  phase: 'creating' | 'ready' | 'failed' | 'deleting' | 'deleted';
  helperPid?: number;
  keepAlive?: boolean;
}

/** One SSH connection multiplexes command/control channels. The relay allows one client per tunnel. */
export interface SshAccess {
  id: string;
  proxyCommand: [string, ...string[]];
  privateKey: Buffer;
  hostPublicKey: string;
  scratchDirectory: string;
}

export interface CloudsshNative {
  id: string;
  sessionDirectory: string;
  phase: SandboxRecord['phase'];
}

export interface Lifecycle {
  create(input: CreateInput): Promise<SandboxRecord>;
  resume(id: string, input: ReconnectInput): Promise<SandboxRecord>;
  get(id: string): Promise<SandboxRecord>;
  list(): Promise<SandboxRecord[]>;
  find(key: string): Promise<SandboxRecord | undefined>;
  destroy(id: string): Promise<void>;
  access(id: string): Promise<SshAccess>;
  acquire(id: string): Promise<() => Promise<void>>;
  sessionDirectory(id: string): string;
  keepAlive(id: string, enabled?: boolean): Promise<KeepAliveStatus>;
  maintain(id: string, expected: KeepAliveIdentity, signal?: AbortSignal): Promise<void>;
}

export interface RemoteFiles {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
  list(path: string): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo>;
  remove(path: string, options: { recursive: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface ShellInput {
  stdin: Readable;
  stdout: Writable & { columns?: number; rows?: number };
  stderr: Writable;
  signal?: AbortSignal;
  term?: string;
}

export interface GuestTransport {
  exec(input: ExecInput): Promise<ExecResult>;
  files: RemoteFiles;
  /** Authenticated interactive shell over the transport's pinned SSH connection. */
  shell(input: ShellInput): Promise<number>;
  readonly scratchDirectory: string;
  close(): Promise<void>;
}

