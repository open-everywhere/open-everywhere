import { recordOfferedWorkerToolset } from "../access/seat-cut.js";
import { currentWorkerWake } from "../access/worker-seat-state.js";
import type { ModelBackend, RoutableModel, RoutedCallOptions, RoutingDeps } from "./routing.js";

/**
 * The names of the tools that one model call offers, read from the call's `tools` option. Each entry
 * of that list (a function tool or a provider tool) carries its `name`. This is the set the model
 * sees, so it is the forensic source for the `worker.toolset` row.
 */
export function offeredToolNames(options: RoutedCallOptions): string[] {
  const tools = (options as { tools?: unknown }).tools;
  const entries = Array.isArray(tools) ? tools : tools !== null && typeof tools === "object" ? Object.entries(tools).map(([name, t]) => ({ name, ...(t as object) })) : [];
  const names = new Set<string>();
  for (const entry of entries) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return [...names].sort();
}

/**
 * Wraps a worker's model backend so that each model call records the tools it offers, before the
 * call goes out (`access/seat-cut.ts#recordOfferedWorkerToolset`). The seat cut sees only the tool
 * slots it wraps. eve 1.x also mounts its own tools, static slots and declared subagents, and only
 * the model call's `tools` list holds every one of them. The record fails soft: a fault in it never
 * stops the call.
 */
export function withWorkerToolsetEvidence<TModel extends RoutableModel>(deps: RoutingDeps<TModel>, sessionId: string | undefined): RoutingDeps<TModel> {
  return { ...deps, backend: evidenceBackend(deps.backend, sessionId) };
}

function evidenceBackend<TModel extends RoutableModel>(backend: ModelBackend<TModel>, sessionId: string | undefined): ModelBackend<TModel> {
  return {
    model: (id: string, via?: string) => evidenceModel(via === undefined ? backend.model(id) : backend.model(id, via), sessionId),
    applyOptions: (route, options, ids) => backend.applyOptions(route, options, ids),
  };
}

function record(sessionId: string | undefined, options: RoutedCallOptions): void {
  try {
    recordOfferedWorkerToolset(sessionId, offeredToolNames(options));
  } catch {
  }
}

/** The session id that the worker's record is keyed on: the id the seat cut reads from its own context. */
export function evidenceSessionIdOf(ctx: unknown): string | undefined {
  const id = (ctx as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Wraps one resolved model when the wake is a worker's, and returns any other model unchanged. Every
 * primary-model resolver applies it: `resolvePrimaryModel` through `withWorkerToolsetEvidence`, and a
 * resolver that builds its model another way (the scripted model of the integration tier) here.
 */
export function withWorkerToolsetEvidenceModel<TModel extends RoutableModel>(model: TModel, ctx: unknown): TModel {
  return currentWorkerWake() ? evidenceModel(model, evidenceSessionIdOf(ctx)) : model;
}

function evidenceModel<TModel extends RoutableModel>(inner: TModel, sessionId: string | undefined): TModel {
  const shim: RoutableModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options: RoutedCallOptions) {
      record(sessionId, options);
      return inner.doGenerate(options);
    },
    async doStream(options: RoutedCallOptions) {
      record(sessionId, options);
      return inner.doStream(options);
    },
  };
  return shim as TModel;
}
