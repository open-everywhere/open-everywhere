import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { teamsTranscriptSource, TEAMS_ACCESS_HINT } from "../agent/meetings/native-teams.js";
import { meetTranscriptSource, MEET_SCOPE, MEET_ACCESS_HINT } from "../agent/meetings/native-meet.js";
import { zoomTranscriptSource, ZOOM_ACCESS_HINT, ZOOM_TRANSCRIPT_GRACE_MS } from "../agent/meetings/native-zoom.js";
import { registerNativeTranscriptSources } from "../agent/meetings/native-sources.js";
import { timedFetch } from "../agent/meetings/native-http.js";
import { nativeTranscriptSource } from "@open-everywhere/core/agent/adapter-api.js";
import type { NativeReadContext, NativeTranscriptPolicy, NativeTranscriptResult } from "@open-everywhere/core/agent/adapter-api.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "native-transcripts");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}
type Route = (call: Call) => Response | undefined;

function fakeFetch(routes: Route[]): { readonly fetch: (u: string, i?: RequestInit) => Promise<Response>; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async fetch(url, init) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const call: Call = { url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "" };
      calls.push(call);
      for (const r of routes) {
        const res = r(call);
        if (res !== undefined) return res;
      }
      throw new Error(`unrouted fetch: ${call.method} ${url}`);
    },
  };
}
const json = (body: unknown, status = 200): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/vtt" } });
const when = (pred: (c: Call) => boolean, res: () => Response): Route => (c) => (pred(c) ? res() : undefined);

const TENANT = "11111111-2222-3333-4444-555555555555";
const ORGANISER = "3a1e1c5e-0000-4000-8000-00000000a001";
const CLIENT = "0f0f0f0f-1111-2222-3333-444444444444";
const TEAMS_URL = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_fixture%40thread.v2/0?context=${encodeURIComponent(JSON.stringify({ Tid: TENANT, Oid: ORGANISER }))}`;
const NOW = Date.parse("2026-01-16T15:00:00Z");

const POLICY: NativeTranscriptPolicy = {
  enabled: true,
  watchHours: 24,
  teams: { tenants: [TENANT], clientId: CLIENT, clientSecretRef: "TEAMS_TRANSCRIPT_SECRET", why: "test" },
  meet: { domains: ["example.org"], serviceAccountKeyRef: "MEET_SA_KEY", why: "test" },
  zoom: { accountId: "fixtureAccount", clientId: "fixtureClient", clientSecretRef: "ZOOM_S2S_SECRET", why: "test" },
};

function ctxWith(secrets: Record<string, string>, policy: NativeTranscriptPolicy = POLICY): { ctx: NativeReadContext; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ctx: {
      policy,
      async secret(name) {
        asked.push(name);
        const v = secrets[name];
        if (v === undefined) throw new Error(`no secret ${name}`);
        return v;
      },
    },
  };
}
const isRefused = (r: NativeTranscriptResult, reason: string): boolean => r.status === "refused" && r.reason === reason;

{
  const teamsRoutes = (over: Route[] = []): Route[] => [
    ...over,
    when((c) => c.url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, () => json(fixture("teams-token.json"))),
    when((c) => c.url.startsWith(`https://graph.microsoft.com/v1.0/users/${ORGANISER}/onlineMeetings?$filter=`), () => json(fixture("teams-meetings.json"))),
    when((c) => /\/onlineMeetings\/[^/]+\/transcripts$/.test(c.url), () => json(fixture("teams-transcripts.json"))),
    when((c) => c.url.includes("/transcripts/MSMjMCMjbmV3LXRyYW5zY3JpcHQ%3D/content?$format=text/vtt"), () => text(fixture("teams-transcript.vtt"))),
  ];
  const ref = { platform: "teams" as const, url: TEAMS_URL, roomId: "19:meeting_fixture@thread.v2", tenantId: TENANT, organizerId: ORGANISER };

  const f = fakeFetch(teamsRoutes());
  const { ctx, asked } = ctxWith({ TEAMS_TRANSCRIPT_SECRET: "s3cret" });
  const r = await teamsTranscriptSource(f.fetch, () => NOW).read(ref, ctx);
  ok(r.status === "ready", `Teams: the fixture meeting reads as ready (got ${JSON.stringify(r).slice(0, 200)})`);
  if (r.status === "ready") {
    ok(r.segments.length === 3 && r.segments[0]!.speaker === "Ana Lopez" && r.segments[1]!.speaker === "Ben Okafor" && r.segments[1]!.text === "I will book the venue by Friday.", "Teams: the VTT voice spans become the platform's own speaker names, in order");
    ok(r.segments[2]!.startMs === 31 * 60_000 + 20_000, "Teams: a cue's start time is kept in milliseconds");
    ok(r.startedAt === "2026-01-15T16:00:01.0000000Z" && r.endedAt === "2026-01-15T16:31:40.0000000Z", "Teams: the NEWEST transcript of the recurring meeting is the one read");
  }
  ok(asked.join() === "TEAMS_TRANSCRIPT_SECRET", "Teams: the reader resolves exactly the secret the policy names");
  const token = f.calls[0]!;
  const form = new URLSearchParams(token.body);
  ok(token.method === "POST" && form.get("grant_type") === "client_credentials" && form.get("client_id") === CLIENT && form.get("client_secret") === "s3cret" && form.get("scope") === "https://graph.microsoft.com/.default", "Teams: the token is the app's client-credentials grant against the link's tenant");
  const lookup = decodeURIComponent(f.calls[1]!.url.split("$filter=")[1]!);
  ok(lookup === `JoinWebUrl eq '${TEAMS_URL}'`, "Teams: the meeting is found by its join URL under the organiser named in the link");
  ok(f.calls.slice(1).every((c) => c.headers.authorization === "Bearer fixture-graph-token"), "Teams: every Graph call carries the app token");

  await teamsTranscriptSource(f.fetch, () => NOW).read(ref, ctx);
  const src = teamsTranscriptSource(f.fetch, () => NOW);
  const before = f.calls.length;
  await src.read(ref, ctx);
  await src.read(ref, ctx);
  ok(f.calls.slice(before).filter((c) => c.url.includes("/oauth2/")).length === 1, "Teams: one reader asks for a token once and reuses it");

  const next = await teamsTranscriptSource(fakeFetch(teamsRoutes()).fetch, () => NOW).read({ ...ref, startedAfter: Date.parse("2026-01-16T14:00:00Z") }, ctx);
  ok(next.status === "pending", "Teams: an older session of a recurring meeting is never read for 'the next one'");

  const writing = JSON.parse(fixture("teams-transcripts.json")) as { value: Record<string, unknown>[] };
  delete writing.value[1]!.endDateTime;
  const p = await teamsTranscriptSource(fakeFetch(teamsRoutes([when((c) => /\/transcripts$/.test(c.url), () => json(writing))])).fetch, () => NOW).read(ref, ctx);
  ok(p.status === "pending", "Teams: a transcript with no end time is still being written — pending");

  const off = await teamsTranscriptSource(fakeFetch(teamsRoutes([when((c) => /\/transcripts$/.test(c.url), () => json({ error: { code: "Forbidden" } }, 403))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(off, "access-off") && off.status === "refused" && off.hint === TEAMS_ACCESS_HINT, "Teams: a 403 (grant, access policy or tenant switch off) is access-off with the admin hint");

  const none = await teamsTranscriptSource(fakeFetch(teamsRoutes([when((c) => c.url.includes("$filter="), () => json({ value: [] }))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(none, "not-found"), "Teams: no meeting under the organiser for that link is not-found");

  const gone = await teamsTranscriptSource(fakeFetch(teamsRoutes([when((c) => c.url.includes("/content?"), () => json({ error: { code: "NotFound" } }, 404))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(gone, "expired"), "Teams: a listed transcript whose content is gone is expired");

  const badKey = await teamsTranscriptSource(fakeFetch(teamsRoutes([when((c) => c.url.includes("/oauth2/"), () => json({ error: "invalid_client" }, 401))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(badKey, "credential"), "Teams: a refused client secret is the credential refusal");

  const offHost = JSON.parse(fixture("teams-transcripts.json")) as Record<string, unknown>;
  offHost["@odata.nextLink"] = "https://evil.example/steal";
  const leak = fakeFetch(teamsRoutes([when((c) => /\/transcripts$/.test(c.url), () => json(offHost))]));
  let threw = false;
  try {
    await teamsTranscriptSource(leak.fetch, () => NOW).read(ref, ctx);
  } catch {
    threw = true;
  }
  ok(threw && !leak.calls.some((c) => c.url.includes("evil.example")), "Teams: a nextLink off graph.microsoft.com is refused and never fetched with the token");

  const outsider = fakeFetch(teamsRoutes());
  const out = await teamsTranscriptSource(outsider.fetch, () => NOW).read({ ...ref, tenantId: "99999999-2222-3333-4444-555555555555" }, ctx);
  ok(isRefused(out, "not-found") && outsider.calls.length === 0, "Teams: a tenant outside the policy is refused before any call");
}

{
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const KEY = JSON.stringify({ type: "service_account", client_email: "oe-transcripts@fixture.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.googleapis.com/token" });
  const meetRoutes = (over: Route[] = []): Route[] => [
    ...over,
    when((c) => c.url === "https://oauth2.googleapis.com/token", () => json({ access_token: "fixture-meet-token", expires_in: 3599, token_type: "Bearer" })),
    when((c) => c.url.startsWith("https://meet.googleapis.com/v2/conferenceRecords?filter="), () => json(fixture("meet-records.json"))),
    when((c) => c.url.startsWith("https://meet.googleapis.com/v2/conferenceRecords/rec-new/transcripts?"), () => json(fixture("meet-transcripts.json"))),
    when((c) => c.url.startsWith("https://meet.googleapis.com/v2/conferenceRecords/rec-new/participants?"), () => json(fixture("meet-participants.json"))),
    when((c) => c.url.includes("/transcripts/tr-1/entries?") && c.url.includes("pageToken=page-2"), () => json(fixture("meet-entries-2.json"))),
    when((c) => c.url.includes("/transcripts/tr-1/entries?"), () => json(fixture("meet-entries-1.json"))),
  ];
  const ref = { platform: "meet" as const, url: "https://meet.google.com/abc-defg-hij", roomId: "abc-defg-hij", organiserEmail: "ana@example.org" };
  const { ctx } = ctxWith({ MEET_SA_KEY: KEY });

  const f = fakeFetch(meetRoutes());
  const r = await meetTranscriptSource(f.fetch, () => NOW).read(ref, ctx);
  ok(r.status === "ready", `Meet: the fixture conference reads as ready (got ${JSON.stringify(r).slice(0, 200)})`);
  if (r.status === "ready") {
    ok(r.segments.map((s) => s.speaker).join("|") === "Ana Lopez|Guest Carla|Ana Lopez", "Meet: each entry's participant becomes its display name, signed-in and anonymous alike");
    ok(r.segments[0]!.startMs === 10_000 && r.segments[2]!.startMs === 41 * 60_000, "Meet: an entry's time is measured from the conference start");
    ok(r.startedAt === "2026-01-15T20:00:03.120Z" && r.endedAt === "2026-01-15T20:42:17.000Z", "Meet: the newest ended conference is the one read");
  }
  ok(f.calls.some((c) => c.url.includes("pageToken=page-2")), "Meet: the entries are read across every page");
  const filter = decodeURIComponent(f.calls[1]!.url.split("filter=")[1]!.split("&")[0]!);
  ok(filter === 'space.meeting_code = "abc-defg-hij"', "Meet: conferences are listed by the link's meeting code");

  const assertion = new URLSearchParams(f.calls[0]!.body).get("assertion") ?? "";
  const [h, c, s] = assertion.split(".");
  const claims = JSON.parse(Buffer.from(c ?? "", "base64url").toString()) as Record<string, unknown>;
  const verify = createVerify("RSA-SHA256");
  verify.update(`${h}.${c}`);
  ok(verify.verify(publicKey, Buffer.from(s ?? "", "base64url")), "Meet: the JWT assertion verifies against the service account's public key");
  ok(claims.sub === "ana@example.org" && claims.scope === MEET_SCOPE && claims.iss === "oe-transcripts@fixture.iam.gserviceaccount.com" && claims.aud === "https://oauth2.googleapis.com/token", "Meet: the assertion acts as the organiser, with the read-only Meet scope only");
  ok(new URLSearchParams(f.calls[0]!.body).get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer", "Meet: the token is the JWT-bearer grant");

  const live = JSON.parse(fixture("meet-records.json")) as { conferenceRecords: Record<string, unknown>[] };
  delete live.conferenceRecords[0]!.endTime;
  const on = await meetTranscriptSource(fakeFetch(meetRoutes([when((x) => x.url.includes("conferenceRecords?filter="), () => json(live))])).fetch, () => NOW).read(ref, ctx);
  ok(on.status === "pending", "Meet: a conference with no end time is on now — pending");

  const next = await meetTranscriptSource(fakeFetch(meetRoutes()).fetch, () => NOW).read({ ...ref, startedAfter: Date.parse("2026-01-16T14:00:00Z") }, ctx);
  ok(next.status === "pending", "Meet: an older session is never read for 'the next one'");

  const untranscribed = await meetTranscriptSource(fakeFetch(meetRoutes([when((x) => x.url.includes("/rec-new/transcripts?"), () => json({}))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(untranscribed, "not-transcribed"), "Meet: an ended conference with no transcript resource was not transcribed");

  const writing = await meetTranscriptSource(fakeFetch(meetRoutes([when((x) => x.url.includes("/rec-new/transcripts?"), () => json({ transcripts: [{ name: "conferenceRecords/rec-new/transcripts/tr-1", state: "STARTED" }] }))])).fetch, () => NOW).read(ref, ctx);
  ok(writing.status === "pending", "Meet: a transcript still STARTED is pending");

  const late = await meetTranscriptSource(fakeFetch(meetRoutes()).fetch, () => Date.parse("2026-02-15T06:00:00Z")).read(ref, ctx);
  ok(isRefused(late, "expired"), "Meet: a conference past its expireTime (30 days) is expired");

  const noDelegation = await meetTranscriptSource(fakeFetch(meetRoutes([when((x) => x.url === "https://oauth2.googleapis.com/token", () => json({ error: "unauthorized_client" }, 401))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(noDelegation, "access-off") && noDelegation.status === "refused" && noDelegation.hint === MEET_ACCESS_HINT, "Meet: missing domain-wide delegation is access-off with the admin hint");

  const apiOff = await meetTranscriptSource(fakeFetch(meetRoutes([when((x) => x.url.includes("conferenceRecords?filter="), () => json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(apiOff, "access-off"), "Meet: a 403 from the Meet API is access-off");

  const badKey = await meetTranscriptSource(fakeFetch(meetRoutes()).fetch, () => NOW).read(ref, ctxWith({ MEET_SA_KEY: "not json" }).ctx);
  ok(isRefused(badKey, "credential"), "Meet: a stored key that is not a JSON key file is the credential refusal");

  const outside = fakeFetch(meetRoutes());
  const o = await meetTranscriptSource(outside.fetch, () => NOW).read({ ...ref, organiserEmail: "eve@elsewhere.example" }, ctx);
  ok(isRefused(o, "not-found") && outside.calls.length === 0, "Meet: an organiser outside the org's domains is refused before any call");
}

{
  const zoomRoutes = (over: Route[] = []): Route[] => [
    ...over,
    when((c) => c.url.startsWith("https://zoom.us/oauth/token?"), () => json(fixture("zoom-token.json"))),
    when((c) => c.url === "https://api.zoom.us/v2/meetings/81234567890/recordings", () => json(fixture("zoom-recordings.json"))),
    when((c) => c.url === "https://us06web.zoom.us/rec/download/fixture-transcript", () => text(fixture("zoom-transcript.vtt"))),
  ];
  const ref = { platform: "zoom" as const, url: "https://acme.zoom.us/j/81234567890", roomId: "81234567890" };
  const { ctx } = ctxWith({ ZOOM_S2S_SECRET: "zsecret" });

  const f = fakeFetch(zoomRoutes());
  const r = await zoomTranscriptSource(f.fetch, () => NOW).read(ref, ctx);
  ok(r.status === "ready", `Zoom: the fixture recording reads as ready (got ${JSON.stringify(r).slice(0, 200)})`);
  if (r.status === "ready") {
    ok(r.segments.map((s) => `${s.speaker}=${s.text}`).join("|") === "Ana Lopez=We agreed the launch date is 2 November.|Ben Okafor=I will book the venue by Friday.|Ana Lopez=Thanks, everyone.", "Zoom: each cue's name prefix becomes the speaker, and the text loses it");
    ok(r.startedAt === "2026-01-15T22:00:05Z" && r.endedAt === "2026-01-15T22:37:41Z", "Zoom: the session's start and the recording's end are kept");
  }
  const tok = f.calls[0]!;
  ok(tok.method === "POST" && tok.url === "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=fixtureAccount" && tok.headers.authorization === `Basic ${Buffer.from("fixtureClient:zsecret").toString("base64")}`, "Zoom: the token is the Server-to-Server account-credentials grant with Basic auth");
  ok(f.calls.slice(1).every((c) => c.headers.authorization === "Bearer fixture-zoom-token"), "Zoom: the API call and the download carry the app token");

  const notYet = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.endsWith("/recordings"), () => json({ code: 3301, message: "This recording does not exist." }, 404))])).fetch, () => NOW).read(ref, ctx);
  ok(notYet.status === "pending", "Zoom: no cloud recording yet (3301) is pending");
  const noMeeting = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.endsWith("/recordings"), () => json({ code: 3001, message: "Meeting does not exist." }, 404))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(noMeeting, "not-found"), "Zoom: a meeting outside the account (3001) is not-found");
  const scope = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.endsWith("/recordings"), () => json({ code: 4711, message: "Invalid access token, does not contain scopes." }, 403))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(scope, "access-off") && scope.status === "refused" && scope.hint === ZOOM_ACCESS_HINT, "Zoom: a missing scope is access-off with the admin hint");

  const scope400 = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.endsWith("/recordings"), () => json({ code: 4711, message: "Invalid access token, does not contain scopes." }, 400))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(scope400, "access-off"), "Zoom: a missing scope answered as a 400 (code 4711) is access-off too");

  const noTranscript = JSON.parse(fixture("zoom-recordings.json")) as { recording_files: Record<string, unknown>[] };
  noTranscript.recording_files = noTranscript.recording_files.filter((x) => x.file_type !== "TRANSCRIPT");
  const soon = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.endsWith("/recordings"), () => json(noTranscript))])).fetch, () => Date.parse("2026-01-16T00:00:00Z")).read(ref, ctx);
  ok(soon.status === "pending", "Zoom: a fresh recording with no transcript file yet is pending (Zoom writes it after)");
  const later = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.endsWith("/recordings"), () => json(noTranscript))])).fetch, () => Date.parse("2026-01-15T22:37:41Z") + ZOOM_TRANSCRIPT_GRACE_MS + 60_000).read(ref, ctx);
  ok(isRefused(later, "not-transcribed"), "Zoom: a day after the recording ended with no transcript file, it was not transcribed");

  const next = await zoomTranscriptSource(fakeFetch(zoomRoutes()).fetch, () => NOW).read({ ...ref, startedAfter: Date.parse("2026-01-16T14:00:00Z") }, ctx);
  ok(next.status === "pending", "Zoom: the previous session of a recurring meeting is never read for 'the next one'");

  const trashed = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.includes("fixture-transcript"), () => json({ code: 3301 }, 404))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(trashed, "expired"), "Zoom: a transcript file that is gone at download is expired");

  const evil = JSON.parse(fixture("zoom-recordings.json")) as { recording_files: Record<string, unknown>[] };
  evil.recording_files.find((x) => x.file_type === "TRANSCRIPT")!.download_url = "https://zoom.us.evil.example/steal";
  const leak = fakeFetch(zoomRoutes([when((c) => c.url.endsWith("/recordings"), () => json(evil))]));
  let threw = false;
  try {
    await zoomTranscriptSource(leak.fetch, () => NOW).read(ref, ctx);
  } catch {
    threw = true;
  }
  ok(threw && !leak.calls.some((c) => c.url.includes("evil.example")), "Zoom: a download_url off zoom.us is refused and never fetched with the token");

  const badSecret = await zoomTranscriptSource(fakeFetch(zoomRoutes([when((c) => c.url.startsWith("https://zoom.us/oauth/"), () => json({ reason: "Invalid client_id or client_secret", error: "invalid_client" }, 400))])).fetch, () => NOW).read(ref, ctx);
  ok(isRefused(badSecret, "credential"), "Zoom: a refused client secret is the credential refusal");
}

{
  const real = globalThis.fetch;
  let seen: AbortSignal | undefined | null;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    seen = init?.signal;
    return json({ access_token: "t", expires_in: 60 });
  }) as typeof fetch;
  try {
    await timedFetch("https://zoom.us/oauth/token", { method: "POST" });
  } finally {
    globalThis.fetch = real;
  }
  ok(seen instanceof AbortSignal && !seen.aborted, "the readers' default fetch passes a timeout signal, so a hung platform cannot hold a sweep");
}

{
  ok(nativeTranscriptSource("teams") === undefined, "registration: before the boot registers them, there is no reader");
  registerNativeTranscriptSources();
  ok((["teams", "meet", "zoom"] as const).every((p) => nativeTranscriptSource(p)?.platform === p), "registration: the boot registers one reader per platform, keyed by platform");
}

console.log(`✓ native-transcripts-test: ${passed} assertions`);
