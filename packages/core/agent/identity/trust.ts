let vouched: ReadonlySet<string> = new Set();

export function registerTrustedSurfaces(keys: Iterable<string>): void {
  vouched = new Set(keys);
}

export function _resetTrustedSurfacesForTest(): void {
  vouched = new Set();
}

export function isVouchedInternal(workspaceKey: string, surfaceKey: string): boolean {
  return vouched.has(workspaceKey) || vouched.has(surfaceKey);
}

export function isVouchedSurface(surfaceKey: string): boolean {
  return vouched.has(surfaceKey);
}

export function vouchedSurfaces(): string[] {
  return [...vouched];
}
