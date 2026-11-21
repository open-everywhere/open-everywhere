import { processRegistrySlot } from "../lib/process-registry.js";

export type BoxPurpose = "meeting" | "browser" | "browser-qa";

export const BOX_PURPOSES: readonly BoxPurpose[] = ["meeting", "browser", "browser-qa"];

export interface BoxSpec {
  readonly purpose: BoxPurpose;
  readonly ref: string;
  readonly image: string;
  readonly command: readonly string[];
  readonly vcpus: number;
  readonly memoryMb: number;
  readonly shmMb?: number;
  readonly user?: string;
  readonly maxMinutes: number;
  readonly env: Readonly<Record<string, string>>;
  readonly egress: "open" | { readonly allow: readonly string[] };
  readonly persist?: { readonly key: string; readonly keepDays: number; readonly mount: string };
  readonly port?: number;
  readonly network?: string;
}

export interface BoxListing {
  readonly name: string;
  readonly status: string;
  readonly createdAt: number;
  readonly purpose?: BoxPurpose;
  readonly ref?: string;
}

export interface OpenedBox {
  readonly name: string;
  readonly backend: string;
  readonly createdAt: number;
  readonly maxMinutes: number;
  readonly url?: string;
  readonly egressSourceIp?: string;
}

export interface LongLivedBoxBackend {
  readonly backend: string;
  readonly metered: boolean;
  readonly maxMinutesCeiling: number;
  readonly unavailable?: string;
  readonly enforcesHostAllowList?: boolean;
  open(spec: BoxSpec): Promise<OpenedBox>;
  status(name: string): Promise<BoxListing | undefined>;
  list(purpose: BoxPurpose): Promise<BoxListing[]>;
  stop(name: string): Promise<void>;
  forget?(key: string): Promise<void>;
}

export const BOX_LABEL = "oeBox";
export const BOX_REF_LABEL = "oeBoxRef";

export function boxLabels(spec: Pick<BoxSpec, "purpose" | "ref">): Record<string, string> {
  return { [BOX_LABEL]: spec.purpose, [BOX_REF_LABEL]: spec.ref };
}

export function clampBoxMinutes(requested: number, ceiling: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), Math.max(1, Math.floor(ceiling)));
}

export function boxIsLive(status: string): boolean {
  return status === "running" || status === "pending";
}

export function boxesPastCap(
  boxes: readonly BoxListing[],
  capMinutes: number,
  now: number,
  graceMinutes = 5,
): BoxListing[] {
  const limitMs = (capMinutes + graceMinutes) * 60_000;
  return boxes.filter((b) => boxIsLive(b.status) && now - b.createdAt > limitMs);
}

export function boxSeconds(createdAt: number, endedAt: number): number {
  return Math.max(0, Math.round((endedAt - createdAt) / 1000));
}

export class BoxUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BoxUnavailableError";
  }
}

const SLOT = processRegistrySlot<LongLivedBoxBackend>("long-lived-box.v1");

export function registerLongLivedBoxBackend(backend: LongLivedBoxBackend): void {
  SLOT.set(backend);
}

export function resolveLongLivedBoxBackend(): LongLivedBoxBackend {
  const backend = SLOT.get();
  if (backend === null) {
    throw new BoxUnavailableError("no long-lived box backend is registered on this deployment, so I can't open a box");
  }
  if (backend.unavailable !== undefined) throw new BoxUnavailableError(backend.unavailable);
  return backend;
}

export function registeredLongLivedBoxBackend(): LongLivedBoxBackend | undefined {
  return SLOT.get() ?? undefined;
}

export function resetLongLivedBoxBackendForTest(): void {
  SLOT.set(null);
}
