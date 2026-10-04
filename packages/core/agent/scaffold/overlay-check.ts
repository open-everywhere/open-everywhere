import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  emitGrantsModule,
  emptyGrantsFile,
  parseGrantsModule,
  renormalizeGrantsModule,
} from "../access/grants-codemod.js";
import {
  emitCredentialBindingsModule,
  emptyCredentialBindingsFile,
  parseCredentialBindingsModule,
  renormalizeCredentialBindingsModule,
} from "../access/credential-bindings-codemod.js";
import { emitHooksModule, emptyHooksFile, parseHooksModule, renormalizeHooksModule } from "../webhooks/hooks-codemod.js";
import { emitAgentsModule, emptyAgentsFile, parseAgentsModule, renormalizeAgentsModule } from "../memory/agents-codemod.js";
import { emitGroupsModule, emptyGroupsFile, parseGroupsModule, renormalizeGroupsModule } from "../identity/groups-codemod.js";

export interface OverlaySpec {
  readonly path: string;
  readonly what: string;
  readonly flow: string;
  readonly parseModule: (text: string) => unknown;
  readonly renormalize: (text: string) => string;
  readonly emitEmpty: () => string;
}

export const OVERLAYS: readonly OverlaySpec[] = [
  {
    path: "agent/access/grants.generated.ts",
    what: "grants overlay",
    flow: "request_access (access/grants-codemod.ts)",
    parseModule: parseGrantsModule,
    renormalize: renormalizeGrantsModule,
    emitEmpty: () => emitGrantsModule(emptyGrantsFile()),
  },
  {
    path: "agent/access/credential-bindings.generated.ts",
    what: "credential-bindings overlay",
    flow: "credential binding (access/credential-bindings-codemod.ts)",
    parseModule: parseCredentialBindingsModule,
    renormalize: renormalizeCredentialBindingsModule,
    emitEmpty: () => emitCredentialBindingsModule(emptyCredentialBindingsFile()),
  },
  {
    path: "agent/webhooks/hooks.generated.ts",
    what: "webhook-hooks overlay",
    flow: "declare_webhook (webhooks/hooks-codemod.ts)",
    parseModule: parseHooksModule,
    renormalize: renormalizeHooksModule,
    emitEmpty: () => emitHooksModule(emptyHooksFile()),
  },
  {
    path: "agent/memory/config/agents.generated.ts",
    what: "agents overlay",
    flow: "create_agent (memory/agents-codemod.ts)",
    parseModule: parseAgentsModule,
    renormalize: renormalizeAgentsModule,
    emitEmpty: () => emitAgentsModule(emptyAgentsFile()),
  },
  {
    path: "agent/identity/groups.generated.ts",
    what: "person-groups overlay",
    flow: "directory_groups_plan (identity/groups-codemod.ts)",
    parseModule: parseGroupsModule,
    renormalize: renormalizeGroupsModule,
    emitEmpty: () => emitGroupsModule(emptyGroupsFile()),
  },
];

export interface OverlayCheckResult {
  readonly problems: readonly string[];
  readonly staleHeaders: readonly string[];
  readonly checked: number;
}

export function checkOverlays(root: string, opts: { readonly missing: "problem" | "skip" }): OverlayCheckResult {
  const problems: string[] = [];
  const staleHeaders: string[] = [];
  let checked = 0;
  for (const spec of OVERLAYS) {
    const abs = join(root, spec.path);
    if (!existsSync(abs)) {
      if (opts.missing === "problem") {
        problems.push(`${spec.path} is MISSING — the ${spec.what} loader imports it statically, so its absence breaks the build (${spec.flow})`);
      }
      continue;
    }
    checked++;
    const text = readFileSync(abs, "utf8");
    try {
      spec.parseModule(text);
    } catch (err) {
      problems.push(`${spec.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (spec.renormalize(text) !== text) staleHeaders.push(spec.path);
  }
  return { problems, staleHeaders, checked };
}

export interface OverlayNormalizeResult {
  readonly problems: readonly string[];
  readonly wrote: readonly string[];
}

export function normalizeOverlays(root: string): OverlayNormalizeResult {
  const problems: string[] = [];
  const wrote: string[] = [];
  for (const spec of OVERLAYS) {
    const abs = join(root, spec.path);
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, spec.emitEmpty());
      wrote.push(spec.path);
      continue;
    }
    const text = readFileSync(abs, "utf8");
    let next: string;
    try {
      next = spec.renormalize(text);
    } catch (err) {
      problems.push(`${spec.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (next !== text) {
      writeFileSync(abs, next);
      wrote.push(spec.path);
    }
  }
  return { problems, wrote };
}
