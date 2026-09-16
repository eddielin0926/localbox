export class LocalboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class DockerUnavailableError extends LocalboxError {
  constructor(cause?: unknown) {
    super("Cannot connect to Docker. Start Docker and retry.", { cause });
  }
}

export class SandboxAlreadyExistsError extends LocalboxError {
  readonly sandboxName: string;

  constructor(name: string, cause?: unknown) {
    super(`Sandbox "${name}" already exists. Use Sandbox.get() or choose another name.`, { cause });
    this.sandboxName = name;
  }
}

export class SandboxNotFoundError extends LocalboxError {
  readonly sandboxName: string;

  constructor(name: string, cause?: unknown) {
    super(`Sandbox "${name}" was not found. Create it before retrying.`, { cause });
    this.sandboxName = name;
  }
}

export class SandboxDeletedError extends LocalboxError {
  readonly sandboxName: string;

  constructor(name: string) {
    super(`Sandbox "${name}" was deleted. Create a new sandbox before retrying.`);
    this.sandboxName = name;
  }
}

export class UnsupportedImageError extends LocalboxError {
  readonly image: string;

  constructor(image: string, cause?: unknown) {
    super(`Image "${image}" must contain node and /bin/sh. Choose a compatible image and retry.`, { cause });
    this.image = image;
  }
}

export class PortNotExposedError extends LocalboxError {
  readonly sandboxName: string;
  readonly port: number;

  constructor(name: string, port: number) {
    super(`Port ${port} is not exposed for sandbox "${name}". Include it in create({ ports }) and retry.`);
    this.sandboxName = name;
    this.port = port;
  }
}

export class InvalidSandboxOptionsError extends LocalboxError {}

export class UnsupportedSandboxCapabilityError extends LocalboxError {
  readonly capability: string;

  constructor(capability: string) {
    super(`Localbox's Docker backend does not support ${capability}. Remove that requirement or use a capable backend.`);
    this.capability = capability;
  }
}

export class SandboxSourceError extends LocalboxError {
  readonly sourceType: "git" | "tarball";

  constructor(sourceType: "git" | "tarball", cause?: unknown) {
    super(`Could not materialize the ${sourceType} source in the sandbox. Check the source and retry.`, { cause });
    this.sourceType = sourceType;
  }
}

export class ImagePullError extends LocalboxError {
  readonly image: string;

  constructor(image: string, cause?: unknown) {
    super(`Could not pull image "${image}". Check the image name, registry access, and Docker credentials.`, { cause });
    this.image = image;
  }
}
