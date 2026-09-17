import { randomUUID } from "node:crypto";
import { createDefaultSandboxClient } from "../default-client.js";
import type {
  ClientResult,
  JsonObject,
  MutationMetadata,
  RequestMetadata,
  SandboxClient,
  SandboxError,
} from "../runtime/index.js";
import {
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

let sandboxClientFactory: () => SandboxClient = createDefaultSandboxClient;

export function createSandboxClient(): SandboxClient {
  return sandboxClientFactory();
}

/** @internal Test seam for exercising the compatibility frontend through a neutral client. */
export function setSandboxClientFactory(factory: (() => SandboxClient) | null): void {
  sandboxClientFactory = factory ?? createDefaultSandboxClient;
}

export function requestMetadata(): RequestMetadata {
  return { requestId: randomUUID(), deadline: null };
}

export function mutationMetadata(): MutationMetadata {
  const requestId = randomUUID();
  return { requestId, idempotencyKey: requestId, deadline: null };
}

export function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return operation;
  const aborted = Promise.withResolvers<T>();
  const abort = (): void => aborted.reject(abortError());
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function translatedClientError(error: SandboxError): Error {
  const resource = error.details.type === "resource" ? error.details.resourceId : "";
  switch (error.code) {
    case "LOCALBOX_DOCKER_UNAVAILABLE":
      return new DockerUnavailableError();
    case "LOCALBOX_SANDBOX_ALREADY_EXISTS":
      return new SandboxAlreadyExistsError(resource);
    case "LOCALBOX_SANDBOX_NOT_FOUND":
      return new SandboxNotFoundError(resource);
    case "LOCALBOX_SANDBOX_DELETED":
      return new SandboxDeletedError(resource);
    case "LOCALBOX_ENDPOINT_NOT_FOUND": {
      const separator = resource.lastIndexOf(":");
      return new PortNotExposedError(resource.slice(0, separator), Number(resource.slice(separator + 1)));
    }
    case "LOCALBOX_IMAGE_PULL_FAILED": {
      const image = /^Could not pull image "([^"]+)"/.exec(error.message)?.[1] ?? error.message;
      return new ImagePullError(image);
    }
    case "LOCALBOX_UNSUPPORTED_IMAGE": {
      const image = /^Image "([^"]+)"/.exec(error.message)?.[1] ?? error.message;
      return new UnsupportedImageError(image);
    }
    case "LOCALBOX_SOURCE_FAILURE":
      return new SandboxSourceError(
        error.details.type === "source" ? error.details.sourceType : "git",
      );
    case "LOCALBOX_UNSUPPORTED_CAPABILITY": {
      const capability = /does not support (.+)\. Remove/.exec(error.message)?.[1] ?? error.message;
      return new UnsupportedSandboxCapabilityError(capability);
    }
    case "LOCALBOX_UNSUPPORTED_REQUIREMENT": {
      const first = error.details.type === "requirement-negotiation"
        ? error.details.issues[0]
        : undefined;
      return new UnsupportedSandboxCapabilityError(
        first?.backendDiagnostic ?? first?.reason ?? error.message,
      );
    }
    case "LOCALBOX_INVALID_REQUEST":
    case "LOCALBOX_INVALID_REQUIREMENT":
      return new InvalidSandboxOptionsError(error.message);
    case "LOCALBOX_OPERATION_CANCELLED":
    case "LOCALBOX_DEADLINE_EXCEEDED":
      return abortError();
    default: {
      const translated = new LocalboxError(error.message) as NodeJS.ErrnoException;
      if (error.details.type === "file") {
        if (error.details.code !== null) translated.code = error.details.code;
        if (error.details.syscall !== null) translated.syscall = error.details.syscall;
        if (error.details.path !== null) translated.path = error.details.path;
      } else if (error.code === "LOCALBOX_FILE_NOT_FOUND") {
        translated.code = "ENOENT";
      }
      return translated;
    }
  }
}

export function unwrap<T extends JsonObject>(result: ClientResult<T>): T {
  if (result.ok) return result.value;
  throw translatedClientError(result.error);
}
