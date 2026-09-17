import { DockerBackend } from "./backends/docker/index.js";
import { EmbeddedSandboxClient } from "./runtime/embedded.js";
import type { SandboxClient } from "./runtime/index.js";

/** Application composition root for Localbox's default embedded runtime. */
export function createDefaultSandboxClient(): SandboxClient {
  return new EmbeddedSandboxClient(new DockerBackend());
}
