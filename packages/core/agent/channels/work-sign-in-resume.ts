import { dispatchWorkResult } from "./unified.js";
import { mintWakeId } from "./unified-window.js";
import { readWorkRequest, renderSignInResumeWake, type WorkRequestRow } from "./work.js";
import { currentSeatToken } from "./work-generation.js";
import { forgetSignInMarkers, readSignInPending, rememberSignInDone, rememberSignInResume, takeSignInDone, takeSignInResume, type SignInResume } from "./work-sign-in-note.js";
import { parseScopeKey } from "../access/scope-key.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { connectorDisplayName } from "../access/credential-grant-copy.js";
import { getOperationalStore } from "../operational/provider.js";
import { registerSignedInWorkResumer, type ConsentResumeRecord } from "../connections/consent-resume.js";

export interface SignedInWorkResumeDeps {
  readonly take?: (org: string, detourId: string) => Promise<SignInResume | undefined>;
  readonly readRequest?: (org: string, requestId: string) => Promise<WorkRequestRow | undefined>;
  readonly seatToken?: (org: string, recorded: string) => Promise<string>;
  readonly dispatch?: typeof dispatchWorkResult;
  readonly nowIso?: () => string;
  readonly pending?: typeof readSignInPending;
  readonly markDone?: typeof rememberSignInDone;
  readonly takeDone?: typeof takeSignInDone;
}

export function signerIsRequester(requesterId: string, requestSurfaceKey: string, origin: Pick<ConsentResumeRecord["origin"], "principalId" | "surfaceKey">): boolean {
  const where = parseScopeKey(origin.surfaceKey);
  const asked = parseScopeKey(requestSurfaceKey);
  if (where.kind !== "surface" || asked.kind !== "surface") return false;
  if (where.platform !== asked.platform || where.workspace !== asked.workspace) return false;
  const nativeIn = (id: string): string | undefined => {
    const key = parsePrincipalKey(id);
    if (key === undefined) return id.includes("/") ? undefined : id;
    if (key.platform !== where.platform || (key.tenant !== undefined && key.tenant !== where.workspace)) return undefined;
    return key.id;
  };
  const requester = nativeIn(requesterId);
  const signer = nativeIn(origin.principalId);
  return requester !== undefined && signer !== undefined && requester.length > 0 && requester === signer;
}

export async function dispatchSignInResume(org: string, resume: SignInResume, deps: SignedInWorkResumeDeps = {}): Promise<boolean> {
  try {
    const row = await (deps.readRequest ?? ((o, id) => readWorkRequest(getOperationalStore(), o, id)))(org, resume.requestId);
    if (row === undefined || row.fire !== undefined || row.requester.kind !== "requester") return false;
    const seatToken = await (deps.seatToken ?? ((o, t) => currentSeatToken(o, t)))(org, row.seatToken);
    const wakeId = mintWakeId();
    return await (deps.dispatch ?? dispatchWorkResult)({
      seatToken,
      wakeId,
      message: renderSignInResumeWake({
        wakeId,
        origin: row.origin,
        requestId: resume.requestId,
        taskId: resume.taskId,
        connector: connectorDisplayName(resume.connector),
        nowIso: (deps.nowIso ?? (() => new Date().toISOString()))(),
        dispatchWakeId: row.wakeId,
      }),
      origin: row.origin,
      surfaceKey: row.surfaceKey,
      binding: row.binding,
      requester: row.requester,
      nonMemberWake: row.nonMemberWake,
      requestId: resume.requestId,
      quiet: true,
    });
  } catch {
    return false;
  }
}

async function resumeIfOwn(record: ConsentResumeRecord, resume: SignInResume, deps: SignedInWorkResumeDeps): Promise<boolean> {
  if (resume.connector !== record.connector) return false;
  const row = await (deps.readRequest ?? ((o, id) => readWorkRequest(getOperationalStore(), o, id)))(record.origin.org, resume.requestId).catch(() => undefined);
  if (row === undefined || row.requester.kind !== "requester" || !signerIsRequester(row.requester.principalId, row.surfaceKey, record.origin)) return false;
  return await dispatchSignInResume(record.origin.org, resume, deps);
}

export async function resumeSignedInWork(record: ConsentResumeRecord, deps: SignedInWorkResumeDeps = {}): Promise<boolean> {
  try {
    const org = record.origin.org;
    const take = deps.take ?? takeSignInResume;
    const filed = await take(org, record.detourId);
    if (filed !== undefined) {
      const ok = await resumeIfOwn(record, filed, deps);
      if (ok) await forgetSignInMarkers(org, record.detourId).catch(() => undefined);
      return ok;
    }
    const pending = await (deps.pending ?? readSignInPending)(org, record.detourId);
    if (pending === undefined || pending.connector !== record.connector) return false;
    if (!(await (deps.markDone ?? rememberSignInDone)(org, record.detourId))) return false;
    const late = await take(org, record.detourId);
    if (late === undefined) return true;
    await (deps.takeDone ?? takeSignInDone)(org, record.detourId);
    return await resumeIfOwn(record, late, deps);
  } catch {
    return false;
  }
}

export async function resumeFiledJobIfSignedIn(org: string, detourId: string, deps: SignedInWorkResumeDeps = {}): Promise<boolean> {
  try {
    const pending = await (deps.pending ?? readSignInPending)(org, detourId);
    if (!(await (deps.takeDone ?? takeSignInDone)(org, detourId))) return false;
    const filed = await (deps.take ?? takeSignInResume)(org, detourId);
    await forgetSignInMarkers(org, detourId).catch(() => undefined);
    if (filed === undefined || pending === undefined || filed.connector !== pending.connector) return false;
    const row = await (deps.readRequest ?? ((o, id) => readWorkRequest(getOperationalStore(), o, id)))(org, filed.requestId).catch(() => undefined);
    if (row === undefined || row.requester.kind !== "requester" || !signerIsRequester(row.requester.principalId, row.surfaceKey, pending)) return false;
    return await dispatchSignInResume(org, filed, deps);
  } catch {
    return false;
  }
}

export async function settleSignIn(input: {
  readonly org: string;
  readonly ran: boolean;
  readonly detourId: string | undefined;
  readonly file: SignInResume | undefined;
}, deps: SignedInWorkResumeDeps & { readonly remember?: (org: string, detourId: string, resume: SignInResume) => Promise<boolean> } = {}): Promise<"filed" | "resumed" | "cleared" | "none"> {
  if (!input.ran || input.detourId === undefined) return "none";
  if (input.file === undefined) {
    await forgetSignInMarkers(input.org, input.detourId).catch(() => undefined);
    return "cleared";
  }
  await (deps.remember ?? rememberSignInResume)(input.org, input.detourId, input.file);
  return (await resumeFiledJobIfSignedIn(input.org, input.detourId, deps)) ? "resumed" : "filed";
}

registerSignedInWorkResumer((record) => resumeSignedInWork(record));
