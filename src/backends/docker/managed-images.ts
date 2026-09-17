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
