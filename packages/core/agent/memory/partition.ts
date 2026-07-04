import { bindFrom, type BindableContext } from "../identity/binding.js";

export interface Partition {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly workspaceKey: string;
  readonly surfaceKey: string;
  readonly key: string;
}

export function resolvePartition(ctx: BindableContext): Partition {
  const b = bindFrom(ctx);
  const workspaceKey = `${b.platform}/${b.workspace}`;
  const surfaceKey = `${workspaceKey}/${b.surface}`;
  return {
    org: b.org,
    platform: b.platform,
    workspace: b.workspace,
    surface: b.surface,
    workspaceKey,
    surfaceKey,
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
