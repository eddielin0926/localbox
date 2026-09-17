import type { Sandbox } from "./sandbox.js";

export type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed";

export type NetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      readonly allow?: readonly string[] | Readonly<Record<string, readonly unknown[]>>;
      readonly subnets?: {
        readonly allow?: readonly string[];
        readonly deny?: readonly string[];
      };
    };

export type SandboxSource =
  | {
      readonly type: "git";
      readonly url: string;
      readonly depth?: number;
      readonly revision?: string;
    }
  | {
      readonly type: "git";
      readonly url: string;
      readonly username: string;
      readonly password: string;
      readonly depth?: number;
      readonly revision?: string;
    }
  | {
      readonly type: "tarball";
      readonly url: string;
    }
  | {
      readonly type: "snapshot";
      readonly snapshotId: string;
    };

export interface SandboxCreateOptions {
  readonly name?: string;
  readonly source?: SandboxSource;
  readonly ports?: readonly number[];
  readonly timeout?: number;
  readonly resources?: { readonly vcpus: number };
  readonly networkPolicy?: NetworkPolicy;
  readonly env?: Readonly<Record<string, string>>;
  readonly tags?: Readonly<Record<string, string>>;
  readonly region?: string;
  readonly failoverRegions?: readonly string[];
  readonly mounts?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly persistent?: boolean;
  readonly snapshotExpiration?: number;
  readonly keepLastSnapshots?: {
    readonly count: number;
    readonly expiration?: number;
    readonly deleteEvicted?: boolean;
  };
  readonly onResume?: (sandbox: Sandbox) => Promise<void>;
  readonly runtime?: string;
  readonly image?: string;
}

export interface SandboxGetOptions {
  readonly name: string;
  readonly resume?: boolean;
  readonly onResume?: (sandbox: Sandbox) => Promise<void>;
  readonly signal?: AbortSignal;
}

export type SandboxGetOrCreateOptions = SandboxCreateOptions & {
  readonly onCreate?: (sandbox: Sandbox) => Promise<void>;
  readonly resume?: boolean;
};

export interface WriteFileSpec {
  readonly path: string;
  readonly content: Buffer | Uint8Array | string;
  readonly mode?: number;
}

export interface SandboxPath {
  readonly path: string;
  readonly cwd?: string;
}

export interface SandboxListOptions {
  readonly namePrefix?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly sortBy?: "createdAt" | "name" | "statusUpdatedAt";
  readonly sortOrder?: "asc" | "desc";
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface SandboxListItem {
  readonly name: string;
  readonly persistent: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly currentSessionId: string;
  readonly status: SandboxStatus;
  readonly vcpus?: number;
  readonly memory?: number;
  readonly image: string;
  readonly runtime?: string;
  readonly ports: readonly number[];
  readonly endpoints: readonly { readonly port: number; readonly url: string }[];
  readonly region?: string;
  readonly failoverRegions: readonly string[];
  readonly timeout: number;
  readonly statusUpdatedAt: number;
  readonly cwd: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface SandboxListPage {
  readonly sandboxes: readonly SandboxListItem[];
  readonly pagination: {
    readonly count: number;
    readonly next: string | null;
  };
}

export type SandboxListResult = SandboxListPage
  & AsyncIterable<SandboxListItem>
  & {
    pages(): AsyncIterable<SandboxListPage>;
    toArray(): Promise<SandboxListItem[]>;
  };
