import { InvalidSandboxOptionsError } from "./errors.js";

export const MANAGED_IMAGE_UPSTREAM_COMMIT = "b99895b79dd346905166efd83bd86e73a9762c2e";
export const MANAGED_IMAGE_REGISTRY = "ghcr.io/eddielin0926/localbox-vercel";

function managedImage(tag: string): string {
  return `${MANAGED_IMAGE_REGISTRY}:${tag}-${MANAGED_IMAGE_UPSTREAM_COMMIT}`;
}

export const MANAGED_IMAGES = Object.freeze({
  universal: managedImage("universal"),
  node22: managedImage("node-22"),
  node24: managedImage("node-24"),
  node26: managedImage("node-26"),
  python313: managedImage("python-al-3.13.1"),
  python314: managedImage("python-3.14"),
  ubuntu: managedImage("ubuntu"),
  arch: managedImage("arch"),
});

const RUNTIME_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  node22: MANAGED_IMAGES.node22,
  node24: MANAGED_IMAGES.node24,
  node26: MANAGED_IMAGES.node26,
  "python3.13": MANAGED_IMAGES.python313,
});

const VERCEL_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  universal: MANAGED_IMAGES.universal,
  "universal:latest": MANAGED_IMAGES.universal,
  "node:22": MANAGED_IMAGES.node22,
  "node:22.23.2": MANAGED_IMAGES.node22,
  "node:24": MANAGED_IMAGES.node24,
  "node:24.19.0": MANAGED_IMAGES.node24,
  "node:26": MANAGED_IMAGES.node26,
  "node:26.7.0": MANAGED_IMAGES.node26,
  "python:3.14": MANAGED_IMAGES.python314,
  "python:al-3.13.1": MANAGED_IMAGES.python313,
  ubuntu: MANAGED_IMAGES.ubuntu,
  "ubuntu:latest": MANAGED_IMAGES.ubuntu,
  arch: MANAGED_IMAGES.arch,
  "arch:latest": MANAGED_IMAGES.arch,
});

export interface SandboxImageSelection {
  runtime?: string;
  image?: string;
}

export function resolveSandboxImage(selection: SandboxImageSelection): string {
  if (selection.image !== undefined && selection.runtime !== undefined) {
    throw new InvalidSandboxOptionsError("Choose either image or runtime, not both.");
  }

  if (selection.runtime !== undefined) {
    const image = RUNTIME_IMAGES[selection.runtime];
    if (image === undefined) {
      throw new InvalidSandboxOptionsError(
        `Unsupported runtime "${selection.runtime}". Use node22, node24, node26, python3.13, or a custom image.`,
      );
    }
    return image;
  }

  if (selection.image === undefined) return MANAGED_IMAGES.universal;
  const image = selection.image.trim();
  if (image.length === 0) {
    throw new InvalidSandboxOptionsError("Sandbox image must not be empty.");
  }

  const unqualified = image.startsWith("vcr.vercel.com/")
    ? image.slice("vcr.vercel.com/".length)
    : image;
  const managedPrefix = "vercel/sandbox/";
  if (!unqualified.startsWith(managedPrefix)) return image;

  const managedName = unqualified.slice(managedPrefix.length);
  const managed = VERCEL_IMAGES[managedName];
  if (managed === undefined) {
    throw new InvalidSandboxOptionsError(
      `Unsupported Vercel managed image "${image}". Use a mirrored managed image or a custom OCI image.`,
    );
  }
  return managed;
}
