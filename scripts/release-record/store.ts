import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReleaseRecord, type ReleaseRecord } from "./schema.js";

export const RELEASES_DIR = "releases";

export function listReleaseRecordDirs(root: string = process.cwd()): string[] {
  const dir = join(root, RELEASES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export interface LoadedRecord {
  readonly dirName: string;
  readonly path: string;
  readonly record?: ReleaseRecord;
  readonly problems: string[];
}

export function loadReleaseRecord(dirName: string, root: string = process.cwd()): LoadedRecord {
  const path = join(root, RELEASES_DIR, dirName, "migration.json");
  if (!existsSync(path)) {
    return { dirName, path, problems: [`${path}: no migration.json in releases/${dirName}/`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { dirName, path, problems: [`${path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`] };
  }
  const { record, problems } = parseReleaseRecord(raw, path);
  return { dirName, path, record, problems };
}

export function loadAllReleaseRecords(root: string = process.cwd()): LoadedRecord[] {
  return listReleaseRecordDirs(root).map((dirName) => loadReleaseRecord(dirName, root));
}
