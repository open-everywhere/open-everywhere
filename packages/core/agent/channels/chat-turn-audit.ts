import type { Partition } from "../memory/partition.js";

export type ChatAuditPartition = Pick<Partition, "org" | "platform" | "workspace" | "surface">;
