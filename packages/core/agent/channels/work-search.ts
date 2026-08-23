import type { BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { callerWorkDomain, workGrantedConnectors } from "../access/work-grant.js";
import { resolveAccessFor } from "../access/request.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export interface WorkSearchHit {
  readonly connector: string;
  readonly id: string;
  readonly title: string;
  readonly url?: string;
}

export interface WorkSearchAbsence {
  readonly connector: string;
  readonly reason: string;
}

export interface WorkSearchOpts {
  readonly limit: number;
  readonly insideDomain: boolean;
}

export interface WorkSearchAdapter {
  readonly connector: string;
  search(ctx: BindableContext, domain: Domain | undefined, query: string, opts: WorkSearchOpts): Promise<readonly WorkSearchHit[]>;
}

const WORK_SEARCH_REGISTRY: Record<string, WorkSearchAdapter> = {};

export function registerWorkSearchAdapter(adapter: WorkSearchAdapter): void {
  if (!admitProviderRegistration(adapter.connector, "work-search-adapter")) return;
  WORK_SEARCH_REGISTRY[adapter.connector] = adapter;
}

export function registerCoreWorkSearchAdapter(adapter: WorkSearchAdapter): void {
  WORK_SEARCH_REGISTRY[adapter.connector] = adapter;
}

export function workSearchAdapterFor(connector: string): WorkSearchAdapter | undefined {
  return WORK_SEARCH_REGISTRY[connector];
}

export function registeredSearchConnectors(): readonly string[] {
  return Object.keys(WORK_SEARCH_REGISTRY).sort();
}

export function searchGrantedConnectors(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const domain = callerWorkDomain(ctx, () => domains);
  let repos: readonly string[] = [];
  try {
    repos = resolveAccessFor(ctx).repos;
  } catch {
    repos = [];
  }
  return workGrantedConnectors([domain], repos);
}

export function _resetWorkSearchRegistryForTest(adapters: readonly WorkSearchAdapter[]): void {
  for (const k of Object.keys(WORK_SEARCH_REGISTRY)) delete WORK_SEARCH_REGISTRY[k];
  for (const a of adapters) WORK_SEARCH_REGISTRY[a.connector] = a;
}
