import { relative, sep } from "node:path";

import { BaseSequencer, type TestSpecification } from "vitest/node";

import { readTierTimings, shardFiles } from "./it-shards.js";

export class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (shard === undefined) return files;
    const byFile = new Map<string, TestSpecification[]>();
    for (const spec of files) {
      const key = relative(root, spec.moduleId).split(sep).join("/");
      byFile.set(key, [...(byFile.get(key) ?? []), spec]);
    }
    return shardFiles([...byFile.keys()], shard.index, shard.count, readTierTimings(root)).flatMap((file) => byFile.get(file)!);
  }
}
