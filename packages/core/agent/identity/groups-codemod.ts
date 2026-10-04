import { overlayModuleHeader, sameOverlayModuleAfterHeader, unwrapOverlayModule, wrapOverlayModule, type OverlayModuleGrammar } from "../access/overlay-module.js";
import { DIRECTORY_GROUP_PREFIX, isDirectoryGroupName, type Group } from "./groups.js";

export interface GroupsFile {
  readonly groups: readonly Group[];
}

export class GroupsCodemodError extends Error {}

export function emptyGroupsFile(): GroupsFile {
  return { groups: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseGroupsFile(value: unknown): GroupsFile {
  if (!isRecord(value)) throw new GroupsCodemodError("groups overlay must be a JSON object with a `groups` array");
  const keys = Object.keys(value).filter((k) => k !== "$comment");
  const unknown = keys.filter((k) => k !== "groups");
  if (unknown.length > 0) throw new GroupsCodemodError(`groups overlay has unknown top-level key(s): ${unknown.join(", ")}`);
  if (!Array.isArray(value.groups)) throw new GroupsCodemodError("groups overlay needs a `groups` array (use [] when empty)");

  const groups: Group[] = [];
  for (const g of value.groups) {
    if (!isRecord(g) || typeof g.name !== "string" || !isDirectoryGroupName(g.name)) {
      throw new GroupsCodemodError(
        `every overlay group needs a "${DIRECTORY_GROUP_PREFIX}"-prefixed name (got: ${JSON.stringify(isRecord(g) ? g.name : g)}) — that namespace is what keeps synced groups from colliding with hand-written ones`,
      );
    }
    for (const k of Object.keys(g)) {
      if (!["name", "title", "members"].includes(k)) {
        throw new GroupsCodemodError(`overlay group "${g.name}" has field "${k}" — the overlay carries only name/title/members; put anything else in a hand-written group`);
      }
    }
    if (g.title !== undefined && typeof g.title !== "string") throw new GroupsCodemodError(`overlay group "${g.name}" title must be a string`);
    if (!Array.isArray(g.members)) throw new GroupsCodemodError(`overlay group "${g.name}" members must be an array`);
    for (const m of g.members) {
      if (!isRecord(m) || typeof m.linkSet !== "string" || m.linkSet.length === 0 || Object.keys(m).length !== 1) {
        throw new GroupsCodemodError(`overlay group "${g.name}" has a member that is not a { linkSet: "<id>" } reference — the overlay never writes bare principal keys`);
      }
    }
    groups.push(g as unknown as Group);
  }
  return { groups };
}

const GROUP_KEYS = ["name", "title", "members"];

function orderKeys(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out)) out[k] = obj[k];
  return out;
}

function canonicalGroup(g: Group): Record<string, unknown> {
  const members = [...g.members]
    .map((m) => (typeof m === "string" ? m : m.linkSet))
    .sort()
    .map((linkSet) => ({ linkSet }));
  return orderKeys({ ...g, members }, GROUP_KEYS);
}

export function stringifyGroups(file: GroupsFile): string {
  const groups = [...file.groups].sort((a, b) => a.name.localeCompare(b.name)).map(canonicalGroup);
  return JSON.stringify({ groups }, null, 2) + "\n";
}

const GROUPS_MODULE: OverlayModuleGrammar = {
  what: "person-groups overlay",
  header: overlayModuleHeader("person-groups overlay", "@open-everywhere/core/agent/identity/groups-codemod.js"),
  typeImport: 'import type { GroupsFile } from "@open-everywhere/core/agent/identity/groups-codemod.js";',
  typeName: "GroupsFile",
};

export function emitGroupsModule(file: GroupsFile): string {
  return wrapOverlayModule(GROUPS_MODULE, stringifyGroups(file));
}

export function parseGroupsModule(text: string): GroupsFile {
  const file = parseGroupsFile(unwrapOverlayModule(GROUPS_MODULE, text, (m) => new GroupsCodemodError(m)));
  if (!sameOverlayModuleAfterHeader(emitGroupsModule(file), text)) {
    throw new GroupsCodemodError(
      "person-groups overlay is not in canonical form — re-emitting its own data does not reproduce the file below its header, so it has been hand-edited. Run `npx oe overlays normalize` and commit the result (the codemod refuses to rewrite a file it did not write).",
    );
  }
  return file;
}

export function renormalizeGroupsModule(text: string): string {
  return emitGroupsModule(parseGroupsFile(unwrapOverlayModule(GROUPS_MODULE, text, (m) => new GroupsCodemodError(m))));
}

export function directoryGroupsOf(groups: readonly Group[]): GroupsFile {
  return { groups: groups.filter((g) => isDirectoryGroupName(g.name)) };
}
