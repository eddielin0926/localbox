import type { Sandbox } from "./sandbox.js";

export type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed";

export interface SandboxCreateOptions {
  name?: string;
  image?: string;
  runtime?: "node24";
  ports?: number[];
  timeout?: number;
  env?: Record<string, string>;
  persistent?: boolean;
  signal?: AbortSignal;
}

export interface SandboxGetOptions {
  name: string;
  resume?: boolean;
  onResume?: (sandbox: Sandbox) => Promise<void>;
  signal?: AbortSignal;
}

export interface SandboxGetOrCreateOptions extends SandboxCreateOptions {
  onCreate?: (sandbox: Sandbox) => Promise<void>;
  onResume?: (sandbox: Sandbox) => Promise<void>;
  resume?: boolean;
}

export interface WriteFileSpec {
  path: string;
  content: Buffer | Uint8Array | string;
  mode?: number;
}

export interface SandboxPath {
  path: string;
  cwd?: string;
}

export type SandboxListStatus =
  | SandboxStatus
  | "aborted"
  | "snapshotting";

export interface SandboxListOptions {
  namePrefix?: string;
  tags?: Record<string, string>;
  sortBy?: "createdAt" | "name" | "statusUpdatedAt";
  sortOrder?: "asc" | "desc";
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface SandboxListItem {
  name: string;
  persistent: boolean;
  createdAt: number;
  updatedAt: number;
  currentSessionId: string;
  status: SandboxListStatus;
  vcpus?: number;
  memory?: number;
  image?: string;
  timeout?: number;
  statusUpdatedAt?: number;
  cwd?: string;
  tags?: Record<string, string>;
}

export interface SandboxListPage {
  sandboxes: SandboxListItem[];
  pagination: {
    count: number;
    next: string | null;
  };
}

export type SandboxListResult = SandboxListPage
  & AsyncIterable<SandboxListItem>
  & {
    pages(): AsyncIterable<SandboxListPage>;
    toArray(): Promise<SandboxListItem[]>;
  };
