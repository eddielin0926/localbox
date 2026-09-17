import { randomUUID } from "node:crypto";
import {
  EmbeddedSandboxClient,
  DockerBackend,
  type ClientResult,
  type JsonObject,
  type MutationMetadata,
  type RequestMetadata,
  type SandboxClient,
  type SandboxError,
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

export function createSandboxClient(): SandboxClient {
  return new EmbeddedSandboxClient(new DockerBackend());
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
    case "LOCALBOX_INVALID_REQUEST":
      return new InvalidSandboxOptionsError(error.message);
    case "LOCALBOX_OPERATION_CANCELLED":
    case "LOCALBOX_DEADLINE_EXCEEDED":
      return abortError();
    default: {
      const translated = new LocalboxError(error.message);
      if (error.code === "LOCALBOX_FILE_NOT_FOUND") {
        (translated as NodeJS.ErrnoException).code = "ENOENT";
      }
      return translated;
    }
  }
}

export function unwrap<T extends JsonObject>(result: ClientResult<T>): T {
  if (result.ok) return result.value;
  throw translatedClientError(result.error);
}
