import { createHash } from "node:crypto";
import { removeBulletLineWhere } from "./markdown.js";

export function bulletSha256(bullet: string): string {
  return createHash("sha256").update(bullet.replace(/[ \t]+$/, "")).digest("hex");
}

export function redactedBulletLabel(sha256: string, chars?: number): string {
  const size = typeof chars === "number" && chars > 0 ? `, ${chars} chars` : "";
  return `(content redacted — sha256 ${sha256.slice(0, 12)}…${size})`;
}

function lineMatchesDigest(line: string, wanted: ReadonlySet<string>): boolean {
  if (wanted.has(bulletSha256(line))) return true;
  const trimmed = line.trim();
  return trimmed !== line && wanted.has(bulletSha256(trimmed));
}

export function removeBulletLineBySha(content: string, sha256: string): { content: string; removed: boolean } {
  const wanted = new Set([sha256]);
  return removeBulletLineWhere(content, (line) => lineMatchesDigest(line, wanted));
}

export function removeBulletLinesBySha(content: string, sha256s: readonly string[]): { content: string; removed: number } {
  const wanted = new Set(sha256s);
  let out = content;
  let removed = 0;
  for (;;) {
    const next = removeBulletLineWhere(out, (line) => lineMatchesDigest(line, wanted));
    if (!next.removed) break;
    out = next.content;
    removed++;
  }
  return { content: out, removed };
}

export function removedLineDigests(host: string, next: string): readonly { sha256: string; chars: number }[] {
  if (typeof host !== "string" || typeof next !== "string") return [];
  const kept = new Set(
    next
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  const seen = new Set<string>();
  const out: { sha256: string; chars: number }[] = [];
  for (const raw of host.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || kept.has(line)) continue;
    const sha256 = bulletSha256(line);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    out.push({ sha256, chars: line.length });
  }
  return out;
}
