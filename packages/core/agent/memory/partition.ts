import { bindFrom, type BindableContext, type SurfaceBinding } from "../identity/binding.js";

export interface Partition {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly workspaceKey: string;
  readonly surfaceKey: string;
  readonly domainKey?: string;
  readonly key: string;
}

export function domainKeyOf(p: Pick<Partition, "domainKey" | "surfaceKey">): string {
  return p.domainKey ?? p.surfaceKey;
}

export function resolvePartition(ctx: BindableContext): Partition {
  return partitionOfBinding(bindFrom(ctx));
}

export function partitionOfBinding(b: SurfaceBinding): Partition {
  const workspaceKey = `${b.platform}/${b.workspace}`;
  const surfaceKey = `${workspaceKey}/${b.surface}`;
  return {
    org: b.org,
    platform: b.platform,
    workspace: b.workspace,
    surface: b.surface,
    workspaceKey,
    surfaceKey,
    domainKey: `${workspaceKey}/${b.domainSurface ?? b.surface}`,
    key: surfaceKey,
  };
}

export function controlPartition(org: string): Partition {
  return {
    org,
    platform: "control",
    workspace: "control",
    surface: "control",
    workspaceKey: "control/control",
    surfaceKey: "control/control/control",
    key: "control/control/control",
  };
}
