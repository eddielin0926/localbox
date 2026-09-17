import { MANAGED_IMAGE_REGISTRY } from "../runtime/index.js";

export interface ManagedFilesystemPrivilegeBridge {
  readonly sudoPath: string;
  readonly nodePath: string;
}

const MANAGED_FILESYSTEM_PRIVILEGE_BRIDGE = Object.freeze({
  sudoPath: "/usr/bin/sudo",
  nodePath: "/usr/local/bin/node",
}) satisfies ManagedFilesystemPrivilegeBridge;

export function managedFilesystemPrivilegeBridge(
  image: string,
): ManagedFilesystemPrivilegeBridge | null {
  return image.startsWith(`${MANAGED_IMAGE_REGISTRY}/`)
    ? MANAGED_FILESYSTEM_PRIVILEGE_BRIDGE
    : null;
}
