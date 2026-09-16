import type { Sandbox } from "./sandbox.js";

export type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed";

export type SandboxRuntime = "node26" | "node24" | "node22" | "python3.13";

export type SandboxRegion =
  | "iad1"
  | "sfo1"
  | "cle1"
  | "cdg1"
  | "fra1"
  | "arn1"
  | "sin1"
  | "pdx1"
  | "lhr1"
  | "icn1"
  | "bom1"
  | "cpt1"
  | "dub1"
  | "gru1"
  | "hkg1"
  | "syd1"
  | "yul1"
  | "hnd1"
  | "kix1"
  | (string & {});

export type NetworkPolicyMatcher =
  | { exact?: string }
  | { startsWith?: string }
  | { regex?: string };

export interface NetworkPolicyKeyValueMatcher {
  key?: NetworkPolicyMatcher;
  value?: NetworkPolicyMatcher;
}

export interface NetworkPolicyMatch {
  path?: NetworkPolicyMatcher;
  method?: string[];
  queryString?: NetworkPolicyKeyValueMatcher[];
  headers?: NetworkPolicyKeyValueMatcher[];
}

export type NetworkPolicyRule = {
  match?: NetworkPolicyMatch;
} & (
  | {
      transform: Array<{ headers?: Record<string, string> }>;
      forwardURL?: never;
    }
  | {
      transform?: never;
      forwardURL: string;
    }
);

export type NetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      allow?: string[] | Record<string, NetworkPolicyRule[]>;
      subnets?: {
        allow?: string[];
        deny?: string[];
      };
    };

export type SandboxSource =
  | {
      type: "git";
      url: string;
      depth?: number;
      revision?: string;
    }
  | {
      type: "git";
      url: string;
      username: string;
      password: string;
      depth?: number;
      revision?: string;
    }
  | {
      type: "tarball";
      url: string;
    }
  | {
      type: "snapshot";
      snapshotId: string;
    };

export type SandboxMounts = Record<string, unknown>;

interface BaseSandboxCreateOptions {
  name?: string;
  source?: Exclude<SandboxSource, { type: "snapshot" }>;
  ports?: number[];
  timeout?: number;
  resources?: {
    vcpus: number;
  };
  networkPolicy?: NetworkPolicy;
  env?: Record<string, string>;
  tags?: Record<string, string>;
  region?: SandboxRegion;
  failoverRegions?: SandboxRegion[];
  mounts?: SandboxMounts;
  signal?: AbortSignal;
  persistent?: boolean;
  snapshotExpiration?: number;
  keepLastSnapshots?: {
    count: number;
    expiration?: number;
    deleteEvicted?: boolean;
  };
  onResume?: (sandbox: Sandbox) => Promise<void>;
}

type RuntimeOrImage =
  | {
      runtime?: SandboxRuntime | (string & {});
      image?: never;
    }
  | {
      runtime?: never;
      image?: string;
    };

export type SandboxCreateOptions =
  | (BaseSandboxCreateOptions & RuntimeOrImage)
  | (Omit<BaseSandboxCreateOptions, "source"> & {
      source: Extract<SandboxSource, { type: "snapshot" }>;
      runtime?: never;
      image?: never;
    });

export interface SandboxGetOptions {
  name: string;
  resume?: boolean;
  onResume?: (sandbox: Sandbox) => Promise<void>;
  signal?: AbortSignal;
}

export type SandboxGetOrCreateOptions = SandboxCreateOptions & {
  onCreate?: (sandbox: Sandbox) => Promise<void>;
  resume?: boolean;
};

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
