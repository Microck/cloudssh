import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { CreateInput, ExecInput, ExecResult, FileInfo, Labels, WriteOptions } from '@opencoredev/sandbox-sdk/provider';

/** Credentials are file paths only; the helper reads its existing auth without changing it. */
const absolutePath = z.string().min(1).refine(isAbsolute, 'Expected an absolute path');

export const worksshOptionsSchema = z.object({
  helperRoot: absolutePath,
  stateDirectory: absolutePath,
  authFile: absolutePath.optional(),
  cloudflareEnv: absolutePath.optional(),
  accountId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  allowCredits: z.boolean().optional(),
  operationTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
}).strict();

export type WorksshOptions = z.infer<typeof worksshOptionsSchema>;

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
}

/** One SSH connection multiplexes command/control channels. The relay allows one client per tunnel. */
export interface SshAccess {
  id: string;
  proxyCommand: [string, ...string[]];
  privateKey: Buffer;
  hostPublicKey: string;
  scratchDirectory: string;
}

export interface WorksshNative {
  id: string;
  sessionDirectory: string;
  phase: SandboxRecord['phase'];
}

export interface Lifecycle {
  create(input: CreateInput): Promise<SandboxRecord>;
  get(id: string): Promise<SandboxRecord>;
  list(): Promise<SandboxRecord[]>;
  find(key: string): Promise<SandboxRecord | undefined>;
  destroy(id: string): Promise<void>;
  access(id: string): Promise<SshAccess>;
  acquire(id: string): Promise<() => Promise<void>>;
  sessionDirectory(id: string): string;
}

export interface RemoteFiles {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
  list(path: string): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo>;
  remove(path: string, options: { recursive: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface GuestTransport {
  exec(input: ExecInput): Promise<ExecResult>;
  files: RemoteFiles;
  close(): Promise<void>;
}
