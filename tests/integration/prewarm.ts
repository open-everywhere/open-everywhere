import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { reserveEphemeralPort } from "../../scripts/ephemeral-port.js";
import { justBashTemplateDir } from "./prepare-cache.js";

export type PrewarmVia = "built-bundle" | "authored-source";

export interface PrewarmResult {
  readonly via: PrewarmVia;
  readonly seconds: number;
}

const PREWARM_STATE_ENV = ["OE_PGLITE_DIR", "OE_MEMORY_DIR"] as const;

const PREWARM_MODEL_ENV = "NODE_ENV";

async function pinListenerEnvForPrewarm(reserved: { readonly port: number; readonly release: () => Promise<void> }): Promise<() => void> {
  const names = ["PORT", "NITRO_PORT", "HOST", "NITRO_HOST"] as const;
  const before = names.map((k) => [k, process.env[k]] as const);
  process.env.PORT = String(reserved.port);
  process.env.NITRO_PORT = String(reserved.port);
  process.env.HOST = "127.0.0.1";
  process.env.NITRO_HOST = "127.0.0.1";
  await reserved.release();
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function pinStateEnvForPrewarm(state: string): () => void {
  const before = [...PREWARM_STATE_ENV, PREWARM_MODEL_ENV].map((k) => [k, process.env[k]] as const);
  process.env.OE_PGLITE_DIR ??= join(state, "pglite");
  process.env.OE_MEMORY_DIR ??= join(state, "memory");
  delete process.env[PREWARM_MODEL_ENV];
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function importEveDist(root: string, relative: string): Promise<Record<string, unknown> | undefined> {
  const path = join(root, "node_modules", "eve", "dist", "src", relative);
  if (!existsSync(path)) return undefined;
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

export async function loadFastPathSymbols(
  root: string,
): Promise<{ ok: true; symbols: Record<string, (input: never) => unknown> } | { ok: false; missing: string }> {
  const wanted: readonly { readonly module: string; readonly name: string }[] = [
    { module: "runtime/loaders/bundled-artifacts.js", name: "readBundledCompiledArtifacts" },
    { module: "runtime/resolve-agent-graph.js", name: "resolveRuntimeAgentGraph" },
  ];
  const symbols: Record<string, (input: never) => unknown> = {};
  for (const { module, name } of wanted) {
    const mod = await importEveDist(root, module);
    if (mod === undefined) return { ok: false, missing: `eve/dist/src/${module} (the whole module)` };
    const value = mod[name];
    if (typeof value !== "function") return { ok: false, missing: `${name} from eve/dist/src/${module}` };
    symbols[name] = value as (input: never) => unknown;
  }
  return { ok: true, symbols };
}

type PrewarmAppSandboxes = (input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource?: unknown;
  readonly loadAgentGraph?: (input: never) => Promise<unknown>;
  readonly log?: (message: string) => void;
}) => Promise<void>;

async function loadPrewarmAppSandboxes(root: string): Promise<PrewarmAppSandboxes> {
  const module = "execution/sandbox/prewarm.js";
  const mod = await importEveDist(root, module);
  if (mod === undefined) {
    throw new Error(
      `integration prepare: eve's sandbox prewarm module is gone from eve/dist/src/${module} — an eve bump moved it. ` +
        "Find the new home of prewarmAppSandboxes under eve/dist and update tests/integration/prewarm.ts " +
        "(and the eve-upgrade-check skill's checklist).",
    );
  }
  if (typeof mod.prewarmAppSandboxes !== "function") {
    throw new Error(
      `integration prepare: eve/dist/src/${module} no longer exports prewarmAppSandboxes — an eve bump renamed it. ` +
        "It is the ONLY prewarm export eve 0.69.0 ships (prewarmSandboxes went module-private and " +
        "prewarmBuiltAppSandboxes was removed), so there is no second road left to take. Update " +
        "tests/integration/prewarm.ts to the new export.",
    );
  }
  return mod.prewarmAppSandboxes as PrewarmAppSandboxes;
}

export function builtTreeArtifactsSource(root: string): { readonly appRoot: string; readonly kind: "disk"; readonly sandboxAppRoot: string } {
  return { appRoot: join(root, ".output"), kind: "disk", sandboxAppRoot: root };
}

async function prewarmFromBuiltBundle(root: string, log: (message: string) => void): Promise<boolean> {
  const loaded = await loadFastPathSymbols(root);
  if (!loaded.ok) {
    log(
      `integration prepare: eve no longer exposes ${loaded.missing}, so the prewarm falls back to eve's own ` +
        "authored-source path (measured 147.7 s against 13.0 s, OPE-2235). Find the new home of that symbol under " +
        "eve/dist and update tests/integration/prewarm.ts, and the eve-upgrade-check skill's checklist.",
    );
    return false;
  }
  const { readBundledCompiledArtifacts, resolveRuntimeAgentGraph } = loaded.symbols as {
    readBundledCompiledArtifacts: () => { manifest?: unknown; metadata?: unknown; moduleMap?: unknown } | null | undefined;
    resolveRuntimeAgentGraph: (input: { manifest: unknown; moduleMap: unknown }) => Promise<unknown>;
  };
  const restoreListenerEnv = await pinListenerEnvForPrewarm(await reserveEphemeralPort());
  try {
    await import(pathToFileURL(join(root, ".output", "server", "index.mjs")).href);
  } finally {
    restoreListenerEnv();
  }
  const artifacts = readBundledCompiledArtifacts();
  if (artifacts?.manifest === undefined || artifacts.moduleMap === undefined) {
    log(
      "integration prepare: the built bundle did not install its compiled artifacts on the shared runtime session, so the " +
        "prewarm falls back to eve's own authored-source path. eve keeps that session on globalThis under " +
        'Symbol.for("eve.runtime-session-storage"); an eve bump that made it module-private would do this. ' +
        "See tests/integration/prewarm.ts.",
    );
    return false;
  }
  const graph = await resolveRuntimeAgentGraph({ manifest: artifacts.manifest, moduleMap: artifacts.moduleMap });
  const prewarmAppSandboxes = await loadPrewarmAppSandboxes(root);
  await prewarmAppSandboxes({
    appRoot: root,
    compiledArtifactsSource: builtTreeArtifactsSource(root),
    loadAgentGraph: async () => graph,
    log,
  });
  return true;
}

async function prewarmFromAuthoredSource(root: string, log: (message: string) => void): Promise<void> {
  const prewarmAppSandboxes = await loadPrewarmAppSandboxes(root);
  await prewarmAppSandboxes({ appRoot: root, compiledArtifactsSource: builtTreeArtifactsSource(root), log });
}

export async function prewarmJustBashTemplate(
  root: string,
  state: string,
  log: (message: string) => void = (m) => console.log(m),
): Promise<PrewarmResult> {
  const restoreStateEnv = pinStateEnvForPrewarm(state);
  const startedAt = Date.now();
  let via: PrewarmVia;
  try {
    via = (await prewarmFromBuiltBundle(root, log)) ? "built-bundle" : "authored-source";
    if (via === "authored-source") await prewarmFromAuthoredSource(root, log);
  } finally {
    restoreStateEnv();
  }
  if (!existsSync(justBashTemplateDir(root))) {
    throw new Error(
      `integration prepare: the prewarm completed but ${justBashTemplateDir(root)} is still absent. TWO CAUSES look ` +
        "identical from here, so check both. (1) THE BACKEND SELECTION did not land on just-bash — check the " +
        "OE_SANDBOX_BACKEND handling in tests/integration/prepare.ts. (2) THE TEMPLATE WENT TO THE WRONG ROOT — a " +
        "missing or wrong `sandboxAppRoot` on `builtTreeArtifactsSource` mints it under " +
        "`<root>/.output/.eve/sandbox-cache` instead, which is measured and is why that field exists (OPE-2248). " +
        "Look there before reading the backend code.",
    );
  }
  return { via, seconds: (Date.now() - startedAt) / 1000 };
}
