import { MANAGED_FILESYSTEM_PRIVILEGE_BRIDGE } from "../runtime/internal-filesystem-bridge.js";
import { MANAGED_IMAGE_REGISTRY } from "../runtime/index.js";

export type ManagedFilesystemPrivilegeBridge =
  typeof MANAGED_FILESYSTEM_PRIVILEGE_BRIDGE;

export function managedFilesystemPrivilegeBridge(
  image: string,
): ManagedFilesystemPrivilegeBridge | null {
  return image.startsWith(`${MANAGED_IMAGE_REGISTRY}:`)
    ? MANAGED_FILESYSTEM_PRIVILEGE_BRIDGE
    : null;
}
