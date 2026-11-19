// Which version this copy is and whether it is the factory right now, beside
// the boot phase readiness.ts reports. The role controller writes it; the
// routes read it.

export type ServiceRole = "current" | "draining";

let version: string | undefined;
let role: ServiceRole | undefined;
let current: string | null = null;

export function setDeploymentVersion(next: string): void {
  version = next;
}

/** This copy's deployment version, once the service has pinned it. */
export function deploymentVersion(): string | undefined {
  return version;
}

export function setServiceRole(next: ServiceRole, currentVersion: string | null): void {
  role = next;
  current = currentVersion;
}

/** This copy's role, or undefined until the current version has been read. */
export function serviceRole(): ServiceRole | undefined {
  return role;
}

/** The factory's current version as this copy last read it. */
export function currentVersion(): string | null {
  return current;
}

/** Test seam. */
export function resetRoleState(): void {
  version = undefined;
  role = undefined;
  current = null;
}
