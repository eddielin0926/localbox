export class DockerBackendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class DockerUnavailableError extends DockerBackendError {
  constructor(cause?: unknown) {
    super("Cannot connect to Docker. Start Docker and retry.", { cause });
  }
}

export class SandboxAlreadyExistsError extends DockerBackendError {
  readonly sandboxName: string;

  constructor(name: string, cause?: unknown) {
    super(`A sandbox named "${name}" already exists.`, { cause });
    this.sandboxName = name;
  }
}

export class SandboxNotFoundError extends DockerBackendError {
  readonly sandboxName: string;

  constructor(name: string, cause?: unknown) {
    super(`Sandbox "${name}" was not found.`, { cause });
    this.sandboxName = name;
  }
}

export class SandboxDeletedError extends DockerBackendError {
  readonly sandboxName: string;

  constructor(name: string) {
    super(`Sandbox "${name}" has been deleted.`);
    this.sandboxName = name;
  }
}

export class UnsupportedImageError extends DockerBackendError {
  readonly image: string;

  constructor(image: string, cause?: unknown) {
    super(`Image "${image}" cannot run Localbox sandboxes. Use an image with node, /bin/sh, git, and tar.`, { cause });
    this.image = image;
  }
}

export class PortNotExposedError extends DockerBackendError {
  readonly sandboxName: string;
  readonly port: number;

  constructor(name: string, port: number) {
    super(`Port ${port} is not exposed for sandbox "${name}". Include it in create({ ports }) and retry.`);
    this.sandboxName = name;
    this.port = port;
  }
}

export class InvalidSandboxOptionsError extends DockerBackendError {}

export class UnsupportedSandboxCapabilityError extends DockerBackendError {
  readonly capability: string;

  constructor(capability: string) {
    super(`Localbox's Docker backend does not support ${capability}. Remove that requirement or use a capable backend.`);
    this.capability = capability;
  }
}

export class SandboxSourceError extends DockerBackendError {
  readonly sourceType: "git" | "tarball";

  constructor(sourceType: "git" | "tarball", cause?: unknown) {
    super(`Could not materialize the ${sourceType} sandbox source.`, { cause });
    this.sourceType = sourceType;
  }
}

export class ImagePullError extends DockerBackendError {
  readonly image: string;

  constructor(image: string, cause?: unknown) {
    super(`Could not pull image "${image}". Check the image name, registry access, and Docker credentials.`, { cause });
    this.image = image;
  }
}
