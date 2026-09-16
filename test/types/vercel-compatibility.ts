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

type Assert<T extends true> = T;

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
