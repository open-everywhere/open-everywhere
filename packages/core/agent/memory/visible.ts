import { createHash } from "node:crypto";
import { getConfig } from "../access/config.js";
import { appendAudit } from "../audit/audit.js";
import { bulletSha256 } from "./purge-redaction.js";
import { restoreProvenanceCarriers } from "./provenance-mark.js";
import { dbProviderId, providerById } from "./provider.js";
import { memoryRefs, type Domain } from "./domain.js";
import { siloAccess } from "./resolve.js";
import { SURFACE, siloTier, tierId, type MemoryFiles } from "./store.js";
import { writeMemoryTier } from "./write-road.js";
import { executeMemoryPurge } from "../approvals/memory-purge.js";
import type { Partition } from "./partition.js";

const PERSONAL_SILO_NAME = "@personal";

const MEMORY_EXPORT_ACTION = "memory.export";

const MEMORY_EDIT_MAX_CHARS = 1_000;

export interface MemoryItem {
  readonly text: string;
  readonly section?: string;
  readonly files: readonly string[];
  readonly sha256: string;
  readonly chars: number;
}

const PLACEHOLDERS: ReadonlySet<string> = new Set(["(none yet)"]);

function fileOrder(files: MemoryFiles): string[] {
  return Object.keys(files).sort((a, b) => {
    const ai = a === "MEMORY.md" ? 0 : 1;
    const bi = b === "MEMORY.md" ? 0 : 1;
    return ai !== bi ? ai - bi : a.localeCompare(b);
  });
}

export function memoryItemsOf(files: MemoryFiles): MemoryItem[] {
  const bySha = new Map<string, { text: string; section?: string; files: string[]; chars: number }>();
  const order: string[] = [];
  for (const file of fileOrder(files)) {
    const content = files[file];
    if (typeof content !== "string") continue;
    let section: string | undefined;
    for (const raw of content.split("\n")) {
      const heading = /^##\s+(.+?)\s*$/.exec(raw);
      if (heading) {
        section = heading[1];
        continue;
      }
      const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
      if (!bullet) continue;
      const text = bullet[1]!;
      if (PLACEHOLDERS.has(text) || text.startsWith("_Full history")) continue;
      const line = raw.replace(/[ \t]+$/, "");
      const sha = bulletSha256(line);
      const seen = bySha.get(sha);
      if (seen) {
        if (!seen.files.includes(file)) seen.files.push(file);
        continue;
      }
      bySha.set(sha, { text, ...(section ? { section } : {}), files: [file], chars: line.length });
      order.push(sha);
    }
  }
  return order.map((sha256) => {
    const v = bySha.get(sha256)!;
    return { text: v.text, ...(v.section ? { section: v.section } : {}), files: v.files, sha256, chars: v.chars };
  });
}

export function isLineDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function personalProvider() {
  return providerById(dbProviderId());
}

export async function readPersonalMemory(partition: Partition): Promise<{ readonly files: MemoryFiles; readonly items: readonly MemoryItem[] }> {
  const files = await personalProvider().readTier(partition, SURFACE);
  return { files, items: memoryItemsOf(files) };
}

export type MemorySelfServiceVia = "slack-app-home";

export type ForgetOutcome =
  | { readonly kind: "forgotten"; readonly removedLines: number; readonly files: readonly string[] }
  | { readonly kind: "gone" };

export async function forgetPersonalMemoryItem(input: {
  readonly partition: Partition;
  readonly sha256: string;
  readonly principalId: string;
  readonly via: MemorySelfServiceVia;
}): Promise<ForgetOutcome> {
  if (!isLineDigest(input.sha256)) return { kind: "gone" };
  const { items } = await readPersonalMemory(input.partition);
  const item = items.find((i) => i.sha256 === input.sha256);
  if (!item) return { kind: "gone" };
  const result = await executeMemoryPurge(
    {
      org: input.partition.org,
      partition: input.partition,
      bullets: [{ sha256: item.sha256, chars: item.chars }],
      locations: item.files.map((file) => ({ siloName: PERSONAL_SILO_NAME, provider: dbProviderId(), tierId: tierId(SURFACE), file })),
    },
    input.principalId,
    { via: input.via },
  );
  return result.removedLines > 0 ? { kind: "forgotten", removedLines: result.removedLines, files: result.removedFrom } : { kind: "gone" };
}

export type EditOutcome =
  | { readonly kind: "edited"; readonly files: readonly string[] }
  | { readonly kind: "unchanged" }
  | { readonly kind: "gone" }
  | { readonly kind: "refused"; readonly reason: string };

export function editRefusal(text: string): string | undefined {
  const t = text.trim();
  if (t.length === 0) return "A fact cannot be blank. To remove it, choose Forget instead.";
  if (/[\r\n]/.test(t)) return "A fact is one line. Remove the line breaks and save again.";
  if (t.length > MEMORY_EDIT_MAX_CHARS) return `A fact is at most ${MEMORY_EDIT_MAX_CHARS} characters. Shorten it and save again.`;
  return undefined;
}

export function replaceBulletLine(content: string, sha256: string, text: string): { content: string; replaced: number; line?: string } {
  let replaced = 0;
  let line: string | undefined;
  const out = content.split("\n").map((raw) => {
    if (bulletSha256(raw.replace(/[ \t]+$/, "")) !== sha256) return raw;
    const marker = /^(\s*[-*]\s+)/.exec(raw);
    if (!marker) return raw;
    replaced++;
    line ??= marker[1] + text;
    return marker[1] + text;
  });
  return { content: out.join("\n"), replaced, ...(line === undefined ? {} : { line }) };
}

export async function editPersonalMemoryItem(input: {
  readonly partition: Partition;
  readonly sha256: string;
  readonly text: string;
  readonly principalId: string;
  readonly via: MemorySelfServiceVia;
}): Promise<EditOutcome> {
  const refusal = editRefusal(input.text);
  if (refusal) return { kind: "refused", reason: refusal };
  if (!isLineDigest(input.sha256)) return { kind: "gone" };
  const provider = personalProvider();
  const files = await provider.readTier(input.partition, SURFACE);
  const item = memoryItemsOf(files).find((i) => i.sha256 === input.sha256);
  if (!item) return { kind: "gone" };
  const text = restoreProvenanceCarriers(input.text.trim(), item.text);
  if (item.text === text) return { kind: "unchanged" };

  const next: MemoryFiles = { ...files };
  const changed: string[] = [];
  let afterLine: string | undefined;
  for (const file of item.files) {
    const r = replaceBulletLine(files[file] ?? "", item.sha256, text);
    if (r.replaced === 0) continue;
    next[file] = r.content;
    changed.push(file);
    afterLine ??= r.line;
  }
  if (changed.length === 0) return { kind: "gone" };
  const after = afterLine ?? `- ${text}`;
  const { changed: wrote } = await writeMemoryTier({
    provider,
    partition: input.partition,
    tier: SURFACE,
    files: next,
    message: `self-edit [${tierId(SURFACE)}]: ${item.sha256.slice(0, 12)} → ${bulletSha256(after).slice(0, 12)}`,
    silo: { name: PERSONAL_SILO_NAME, provider: provider.id },
    road: "self-edit",
    principalId: input.principalId,
    extra: {
      via: input.via,
      edited: { from: { sha256: item.sha256, chars: item.chars }, to: { sha256: bulletSha256(after), chars: after.length } },
    },
  });
  return wrote ? { kind: "edited", files: changed } : { kind: "unchanged" };
}

export async function exportPersonalMemory(input: {
  readonly partition: Partition;
  readonly principalId: string;
  readonly via: MemorySelfServiceVia;
  readonly title: string;
  readonly nowIso: string;
}): Promise<{ readonly markdown: string; readonly items: number }> {
  const { files, items } = await readPersonalMemory(input.partition);
  const markdown = renderMemoryFilesMarkdown(input.title, files, input.nowIso);
  await appendAudit({
    org: input.partition.org,
    platform: input.partition.platform,
    workspace: input.partition.workspace,
    surface: input.partition.surface,
    principalId: input.principalId,
    action: MEMORY_EXPORT_ACTION,
    detail: {
      via: input.via,
      silo: PERSONAL_SILO_NAME,
      items: items.length,
      chars: markdown.length,
      sha256: createHash("sha256").update(markdown).digest("hex"),
    },
  }).catch(() => undefined);
  return { markdown, items: items.length };
}

export interface MemoryGroup {
  readonly heading: string;
  readonly items: readonly MemoryItem[];
  readonly unavailable?: boolean;
}

export async function readDomainMemory(org: string, domain: Domain): Promise<readonly MemoryGroup[]> {
  const cfg = getConfig();
  const silos = cfg.loadSilos();
  const domains = cfg.loadDomains();
  const groups: MemoryGroup[] = [];
  for (const name of memoryRefs(domain)) {
    const silo = silos.find((s) => s.name === name);
    if (!silo) continue;
    try {
      const files = await providerById(silo.provider).readTier(siloPartition(org), siloTier(silo.name), silo, siloAccess(silo.name, domains));
      groups.push({ heading: silo.description ? `${silo.name} — ${silo.description}` : silo.name, items: memoryItemsOf(files) });
    } catch (err) {
      console.log(`[open-everywhere:memory-view] silo "${name}" could not be read for domain "${domain.name}": ${String(err)}`);
      groups.push({ heading: silo.name, items: [], unavailable: true });
    }
  }
  return groups;
}

function siloPartition(org: string): Partition {
  return {
    org,
    platform: "memory-view",
    workspace: "memory-view",
    surface: "memory-view",
    workspaceKey: "memory-view/memory-view",
    surfaceKey: "memory-view/memory-view/memory-view",
    key: "memory-view/memory-view/memory-view",
  };
}

export function domainsNamingSilo(siloName: string, domains: readonly Domain[]): Domain[] {
  return domains.filter((d) => d.match === undefined && memoryRefs(d).includes(siloName));
}

function renderMemoryFilesMarkdown(title: string, files: MemoryFiles, nowIso: string): string {
  const lines: string[] = [`# ${title}`, "", `_Exported ${nowIso.slice(0, 16).replace("T", " ")} UTC. Each section below is one memory file, exactly as stored._`, ""];
  const names = fileOrder(files);
  if (names.length === 0) lines.push("_Nothing remembered yet._", "");
  for (const name of names) lines.push(`## File: ${name}`, "", "```markdown", (files[name] ?? "").replace(/```/g, "ˋˋˋ").trimEnd(), "```", "");
  return lines.join("\n").trimEnd() + "\n";
}

export function renderMemoryMarkdown(title: string, groups: readonly MemoryGroup[], nowIso: string): string {
  const lines: string[] = [`# ${title}`, "", `_Updated ${nowIso.slice(0, 16).replace("T", " ")} UTC._`, ""];
  for (const g of groups) {
    lines.push(`## ${g.heading}`, "");
    if (g.unavailable) {
      lines.push("_This memory could not be read just now. It is not empty — it is unavailable._", "");
      continue;
    }
    if (g.items.length === 0) {
      lines.push("_Nothing remembered yet._", "");
      continue;
    }
    let section: string | undefined;
    for (const item of g.items) {
      if (item.section !== section) {
        section = item.section;
        if (section) lines.push(`### ${section}`);
      }
      lines.push(`- ${item.text}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
