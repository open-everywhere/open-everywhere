import { removeBulletLineWhere, sectionTitleOfBullet, supersedeUnderSection } from "../markdown.js";
import type { MemoryFiles } from "../store.js";
import type { MemoryOp } from "./ops.js";

export type SupersedeDeclineReason =
  | "wrong-kind"
  | "malformed-op"
  | "missing-file"
  | "outdated-bullet-gone"
  | "current-bullet-gone"
  | "no-section";

export type SupersedeApplyResult =
  | { readonly applied: true; readonly files: MemoryFiles; readonly superseded: string }
  | { readonly applied: false; readonly reason: SupersedeDeclineReason };

export function applySupersedeOp(files: MemoryFiles, op: MemoryOp): SupersedeApplyResult {
  if (op.kind !== "supersede") return { applied: false, reason: "wrong-kind" };

  const pair = op.before?.split("\n") ?? [];
  const survivor = op.after;
  if (pair.length !== 2 || survivor === undefined || survivor.trim().length === 0) {
    return { applied: false, reason: "malformed-op" };
  }
  const [outdatedRaw, currentRaw] = pair;
  const outdated = outdatedRaw.replace(/[ \t]+$/, "");
  const current = currentRaw.replace(/[ \t]+$/, "");

  const content = files[op.file];
  if (content === undefined) return { applied: false, reason: "missing-file" };

  const lines = content.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  if (!lines.includes(outdated)) return { applied: false, reason: "outdated-bullet-gone" };
  if (!lines.includes(current)) return { applied: false, reason: "current-bullet-gone" };

  const section = sectionTitleOfBullet(content, outdated);
  if (section === null) return { applied: false, reason: "no-section" };

  const withoutCurrent = removeBulletLineWhere(content, (line) => line === current);
  if (!withoutCurrent.removed) return { applied: false, reason: "current-bullet-gone" };

  const replaced = supersedeUnderSection(withoutCurrent.content, section, survivor, (existing) => existing === outdated);
  if (replaced.superseded === null) return { applied: false, reason: "outdated-bullet-gone" };

  return { applied: true, files: { ...files, [op.file]: replaced.content }, superseded: replaced.superseded };
}
