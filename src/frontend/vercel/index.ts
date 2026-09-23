import { createDefaultSandboxClient } from "../../default-client.js";
import { createVercelSandboxClass } from "./sandbox.js";

/** Vercel-compatible facade bound at the package boundary to Localbox's default client. */
export class Sandbox extends createVercelSandboxClass(createDefaultSandboxClient) {}

export { Command, CommandFinished } from "./command.js";
export type {
  CommandChunk,
  CommandOptions,
  CommandOutput,
  CommandRunOptions,
} from "./command.js";
export {
  DockerUnavailableError,
  ImagePullError,
  InvalidSandboxOptionsError,
  LocalboxError,
  PortNotExposedError,
  SandboxAlreadyExistsError,
  SandboxDeletedError,
  SandboxNotFoundError,
  SandboxSourceError,
  UnsupportedImageError,
  UnsupportedSandboxCapabilityError,
} from "./errors.js";
export { FileSystem } from "./filesystem.js";
export type {
  FileAccessOptions,
  FileAppendOptions,
  FileChmodOptions,
  FileCopyOptions,
  FileMkdirOptions,
  FileReadOptions,
  FileRemoveOptions,
  FileRenameOptions,
  FileWriteOptions,
} from "./filesystem.js";
export {
  MANAGED_IMAGES,
  MANAGED_IMAGE_REGISTRY,
  MANAGED_IMAGE_UPSTREAM_COMMIT,
} from "../vercel-managed-images.js";
export type {
  NetworkPolicy,
  NetworkPolicyKeyValueMatcher,
  NetworkPolicyMatch,
  NetworkPolicyMatcher,
  NetworkPolicyRule,
  SandboxCreateOptions,
  SandboxGetOptions,
  SandboxGetOrCreateOptions,
  SandboxMounts,
  SandboxPath,
  SandboxRegion,
  SandboxRuntime,
  SandboxSource,
  SandboxStatus,
  WriteFileSpec,
} from "./types.js";
