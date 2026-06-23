export interface Domain {
  readonly workspace: string;
  readonly name: string;
  readonly surfaces: readonly string[];
}

export function defineDomain(d: Domain): Domain {
  return d;
}

const domains: Domain[] = [
];

export function loadDomains(): readonly Domain[] {
  return domains;
}

export function domainsForSurface(
  p: { workspaceKey: string; surface: string },
  list: readonly Domain[] = loadDomains(),
): string[] {
  return list
    .filter((d) => d.workspace === p.workspaceKey && d.surfaces.includes(p.surface))
    .map((d) => d.name);
}
