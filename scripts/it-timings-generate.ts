import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { TIER_TIMINGS_PATH, listTierFiles, readTierTimings, type TierTimings } from "./it-shards.js";

interface JsonReport {
  readonly testResults?: readonly { readonly name?: unknown; readonly status?: unknown; readonly startTime?: unknown; readonly endTime?: unknown }[];
}

export interface TimingsMerge {
  readonly files: Record<string, number>;
  readonly measured: number;
  readonly kept: number;
  readonly dropped: readonly string[];
  readonly unmeasured: readonly string[];
}

export function mergeTimings(reports: readonly unknown[], root: string, tierFiles: readonly string[], previous: TierTimings): TimingsMerge {
  const tier = new Set(tierFiles);
  const measuredMs = new Map<string, number>();
  for (const report of reports) {
    for (const result of (report as JsonReport).testResults ?? []) {
      const { name, status, startTime, endTime } = result;
      if (status === "failed") {
        throw new Error(`${String(name)} failed in this report — a red file's span is not its cost. Regenerate from green runs only.`);
      }
      if (typeof name !== "string" || typeof startTime !== "number" || typeof endTime !== "number" || endTime < startTime) {
        throw new Error(`a report entry has no usable name and times: ${JSON.stringify({ name, startTime, endTime })}`);
      }
      const file = (isAbsolute(name) ? relative(root, name) : name).split(sep).join("/");
      if (!tier.has(file)) continue;
      const ms = Math.round(endTime - startTime);
      measuredMs.set(file, Math.max(ms, measuredMs.get(file) ?? 0));
    }
  }
  const files: Record<string, number> = {};
  let kept = 0;
  for (const file of [...tier].sort()) {
    const ms = measuredMs.get(file) ?? previous.get(file);
    if (ms === undefined) continue;
    if (!measuredMs.has(file)) kept++;
    files[file] = ms;
  }
  return {
    files,
    measured: measuredMs.size,
    kept,
    dropped: [...previous.keys()].filter((file) => !tier.has(file)).sort(),
    unmeasured: [...tier].filter((file) => files[file] === undefined).sort(),
  };
}

export function timingsFileText(files: Record<string, number>): string {
  const doc = {
    _comment:
      "Measured wall milliseconds per integration tier file. scripts/it-shards.ts splits the --shard=k/N fan-out by these (OPE-2344). " +
      "Regenerate with `npm run integration:timings -- <vitest JSON report>...`; never hand-edit.",
    files,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main(): void {
  const reports = process.argv.slice(2).filter((arg) => arg !== "--");
  if (reports.length === 0) {
    console.error("it-timings-generate: usage: npm run integration:timings -- <vitest JSON report>...");
    process.exit(2);
  }
  const root = process.cwd();
  const tierFiles = listTierFiles(root);
  if (tierFiles === undefined) {
    console.error("it-timings-generate: the tier's file list could not be read here. Run it from the repository root.");
    process.exit(1);
  }
  const merge = mergeTimings(
    reports.map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown),
    root,
    tierFiles,
    readTierTimings(root),
  );
  writeFileSync(join(root, TIER_TIMINGS_PATH), timingsFileText(merge.files));
  console.log(
    `it-timings-generate: wrote ${TIER_TIMINGS_PATH} — ${merge.measured} file(s) measured, ${merge.kept} kept from the previous file, ` +
      `${merge.dropped.length} dropped (not in the tier), ${merge.unmeasured.length} with no entry (they weigh the median).`,
  );
  for (const file of merge.unmeasured) console.log(`  no entry: ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
