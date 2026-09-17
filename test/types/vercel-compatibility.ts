import type {
  Command as VercelCommand,
  CommandFinished as VercelCommandFinished,
  FileSystem as VercelFileSystem,
  Sandbox as VercelSandbox,
} from "@vercel/sandbox";
import type {
  Command as LocalCommand,
  CommandFinished as LocalCommandFinished,
  FileSystem as LocalFileSystem,
  Sandbox as LocalSandbox,
} from "../../src/vercel/index.js";
import type {
  SandboxRecord as RuntimeSandboxRecord,
  SandboxSpec as RuntimeSandboxSpec,
} from "../../src/runtime/index.js";

type Assert<T extends true> = T;

type UpstreamCreateOptions = NonNullable<Parameters<typeof VercelSandbox.create>[0]>;
type LocalCreateOptions = NonNullable<Parameters<typeof LocalSandbox.create>[0]>;
type WithoutResumeCallback<T> = T extends unknown ? Omit<T, "onResume"> : never;
type LocalResumeCallback = NonNullable<LocalCreateOptions["onResume"]>;

type FileSystemMethods =
  | "readFile"
  | "writeFile"
  | "appendFile"
  | "mkdir"
  | "readdir"
  | "stat"
  | "lstat"
  | "unlink"
  | "rm"
  | "rmdir"
  | "rename"
  | "copyFile"
  | "access"
  | "exists"
  | "chmod"
  | "chown"
  | "symlink"
  | "readlink"
  | "realpath"
  | "truncate"
  | "mkdtemp";
type CommandMembers = Pick<
  VercelCommand,
  | "cmdId"
  | "cwd"
  | "startedAt"
  | "exitCode"
  | "durationMs"
  | "logs"
  | "output"
  | "stdout"
  | "stderr"
  | "kill"
>;

interface FinishedContract extends CommandMembers {
  exitCode: number;
  wait(): Promise<FinishedContract>;
}

interface CommandContract extends CommandMembers {
  wait(params?: { signal?: AbortSignal }): Promise<FinishedContract>;
}

type CompatibleSandboxMethods = Pick<
  VercelSandbox,
  | "mkDir"
  | "readFile"
  | "readFileToBuffer"
  | "downloadFile"
  | "writeFiles"
  | "domain"
  | "delete"
  | "extendTimeout"
>;


export type FileSystemMatchesVercel = Assert<
  LocalFileSystem extends Pick<VercelFileSystem, FileSystemMethods> ? true : false
>;
export type CommandMatchesVercel = Assert<LocalCommand extends CommandContract ? true : false>;
export type CommandFinishedMatchesVercel = Assert<
  LocalCommandFinished extends FinishedContract ? true : false
>;
export type SandboxMethodsMatchVercel = Assert<
  LocalSandbox extends CompatibleSandboxMethods ? true : false
>;
export type CreateOptionsAcceptVercelParameters = Assert<
  WithoutResumeCallback<UpstreamCreateOptions> extends WithoutResumeCallback<LocalCreateOptions>
    ? true
    : false
>;
export type CreateCallbackReceivesLocalSandbox = Assert<
  Parameters<LocalResumeCallback>[0] extends LocalSandbox ? true : false
>;
export type CreateCallbackReturnsPromise = Assert<
  LocalResumeCallback extends (sandbox: LocalSandbox) => Promise<void> ? true : false
>;

export type RuntimeSpecCarriesBootArtifact = Assert<
  "bootArtifact" extends keyof RuntimeSandboxSpec ? true : false
>;
export type RuntimeRecordCarriesBootArtifact = Assert<
  "bootArtifact" extends keyof RuntimeSandboxRecord ? true : false
>;
