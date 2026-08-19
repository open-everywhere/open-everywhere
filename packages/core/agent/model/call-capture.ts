import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { getSettings } from "../settings/settings.js";
import { appendAudit } from "../audit/audit.js";
import { resolvePartition, domainKeyOf } from "../memory/partition.js";
import { currentSessionId, type BindableContext } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import type { ModelCallCaptureWrite } from "../operational/store.js";
import type { ModelBackend, RoutableModel, RoutedCallOptions, RoutingDeps } from "./routing.js";

export const CAPTURE_GAP_ACTION = "soak.capture_gap";

export const CAPTURE_SCHEMA_VERSION = 1;

export const CAPTURE_MAX_BODY_B64_BYTES = 8_000_000;

export const MAX_TRACKED_CAPTURE_TURNS = 512;

interface TurnCounts {
  attempted: number;
  captured: number;
  uncalled: number;
  completed: number;
  reported: boolean;
}

const counts = new Map<string, TurnCounts>();

export function captureCountKey(sessionId: string | undefined, turnId: string | undefined): string {
  return `${sessionId ?? ""}:${turnId ?? ""}`;
}

function entry(key: string): TurnCounts {
  let c = counts.get(key);
  if (!c) {
    c = { attempted: 0, captured: 0, uncalled: 0, completed: 0, reported: false };
    counts.set(key, c);
    if (counts.size > MAX_TRACKED_CAPTURE_TURNS) {
      const oldest = counts.keys().next();
      if (!oldest.done) counts.delete(oldest.value);
    }
  }
  return c;
}

export function _resetCaptureCountsForTest(): void {
  counts.clear();
}

export function captureCountsFor(sessionId: string | undefined, turnId: string | undefined): Readonly<TurnCounts> | undefined {
  const c = counts.get(captureCountKey(sessionId, turnId));
  return c ? { ...c } : undefined;
}

export function captureArmed(settings = safeSettings()): boolean {
  return settings?.soak.capture === true;
}

export function captureCoversSurface(surfaceKey: string, settings = safeSettings()): boolean {
  const prefix = settings?.soak.captureSurfacePrefix ?? "";
  return prefix.length === 0 || surfaceKey.startsWith(prefix);
}

function safeSettings(): { soak: { capture: boolean; captureSurfacePrefix: string } } | undefined {
  try {
    return getSettings();
  } catch {
    return undefined;
  }
}

export function serialiseCallBody(options: RoutedCallOptions): string {
  const ancestors: unknown[] = [];
  return JSON.stringify(options, function replacer(this: unknown, key: string, value: unknown) {
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (key === "abortSignal") return undefined;
    if (typeof value === "function") return undefined;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (ancestors.includes(value)) return "[circular]";
      ancestors.push(value);
    }
    return value;
  });
}

export function bodySha256(serialised: string): string {
  return createHash("sha256").update(serialised, "utf8").digest("hex");
}

export function gzipBase64(serialised: string): string {
  return gzipSync(Buffer.from(serialised, "utf8")).toString("base64");
}

export interface CaptureSite {
  readonly org: string;
  readonly surfaceKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export function captureSiteFrom(ctx: BindableContext, event?: unknown): CaptureSite | undefined {
  try {
    const p = resolvePartition(ctx);
    const surfaceKey = domainKeyOf(p);
    if (!captureCoversSurface(surfaceKey)) return undefined;
    const sessionId = currentSessionId(ctx) ?? "";
    const turnId = eventTurnId(event) ?? "";
    return { org: p.org, surfaceKey, sessionId, turnId };
  } catch {
    return undefined;
  }
}

function eventTurnId(event: unknown): string | undefined {
  const turnId = (event as { data?: { turnId?: unknown } } | undefined)?.data?.turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

export function withCapture<TModel extends RoutableModel>(deps: RoutingDeps<TModel>, site: CaptureSite | undefined): RoutingDeps<TModel> {
  if (site === undefined) return deps;
  return { ...deps, backend: captureBackend(deps.backend, site) };
}

function captureBackend<TModel extends RoutableModel>(backend: ModelBackend<TModel>, site: CaptureSite): ModelBackend<TModel> {
  return {
    model: (id: string) => captureModel(backend.model(id), site),
    applyOptions: (route, options, ids) => backend.applyOptions(route, options, ids),
  };
}

export function captureModel<TModel extends RoutableModel>(inner: TModel, site: CaptureSite): TModel {
  const record = async (options: RoutedCallOptions): Promise<void> => {
    const c = entry(captureCountKey(site.sessionId, site.turnId));
    c.attempted += 1;
    try {
      const serialised = serialiseCallBody(options);
      const b64 = gzipBase64(serialised);
      const truncated = b64.length > CAPTURE_MAX_BODY_B64_BYTES;
      const write: ModelCallCaptureWrite = {
        org: site.org,
        surfaceKey: site.surfaceKey,
        sessionId: site.sessionId,
        turnId: site.turnId,
        stepIndex: c.attempted - 1,
        ts: new Date().toISOString(),
        model: inner.modelId,
        provider: inner.provider,
        schemaVersion: CAPTURE_SCHEMA_VERSION,
        sha256: bodySha256(serialised),
        bodyBytes: Buffer.byteLength(serialised, "utf8"),
        bodyGzipB64: truncated ? "" : b64,
        truncated,
      };
      if (truncated) {
        console.warn(
          `[open-everywhere:capture] body too large to store (${b64.length} b64 bytes > ${CAPTURE_MAX_BODY_B64_BYTES}) — ` +
            `metadata row written with an EMPTY body (session=${site.sessionId} turn=${site.turnId} step=${write.stepIndex}). This capture cannot be replayed.`,
        );
      }
      await getOperationalStore().appendModelCallCapture(write);
      c.captured += 1;
    } catch (err) {
      console.warn(`[open-everywhere:capture] capture write skipped (session=${site.sessionId} turn=${site.turnId}): ${String(err)}`);
    }
  };
  const shim: RoutableModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options: RoutedCallOptions) {
      await record(options);
      return inner.doGenerate(options);
    },
    async doStream(options: RoutedCallOptions) {
      await record(options);
      return inner.doStream(options);
    },
  };
  return shim as TModel;
}

export function noteCompletedModelStep(sessionId: string | undefined, turnId: string | undefined, ctx?: BindableContext): void {
  try {
    if (!captureArmed()) return;
    if (!ctx || captureSiteFrom(ctx) === undefined) return;
    const key = captureCountKey(sessionId, turnId);
    const c = entry(key);
    c.completed += 1;
    if (c.reported || c.captured + c.uncalled >= c.completed) return;
    c.reported = true;
    reportCaptureGap(sessionId, turnId, c, ctx);
  } catch {
  }
}

export function noteUncalledModelStep(site: CaptureSite | undefined): void {
  try {
    if (site === undefined || !captureArmed()) return;
    entry(captureCountKey(site.sessionId, site.turnId)).uncalled += 1;
  } catch {
  }
}

function reportCaptureGap(sessionId: string | undefined, turnId: string | undefined, c: TurnCounts, ctx?: BindableContext): void {
  const detail = { attempted: c.attempted, captured: c.captured, uncalled: c.uncalled, completed: c.completed, sessionId: sessionId ?? "", turnId: turnId ?? "" };
  try {
    console.warn(
      `[open-everywhere:capture] CAPTURE GAP on turn ${detail.turnId} (session ${detail.sessionId}): ` +
        `${c.completed} model steps completed but only ${c.captured} captured (${c.attempted} attempted, +${c.uncalled} excused). ` +
        `A model call reached a provider on a path the capture hook does not wrap — this session's captures are NOT a replay source.`,
    );
  } catch {
  }
  if (!ctx) return;
  let where: { org: string; platform: string; workspace: string; surface?: string };
  try {
    const p = resolvePartition(ctx);
    where = { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface };
  } catch {
    return;
  }
  void appendAudit({ ...where, action: CAPTURE_GAP_ACTION, detail }).catch(() => {
  });
}
