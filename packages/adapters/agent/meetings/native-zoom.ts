import type { NativeTranscriptResult, NativeTranscriptSource, NativeMeetingRef, NativeReadContext } from "@open-everywhere/core/agent/adapter-api.js";
import { parseWebVtt } from "@open-everywhere/core/agent/adapter-api.js";
import { TokenCache, onHost, readCappedText, readJsonLoose, unexpectedStatus, type NativeFetch, timedFetch } from "./native-http.js";

const API = "https://api.zoom.us/v2";
const TOKEN = "https://zoom.us/oauth/token";
export const ZOOM_TRANSCRIPT_GRACE_MS = 24 * 60 * 60_000;

export const ZOOM_ACCESS_HINT =
  "In the Zoom App Marketplace, give the Server-to-Server OAuth app the scope cloud_recording:read:list_recording_files:admin (classic: recording:read:admin), and turn on cloud recording with Create audio transcript in the account settings.";

interface RecordingFile {
  readonly file_type?: string;
  readonly status?: string;
  readonly download_url?: string;
  readonly recording_end?: string;
}

export function zoomTranscriptSource(fetchImpl: NativeFetch = timedFetch, now: () => number = Date.now): NativeTranscriptSource {
  const tokens = new TokenCache();

  async function token(accountId: string, clientId: string, secret: string): Promise<string | NativeTranscriptResult> {
    const key = `${accountId}\n${clientId}`;
    const cached = tokens.get(key, now());
    if (cached !== undefined) return cached;
    const res = await fetchImpl(`${TOKEN}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` },
    });
    const body = await readJsonLoose(res);
    if (res.status === 400 || res.status === 401) return { status: "refused", reason: "credential", hint: "Zoom refused the Server-to-Server app's account id, client id or client secret." };
    if (!res.ok || typeof body.access_token !== "string") throw unexpectedStatus("the Zoom token endpoint", res.status);
    tokens.set(key, body.access_token, body.expires_in, now());
    return body.access_token;
  }

  return {
    platform: "zoom",
    disclosure: "OE reads the audio transcript of the meeting's Zoom cloud recording, through the Zoom API, with the organisation's own Server-to-Server OAuth app (not any person's account).",
    async read(ref: NativeMeetingRef, ctx: NativeReadContext): Promise<NativeTranscriptResult> {
      const z = ctx.policy.zoom;
      if (z === undefined) return { status: "refused", reason: "credential", hint: "The meeting policy declares no Zoom credential." };
      const tok = await token(z.accountId, z.clientId, await ctx.secret(z.clientSecretRef));
      if (typeof tok !== "string") return tok;

      const res = await fetchImpl(`${API}/meetings/${encodeURIComponent(ref.roomId)}/recordings`, { headers: { authorization: `Bearer ${tok}` } });
      const body = await readJsonLoose(res);
      if (res.status === 401) return { status: "refused", reason: "credential", hint: "Zoom refused the app's token." };
      if (res.status === 403) return { status: "refused", reason: "access-off", hint: ZOOM_ACCESS_HINT };
      if (res.status === 404) {
        if (body.code === 3001) return { status: "refused", reason: "not-found" };
        return { status: "pending" };
      }
      if (res.status === 400 && (body.code === 200 || body.code === 4711)) return { status: "refused", reason: "access-off", hint: ZOOM_ACCESS_HINT };
      if (!res.ok) throw unexpectedStatus("the Zoom recordings endpoint", res.status);

      const startedAt = typeof body.start_time === "string" ? body.start_time : undefined;
      if (ref.startedAfter !== undefined && (startedAt === undefined || Date.parse(startedAt) < ref.startedAfter)) return { status: "pending" };
      const files = (Array.isArray(body.recording_files) ? body.recording_files : []) as RecordingFile[];
      const transcript = files.find((f) => f.file_type === "TRANSCRIPT");
      if (transcript === undefined || transcript.status !== "completed" || typeof transcript.download_url !== "string") {
        const ends = files.map((f) => Date.parse(f.recording_end ?? "")).filter((t) => Number.isFinite(t));
        const finished = files.length > 0 && files.every((f) => f.status === "completed") && ends.length > 0;
        if (transcript === undefined && finished && now() - Math.max(...ends) > ZOOM_TRANSCRIPT_GRACE_MS) return { status: "refused", reason: "not-transcribed" };
        return { status: "pending" };
      }
      if (!onHost(transcript.download_url, "zoom.us")) throw new Error("the Zoom transcript download_url is not on zoom.us, so the token is not sent there");
      const dl = await fetchImpl(transcript.download_url, { headers: { authorization: `Bearer ${tok}` } });
      if (dl.status === 404) return { status: "refused", reason: "expired" };
      if (dl.status === 401 || dl.status === 403) return { status: "refused", reason: "access-off", hint: ZOOM_ACCESS_HINT };
      if (!dl.ok) throw unexpectedStatus("the Zoom transcript download", dl.status);
      const segments = parseWebVtt(await readCappedText(dl), { namePrefix: true });
      const ends = files.map((f) => f.recording_end).filter((t): t is string => typeof t === "string").sort();
      return { status: "ready", segments, ...(startedAt !== undefined ? { startedAt } : {}), ...(ends.length > 0 ? { endedAt: ends[ends.length - 1]! } : {}) };
    },
  };
}
