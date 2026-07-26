import type { Partition } from "../memory/partition.js";
import type { Routine } from "./routine.js";

export function routinePartition(r: Pick<Routine, "org" | "surfaceKey">): Partition {
  const [platform = "", workspace = "", ...rest] = r.surfaceKey.split("/");
  const workspaceKey = `${platform}/${workspace}`;
  return {
    org: r.org,
    platform,
    workspace,
    surface: rest.join("/"),
    workspaceKey,
    surfaceKey: r.surfaceKey,
    key: r.surfaceKey,
  };
}
