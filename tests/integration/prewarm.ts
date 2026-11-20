import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { reserveEphemeralPort } from "../../scripts/ephemeral-port.js";
import { loadReadBundledCompiledArtifacts, type ReadBundledCompiledArtifacts } from "../../scripts/eve-deep-reads/bundled-artifacts.js";
import { EveDeepReadError } from "../../scripts/eve-deep-reads/load.js";
import { loadPrewarmAppSandboxes } from "../../scripts/eve-deep-reads/prewarm.js";
import { loadResolveRuntimeAgentGraph, type ResolveRuntimeAgentGraph } from "../../scripts/eve-deep-reads/resolve-agent-graph.js";
import { justBashTemplateDir } from "./prepare-cache.js";

export type PrewarmVia = "built-bundle" | "authored-source";

export interface PrewarmResult {
  readonly via: PrewarmVia;
  readonly seconds: number;
}

const PREWARM_STATE_ENV = ["OE_PGLITE_DIR", "OE_MEMORY_DIR"] as const;

const PREWARM_MODEL_ENV = "NODE_ENV";

function pinListenerEnvForPrewarm(reserved: { readonly port: number }): () => void {
  const names = ["PORT", "NITRO_PORT", "HOST", "NITRO_HOST"] as const;
  const before = names.map((k) => [k, process.env[k]] as const);
  process.env.PORT = String(reserved.port);
  process.env.NITRO_PORT = String(reserved.port);
  process.env.HOST = "127.0.0.1";
  process.env.NITRO_HOST = "127.0.0.1";
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

export async function loadFastPathSymbols(
  root: string,
): Promise<
  | { ok: true; symbols: { readBundledCompiledArtifacts: ReadBundledCompiledArtifacts; resolveRuntimeAgentGraph: ResolveRuntimeAgentGraph } }
  | { ok: false; missing: string }
> {
  try {
    const readBundledCompiledArtifacts = await loadReadBundledCompiledArtifacts(root);
    const resolveRuntimeAgentGraph = await loadResolveRuntimeAgentGraph(root);
    return { ok: true, symbols: { readBundledCompiledArtifacts, resolveRuntimeAgentGraph } };
  } catch (err) {
    if (err instanceof EveDeepReadError) return { ok: false, missing: `eve/dist/src/${err.file} (${err.missing})` };
    throw err;
  }
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
        "eve/dist and update its module in scripts/eve-deep-reads/, and the eve-upgrade-check skill's checklist.",
    );
    return false;
  }
  const { readBundledCompiledArtifacts, resolveRuntimeAgentGraph } = loaded.symbols;
  const reserved = await reserveEphemeralPort();
  const restoreListenerEnv = pinListenerEnvForPrewarm(reserved);
  try {
    const entry = pathToFileURL(join(root, ".output", "server", "index.mjs")).href;
    await reserved.bindListenerOnReservation(() => import(entry));
  } finally {
    restoreListenerEnv();
  }
  const artifacts = readBundledCompiledArtifacts();
  if (artifacts?.manifest === undefined || artifacts.moduleMap === undefined) {
    log(
      "integration prepare: the built bundle did not install its compiled artifacts on the shared runtime session, so the " +
        "prewarm falls back to eve's own authored-source path. eve keeps that session on globalThis under " +
        'Symbol.for("eve.runtime-session-storage"); an eve bump that made it module-private would do this. ' +
        "See scripts/eve-deep-reads/runtime-session.ts.",
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
        "`sandbox.selfHostBackend` declaration in agent/settings/settings.ts (it must be \"justbash\"). (2) THE TEMPLATE WENT TO THE WRONG ROOT — a " +
        "missing or wrong `sandboxAppRoot` on `builtTreeArtifactsSource` mints it under " +
        "`<root>/.output/.eve/sandbox-cache` instead, which is measured and is why that field exists (OPE-2248). " +
        "Look there before reading the backend code.",
    );
  }
  return { via, seconds: (Date.now() - startedAt) / 1000 };
}
