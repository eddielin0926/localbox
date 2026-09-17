import { DockerBackend } from "./backends/docker/index.js";
import { EmbeddedSandboxClient } from "./runtime/embedded.js";
import type { SandboxClient } from "./runtime/index.js";

export interface DefaultSandboxClientOptions {
  /** Absolute override for Localbox's XDG state root. */
  readonly stateRoot?: string;
}

/** Application composition root for Localbox's default embedded runtime. */
export function createDefaultSandboxClient(
  options: DefaultSandboxClientOptions = {},
): SandboxClient {
  return new EmbeddedSandboxClient(
    new DockerBackend(),
    options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot },
  );
}

export {
  DockerBackend,
  MANAGED_IMAGES,
  MANAGED_IMAGE_REGISTRY,
  MANAGED_IMAGE_UPSTREAM_COMMIT,
} from "./backends/docker/index.js";
