import type { NativeTranscriptResult, NativeTranscriptSource, NativeMeetingRef, NativeReadContext } from "@open-everywhere/core/agent/adapter-api.js";
import { parseWebVtt } from "@open-everywhere/core/agent/adapter-api.js";
import { TokenCache, onHost, readCappedText, readJsonLoose, unexpectedStatus, type NativeFetch, timedFetch } from "./native-http.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = "https://login.microsoftonline.com";
const MAX_PAGES = 10;

export const TEAMS_ACCESS_HINT =
  "In Microsoft Entra, grant the app OnlineMeetings.Read.All and OnlineMeetingTranscript.Read.All (application, admin consent), and add an application access policy that covers the organiser (Grant-CsApplicationAccessPolicy). The Teams meeting policy must allow transcription.";

interface Transcript {
  readonly id: string;
  readonly createdDateTime?: string;
  readonly endDateTime?: string;
}

export function teamsTranscriptSource(fetchImpl: NativeFetch = timedFetch, now: () => number = Date.now): NativeTranscriptSource {
  const tokens = new TokenCache();

  async function token(tenant: string, clientId: string, secret: string): Promise<string | NativeTranscriptResult> {
    const key = `${tenant}\n${clientId}`;
    const cached = tokens.get(key, now());
    if (cached !== undefined) return cached;
    const res = await fetchImpl(`${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString(),
    });
    const body = await readJsonLoose(res);
    if (res.status === 400 || res.status === 401) return { status: "refused", reason: "credential", hint: "Microsoft Entra refused the app's client id or client secret." };
    if (!res.ok || typeof body.access_token !== "string") throw unexpectedStatus("the Entra token endpoint", res.status);
    tokens.set(key, body.access_token, body.expires_in, now());
    return body.access_token;
  }

  async function graph(url: string, bearer: string, what: string, on404: NativeTranscriptResult): Promise<Response | NativeTranscriptResult> {
    if (!onHost(url, "graph.microsoft.com")) throw new Error(`${what}: refusing to send the token off graph.microsoft.com`);
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
    if (res.status === 401) return { status: "refused", reason: "credential", hint: "Microsoft Graph refused the app's token." };
    if (res.status === 403) return { status: "refused", reason: "access-off", hint: TEAMS_ACCESS_HINT };
    if (res.status === 404) return on404;
    if (!res.ok) throw unexpectedStatus(what, res.status);
    return res;
  }

  return {
    platform: "teams",
    disclosure: "OE reads the transcript Microsoft Teams made, through Microsoft Graph, with the organisation's own Entra app registration (not any person's account).",
    async read(ref: NativeMeetingRef, ctx: NativeReadContext): Promise<NativeTranscriptResult> {
      const t = ctx.policy.teams;
      if (t === undefined) return { status: "refused", reason: "credential", hint: "The meeting policy declares no Teams credential." };
      if (ref.tenantId === undefined || ref.organizerId === undefined || !t.tenants.includes(ref.tenantId)) return { status: "refused", reason: "not-found" };
      const tok = await token(ref.tenantId, t.clientId, await ctx.secret(t.clientSecretRef));
      if (typeof tok !== "string") return tok;
      const user = `${GRAPH}/users/${encodeURIComponent(ref.organizerId)}/onlineMeetings`;

      const filter = `JoinWebUrl eq '${ref.url.replace(/'/g, "''")}'`;
      const found = await graph(`${user}?$filter=${encodeURIComponent(filter)}`, tok, "the Graph meeting lookup", { status: "refused", reason: "not-found" });
      if (!(found instanceof Response)) return found;
      const meetings = (await readJsonLoose(found)).value;
      const meetingId = Array.isArray(meetings) && typeof (meetings[0] as { id?: unknown } | undefined)?.id === "string" ? (meetings[0] as { id: string }).id : undefined;
      if (meetingId === undefined) return { status: "refused", reason: "not-found" };

      const transcripts: Transcript[] = [];
      let next: string | undefined = `${user}/${encodeURIComponent(meetingId)}/transcripts`;
      for (let page = 0; next !== undefined && page < MAX_PAGES; page++) {
        const listed = await graph(next, tok, "the Graph transcript list", { status: "refused", reason: "not-found" });
        if (!(listed instanceof Response)) return listed;
        const body = await readJsonLoose(listed);
        for (const v of Array.isArray(body.value) ? body.value : []) {
          const o = v as Record<string, unknown>;
          if (typeof o.id === "string") {
            transcripts.push({
              id: o.id,
              ...(typeof o.createdDateTime === "string" ? { createdDateTime: o.createdDateTime } : {}),
              ...(typeof o.endDateTime === "string" ? { endDateTime: o.endDateTime } : {}),
            });
          }
        }
        next = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : undefined;
      }
      const eligible = transcripts
        .filter((x) => ref.startedAfter === undefined || (x.createdDateTime !== undefined && Date.parse(x.createdDateTime) >= ref.startedAfter))
        .sort((a, b) => Date.parse(b.createdDateTime ?? "") - Date.parse(a.createdDateTime ?? ""));
      const pick = eligible[0];
      if (pick === undefined || pick.endDateTime === undefined) return { status: "pending" };

      const content = await graph(`${user}/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(pick.id)}/content?$format=text/vtt`, tok, "the Graph transcript content", {
        status: "refused",
        reason: "expired",
      });
      if (!(content instanceof Response)) return content;
      const segments = parseWebVtt(await readCappedText(content));
      return { status: "ready", segments, ...(pick.createdDateTime !== undefined ? { startedAt: pick.createdDateTime } : {}), endedAt: pick.endDateTime };
    },
  };
}
