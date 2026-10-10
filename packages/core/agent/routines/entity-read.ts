import { admitProviderRegistration } from "../access/provider-selection.js";
import { ageAtRead } from "../access/dated-read.js";
import type { EntityPointer } from "./event-model.js";

export interface HydratedEntity {
  readonly platform: string;
  readonly id: string;
  readonly title?: string;
  readonly state?: string;
  readonly url?: string;
  readonly body?: string;
  readonly updatedAt?: string;
  readonly fetchedAt: string;
}

export type HydrationOutcome =
  | { readonly status: "ok"; readonly entity: HydratedEntity }
  | { readonly status: "gone" }
  | { readonly status: "forbidden" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "unsupported" };

export interface EntityReadAdapter {
  readonly platform: string;
  readonly provider?: string;
  readonly readsNetwork?: boolean;
  read(id: string): Promise<HydrationOutcome>;
}

const ADAPTERS = new Map<string, EntityReadAdapter>();

export function registerEntityRead(adapter: EntityReadAdapter): boolean {
  if (adapter.provider !== undefined && !admitProviderRegistration(adapter.provider, "entity-read")) return false;
  ADAPTERS.set(adapter.platform, adapter);
  return true;
}

export function entityReadAdapter(platform: string | undefined): EntityReadAdapter | undefined {
  return platform === undefined ? undefined : ADAPTERS.get(platform);
}

export function registeredEntityReadPlatforms(): readonly string[] {
  return [...ADAPTERS.keys()].sort();
}

export function resetEntityReadForTest(): void {
  ADAPTERS.clear();
}

export type HydrationMemo = Map<string, Promise<HydrationOutcome>>;

export function newHydrationMemo(): HydrationMemo {
  return new Map();
}

function hydrationMemoKey(platform: string, id: string): string {
  return `${platform}\u0000${id}`;
}

export interface HydrationDeps {
  readonly read?: (platform: string, id: string) => Promise<HydrationOutcome>;
}

async function liveRead(platform: string, id: string): Promise<HydrationOutcome> {
  const adapter = entityReadAdapter(platform);
  if (!adapter) return { status: "unsupported" };
  return adapter.read(id);
}

function noNetworkTest(): boolean {
  return process.argv.some((a) => typeof a === "string" && a.endsWith("-test.ts"));
}

export async function hydratePointer(
  pointer: EntityPointer,
  memo: HydrationMemo,
  deps: HydrationDeps = {},
): Promise<HydrationOutcome> {
  if (pointer.gone) return { status: "gone" };
  if (deps.read === undefined && noNetworkTest()) {
    const netAdapter = entityReadAdapter(pointer.platform);
    if (netAdapter?.readsNetwork) {
      throw new Error(
        `entity hydration for "${pointer.platform}" ${pointer.id} reached the LIVE network reader inside a test. ` +
          `Register a stub after importing the fan-out path — ` +
          `registerEntityRead({ platform: "${pointer.platform}", read: async () => ({ status: "gone" }) }) — ` +
          `or pass deps.read to hydratePointer. (Keeps the suite's "no network" guarantee structural.)`,
      );
    }
  }
  const key = hydrationMemoKey(pointer.platform, pointer.id);
  const memoised = memo.get(key);
  if (memoised) return memoised;
  const read = deps.read ?? liveRead;
  const pending = (async (): Promise<HydrationOutcome> => {
    try {
      return await read(pointer.platform, pointer.id);
    } catch (err) {
      return { status: "error", error: String(err) };
    }
  })();
  memo.set(key, pending);
  return pending;
}

export const HYDRATED_BODY_MAX = 4000;

export function renderHydratedEntity(e: HydratedEntity): string {
  const updatedAge = ageAtRead(e.updatedAt, e.fetchedAt);
  const lines: string[] = [
    `Read live at ${e.fetchedAt}: this is the CURRENT, authoritative state of ${e.platform} ${e.id}, read with our own credential. ` +
      `Any event summary above this block is what the webhook reported when it fired and may be older — treat it as HISTORY, not the present state.`,
  ];
  if (e.state) lines.push(`state: ${e.state}`);
  if (e.title) lines.push(`title: ${e.title}`);
  if (e.url) lines.push(`url: ${e.url}`);
  if (e.updatedAt) lines.push(`updated: ${e.updatedAt}${updatedAge ? ` (${updatedAge} before this read)` : ""}`);
  if (e.body) {
    const body = e.body.length > HYDRATED_BODY_MAX ? `${e.body.slice(0, HYDRATED_BODY_MAX)}\n…[truncated at ${HYDRATED_BODY_MAX} chars]` : e.body;
    lines.push(`body:\n${body}`);
  }
  return lines.join("\n");
}
