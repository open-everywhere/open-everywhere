import { createSign } from "node:crypto";
import type { NativeTranscriptResult, NativeTranscriptSource, NativeMeetingRef, NativeReadContext, NativeTranscriptSegment } from "@open-everywhere/core/agent/adapter-api.js";
import { TokenCache, onHost, readJsonLoose, unexpectedStatus, type NativeFetch, timedFetch } from "./native-http.js";

const MEET = "https://meet.googleapis.com/v2";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
export const MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const MAX_PAGES = 100;

export const MEET_ACCESS_HINT =
  "In the Google Workspace Admin console, grant the service account's client id domain-wide delegation of https://www.googleapis.com/auth/meetings.space.readonly, and enable the Google Meet REST API in its Cloud project.";

const b64url = (v: string | Buffer): string => Buffer.from(v).toString("base64url");

function meetAssertion(key: { readonly client_email: string; readonly private_key: string }, subject: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, sub: subject, scope: MEET_SCOPE, aud: TOKEN_URI, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(signer.sign(key.private_key))}`;
}

interface Record_ {
  readonly name: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly expireTime?: string;
}

function str(o: unknown, k: string): string | undefined {
  const v = (o as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v : undefined;
}

export function meetTranscriptSource(fetchImpl: NativeFetch = timedFetch, now: () => number = Date.now): NativeTranscriptSource {
  const tokens = new TokenCache();

  async function token(keyJson: string, subject: string): Promise<string | NativeTranscriptResult> {
    let key: { client_email: string; private_key: string };
    try {
      const k = JSON.parse(keyJson) as Record<string, unknown>;
      if (typeof k.client_email !== "string" || typeof k.private_key !== "string") throw new Error("shape");
      key = { client_email: k.client_email, private_key: k.private_key };
    } catch {
      return { status: "refused", reason: "credential", hint: "The stored service-account key is not a Google JSON key file." };
    }
    const cacheKey = `${key.client_email}\n${subject}`;
    const cached = tokens.get(cacheKey, now());
    if (cached !== undefined) return cached;
    let assertion: string;
    try {
      assertion = meetAssertion(key, subject, now());
    } catch {
      return { status: "refused", reason: "credential", hint: "The stored service-account key's private key does not sign." };
    }
    const res = await fetchImpl(TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const body = await readJsonLoose(res);
    if (!res.ok) {
      if (body.error === "unauthorized_client") return { status: "refused", reason: "access-off", hint: MEET_ACCESS_HINT };
      if (res.status >= 400 && res.status < 500) return { status: "refused", reason: "credential", hint: "Google refused the service account's key, or the organiser is not a user in the Workspace." };
      throw unexpectedStatus("the Google token endpoint", res.status);
    }
    if (typeof body.access_token !== "string") throw unexpectedStatus("the Google token endpoint", res.status);
    tokens.set(cacheKey, body.access_token, body.expires_in, now());
    return body.access_token;
  }

  type Got = { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly result: NativeTranscriptResult };

  async function get(url: string, bearer: string, what: string): Promise<Got> {
    if (!onHost(url, "meet.googleapis.com")) throw new Error(`${what}: refusing to send the token off meet.googleapis.com`);
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
    if (res.status === 401) return { ok: false, result: { status: "refused", reason: "credential", hint: "Google refused the service account's token." } };
    if (res.status === 403) return { ok: false, result: { status: "refused", reason: "access-off", hint: MEET_ACCESS_HINT } };
    if (res.status === 404) return { ok: false, result: { status: "refused", reason: "expired" } };
    if (!res.ok) throw unexpectedStatus(what, res.status);
    return { ok: true, body: await readJsonLoose(res) };
  }

  async function list(base: string, field: string, bearer: string, what: string): Promise<unknown[] | NativeTranscriptResult> {
    const out: unknown[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const sep = base.includes("?") ? "&" : "?";
      const got = await get(`${base}${sep}pageSize=100${pageToken !== undefined ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, bearer, what);
      if (!got.ok) return got.result;
      const items = got.body[field];
      if (Array.isArray(items)) out.push(...items);
      pageToken = str(got.body, "nextPageToken");
      if (pageToken === undefined || pageToken === "") break;
    }
    return out;
  }

  return {
    platform: "meet",
    disclosure: "OE reads the transcript Google Meet made, through the Meet REST API, with the organisation's own service account acting as the organiser (domain-wide delegation, read-only).",
    async read(ref: NativeMeetingRef, ctx: NativeReadContext): Promise<NativeTranscriptResult> {
      const m = ctx.policy.meet;
      if (m === undefined) return { status: "refused", reason: "credential", hint: "The meeting policy declares no Google Meet credential." };
      const subject = ref.organiserEmail;
      if (subject === undefined || !m.domains.includes(subject.slice(subject.lastIndexOf("@") + 1))) return { status: "refused", reason: "not-found" };
      const tok = await token(await ctx.secret(m.serviceAccountKeyRef), subject);
      if (typeof tok !== "string") return tok;

      const filter = `space.meeting_code = "${ref.roomId}"`;
      const listed = await list(`${MEET}/conferenceRecords?filter=${encodeURIComponent(filter)}`, "conferenceRecords", tok, "the Meet conference list");
      if (!Array.isArray(listed)) return listed.status === "refused" && listed.reason === "expired" ? { status: "refused", reason: "not-found" } : listed;
      const records: Record_[] = listed
        .map((r) => ({ name: str(r, "name") ?? "", ...(str(r, "startTime") ? { startTime: str(r, "startTime")! } : {}), ...(str(r, "endTime") ? { endTime: str(r, "endTime")! } : {}), ...(str(r, "expireTime") ? { expireTime: str(r, "expireTime")! } : {}) }))
        .filter((r) => r.name.startsWith("conferenceRecords/") && (ref.startedAfter === undefined || Date.parse(r.startTime ?? "") >= ref.startedAfter))
        .sort((a, b) => Date.parse(b.startTime ?? "") - Date.parse(a.startTime ?? ""));
      const rec = records[0];
      if (rec === undefined || rec.endTime === undefined) return { status: "pending" };
      if (rec.expireTime !== undefined && Date.parse(rec.expireTime) <= now()) return { status: "refused", reason: "expired" };

      const transcripts = await list(`${MEET}/${rec.name}/transcripts`, "transcripts", tok, "the Meet transcript list");
      if (!Array.isArray(transcripts)) return transcripts;
      if (transcripts.length === 0) return { status: "refused", reason: "not-transcribed" };
      const done = transcripts.filter((t) => str(t, "state") === "ENDED" || str(t, "state") === "FILE_GENERATED");
      if (done.length < transcripts.length) return { status: "pending" };

      const people = await list(`${MEET}/${rec.name}/participants`, "participants", tok, "the Meet participant list");
      if (!Array.isArray(people)) return people;
      const names = new Map<string, string>();
      for (const p of people) {
        const o = p as Record<string, unknown>;
        const who = str(o.signedinUser, "displayName") ?? str(o.anonymousUser, "displayName") ?? str(o.phoneUser, "displayName");
        const name = str(o, "name");
        if (name !== undefined && who !== undefined) names.set(name, who);
      }

      const start = Date.parse(rec.startTime ?? "");
      const segments: NativeTranscriptSegment[] = [];
      for (const t of done) {
        const entries = await list(`${MEET}/${str(t, "name")}/entries`, "transcriptEntries", tok, "the Meet transcript entries");
        if (!Array.isArray(entries)) return entries;
        for (const e of entries) {
          const text = str(e, "text");
          if (text === undefined) continue;
          const at = Date.parse(str(e, "startTime") ?? "");
          segments.push({ speaker: names.get(str(e, "participant") ?? "") ?? "", text, ...(Number.isFinite(at) && Number.isFinite(start) ? { startMs: Math.max(0, at - start) } : {}) });
        }
      }
      segments.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
      return { status: "ready", segments, ...(rec.startTime !== undefined ? { startedAt: rec.startTime } : {}), endedAt: rec.endTime };
    },
  };
}
