import type { WebhookHook } from "./config.js";
import type { ReadableBy } from "../access/read-grant.js";
import { overlayModuleHeader, sameOverlayModuleAfterHeader, unwrapOverlayModule, wrapOverlayModule, type OverlayModuleGrammar } from "../access/overlay-module.js";

export interface HooksFile {
  readonly hooks: readonly WebhookHook[];
}

export class HooksCodemodError extends Error {}

export function emptyHooksFile(): HooksFile {
  return { hooks: [] };
}

export type HookDeclaration = WebhookHook;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringOrStringArray(v: unknown): boolean {
  return typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
}

function isScopeArray(v: unknown): v is ReadableBy {
  return Array.isArray(v) && v.length > 0 && v.every((x) => isRecord(x) && typeof x.level === "string");
}

export function parseHooksFile(value: unknown): HooksFile {
  if (!isRecord(value)) throw new HooksCodemodError("hooks overlay must be a JSON object with a `hooks` array");
  const keys = Object.keys(value).filter((k) => k !== "$comment");
  const unknown = keys.filter((k) => k !== "hooks");
  if (unknown.length > 0) throw new HooksCodemodError(`hooks overlay has unknown top-level key(s): ${unknown.join(", ")}`);
  if (!Array.isArray(value.hooks)) throw new HooksCodemodError("hooks overlay needs a `hooks` array (use [] when empty)");

  const hooks: WebhookHook[] = [];
  for (const h of value.hooks) {
    if (!isRecord(h) || typeof h.id !== "string" || !h.id) throw new HooksCodemodError("every overlay hook needs a string `id`");
    for (const k of Object.keys(h)) {
      if (!HOOK_KEYS.includes(k)) {
        throw new HooksCodemodError(`overlay hook "${h.id}" has unknown field "${k}" — the overlay carries exactly the declared webhook vocabulary (${HOOK_KEYS.join(", ")})`);
      }
    }
    if (typeof h.source !== "string" || !h.source) throw new HooksCodemodError(`overlay hook "${h.id}" needs a string \`source\` (the signature scheme)`);
    if (!isStringOrStringArray(h.secretRef)) throw new HooksCodemodError(`overlay hook "${h.id}" needs \`secretRef\` (a ref or an ordered list of refs — never a value)`);
    if (typeof h.broker !== "string" || !h.broker) throw new HooksCodemodError(`overlay hook "${h.id}" needs a string \`broker\``);
    if (h.target !== undefined && (typeof h.target !== "string" || !h.target)) {
      throw new HooksCodemodError(`overlay hook "${h.id}" has a non-string \`target\` — omit it entirely to declare an emit-only hook`);
    }
    if (h.instruction !== undefined && (typeof h.instruction !== "string" || !h.instruction)) {
      throw new HooksCodemodError(`overlay hook "${h.id}" has a non-string \`instruction\` — omit it entirely to declare an emit-only hook`);
    }
    if (!isScopeArray(h.readableBy)) {
      throw new HooksCodemodError(`overlay hook "${h.id}" needs a non-empty \`readableBy\` array — who may read this hook's events is required and has no default`);
    }
    if (h.posture !== undefined && typeof h.posture !== "string") {
      throw new HooksCodemodError(`overlay hook "${h.id}" has a non-string \`posture\` — it names how much of the payload may reach the model`);
    }
    if (h.project !== undefined && !(Array.isArray(h.project) && h.project.every((k) => typeof k === "string"))) {
      throw new HooksCodemodError(`overlay hook "${h.id}" has a malformed \`project\` — it is a list of normalizer field-key names`);
    }
    if (h.authFloor !== undefined && typeof h.authFloor !== "string") {
      throw new HooksCodemodError(`overlay hook "${h.id}" has a non-string \`authFloor\` — it names the weakest acceptance this hook will take`);
    }
    hooks.push(h as unknown as WebhookHook);
  }
  return { hooks };
}

const HOOK_KEYS = ["id", "source", "secretRef", "broker", "authFloor", "target", "readableBy", "posture", "project", "instruction"];
const SCOPE_KEYS = ["level", "tenant", "domain", "surface", "principal"];

function orderKeys(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out)) out[k] = obj[k];
  return out;
}

function canonicalHook(h: WebhookHook): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...h };
  obj.readableBy = [...h.readableBy]
    .map((s) => orderKeys({ ...s } as Record<string, unknown>, SCOPE_KEYS))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return orderKeys(obj, HOOK_KEYS);
}

export function stringifyHooks(file: HooksFile): string {
  const hooks = [...file.hooks].sort((a, b) => a.id.localeCompare(b.id)).map(canonicalHook);
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

const HOOKS_MODULE: OverlayModuleGrammar = {
  what: "hooks overlay",
  header: overlayModuleHeader("webhook-hooks overlay", "@open-everywhere/core/agent/webhooks/hooks-codemod.js"),
  typeImport: 'import type { HooksFile } from "@open-everywhere/core/agent/webhooks/hooks-codemod.js";',
  typeName: "HooksFile",
};

export function emitHooksModule(file: HooksFile): string {
  return wrapOverlayModule(HOOKS_MODULE, stringifyHooks(file));
}

export function parseHooksModule(text: string): HooksFile {
  const file = parseHooksFile(unwrapOverlayModule(HOOKS_MODULE, text, (m) => new HooksCodemodError(m)));
  if (!sameOverlayModuleAfterHeader(emitHooksModule(file), text)) {
    throw new HooksCodemodError(
      "hooks overlay is not in canonical form — re-emitting its own data does not reproduce the file below its header, so it has been hand-edited. Run `npx oe overlays normalize` and commit the result (the codemod refuses to rewrite a file it did not write).",
    );
  }
  return file;
}

export function renormalizeHooksModule(text: string): string {
  return emitHooksModule(parseHooksFile(unwrapOverlayModule(HOOKS_MODULE, text, (m) => new HooksCodemodError(m))));
}

export interface ApplyHookResult {
  readonly hooks: HooksFile;
  readonly changed: boolean;
}

export function applyHookDeclaration(file: HooksFile, decl: HookDeclaration, baseIds: readonly string[] = []): ApplyHookResult {
  if (baseIds.includes(decl.id)) {
    throw new HooksCodemodError(
      `a webhook "${decl.id}" is already declared in code (agent/webhooks/hooks.ts) — the overlay cannot edit it, and two hooks with one id is a boot failure. Pick a different id, or edit the code declaration directly in a PR.`,
    );
  }
  const existing = file.hooks.find((h) => h.id === decl.id);
  if (existing) {
    if (JSON.stringify(canonicalHook(existing)) === JSON.stringify(canonicalHook(decl))) {
      return { hooks: file, changed: false };
    }
    throw new HooksCodemodError(
      `a webhook "${decl.id}" is already declared in the overlay with different settings — this codemod only ADDS. Changing a live hook redirects an already-authenticated sender, so it is an edit a human makes in the file (and reviews as its own PR), not something a chat request performs. Pick a new id, or edit agent/webhooks/hooks.generated.ts by hand and run \`npx oe overlays normalize\` (the file is machine-owned, so an un-normalised edit fails \`npx oe build --check\`).`,
    );
  }
  return { hooks: { hooks: [...file.hooks, decl] }, changed: true };
}
