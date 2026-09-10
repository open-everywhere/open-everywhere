import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

const dir = join(tmpdir(), `oe-consent-resume-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
_setDeploymentIdentityForTest({ org: undefined });
const ORG = "default";

const cr = await import("../agent/connections/consent-resume.js");
const cb = await import("../agent/connections/oe-oauth-callback.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { REPLY_DEDUPE_SKIPPED_ID } = await import("../agent/channels/reply-post.js");
import type { ConsentOrigin, ConsentResumeRecord } from "../agent/connections/consent-resume.js";
import type { ReplyTarget } from "../agent/channels/reply-post.js";
import type { OeOauthCallbackCompleter } from "../agent/connections/oe-oauth-callback.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const T0 = 1_800_000_000_000;
const TTL = 15 * 60 * 1000;

const SLACK_ORIGIN: ConsentOrigin = {
  org: ORG,
  surfaceKey: "slack/T123/C456",
  target: { platform: "slack", channelId: "C456", threadTs: "1712.99" },
  principalId: "U777",
  sessionId: "sess-abc",
};

const record = (over: Partial<ConsentResumeRecord> = {}): ConsentResumeRecord => ({
  detourId: "det-1",
  connector: "notion",
  origin: SLACK_ORIGIN,
  startedAtMs: T0,
  expiresAtMs: T0 + TTL,
  ...over,
});

function harness(opts: { readonly nowMs: number; readonly postResult?: string; readonly postThrows?: boolean }) {
  const posted: { target: ReplyTarget; text: string }[] = [];
  return {
    posted,
    deps: {
      nowMs: () => opts.nowMs,
      post: async (target: ReplyTarget, text: string) => {
        if (opts.postThrows) throw new Error("surface down");
        posted.push({ target, text });
        return opts.postResult ?? "msg-1";
      },
    },
  };
}

{
  const r = record();
  ok(cr.consentResumeVerdict({ record: r, nowMs: T0 + 1 }) === "offer", "inside the window ⇒ offer");
  ok(cr.consentResumeVerdict({ record: r, nowMs: T0 + TTL + 1 }) === "expired", "past the window ⇒ expired");
  ok(cr.consentResumeVerdict({ record: r, nowMs: T0 + TTL }) === "offer", "exactly at expiry ⇒ still inside its own window");
}

{
  const h = harness({ nowMs: T0 + 60_000 });
  const out = await cr.resumeAfterConsent(record(), h.deps);
  ok(out.verdict === "offer" && out.delivered, "offer path reports a delivered offer");
  ok(h.posted.length === 1, "offer path posts exactly one line");
  ok(h.posted[0]?.text === cr.consentResumeOfferLine(record()), "the posted line is the offer line");
  const t = h.posted[0]?.target as { platform: string; channelId: string; threadTs?: string };
  ok(t.platform === "slack" && t.channelId === "C456" && t.threadTs === "1712.99", "the line goes to the originating room and thread");
  ok(/say the word/i.test(h.posted[0]?.text ?? ""), "the offer line asks the person to say the word");
  ok(!/picking up|resuming now|I have run/i.test(h.posted[0]?.text ?? ""), "the offer line never claims the request already resumed");
}

{
  const h = harness({ nowMs: T0 + TTL + 1 });
  const out = await cr.resumeAfterConsent(record(), h.deps);
  ok(out.verdict === "expired", "past the window the outcome is expired");
  ok(h.posted.length === 1 && h.posted[0]?.text === cr.consentExpiredLine(record()), "expired path posts the fresh-ask line");
  ok(/ask me again/i.test(h.posted[0]?.text ?? ""), "the expired line asks for a fresh request");
  ok(h.posted[0]?.text !== cr.consentResumeOfferLine(record()), "the expired line is not the offer line");
}

{
  const thrown = harness({ nowMs: T0 + 60_000, postThrows: true });
  ok((await cr.resumeAfterConsent(record(), thrown.deps)).delivered === false, "a post that throws reports delivered:false");

  const skipped = harness({ nowMs: T0 + 60_000, postResult: REPLY_DEDUPE_SKIPPED_ID });
  const out = await cr.resumeAfterConsent(record(), skipped.deps);
  ok(out.delivered === false, "a SKIPPED post reports delivered:false, not a silent success");
  ok(out.verdict === "offer", "a skipped delivery does not change the verdict");
  const landed = harness({ nowMs: T0 + 60_000, postResult: "1712.100" });
  ok((await cr.resumeAfterConsent(record(), landed.deps)).delivered === true, "an ordinary post id reports delivered:true");
}

{
  const detourId = "det-linked-42";
  const memberOrigin: ConsentOrigin = { ...SLACK_ORIGIN, principalId: "U-requester" };
  const built = await cr.recordConsentDetour({ connector: "notion", origin: memberOrigin, nowMs: T0, ttlMs: TTL, detourId });
  ok(built.expiresAtMs === T0 + TTL, "the record's expiry is the detour instant plus the link's own TTL");
  const h = harness({ nowMs: T0 + 1000 });
  await cr.resumeAfterConsent(built, h.deps);

  const rows = await getOperationalStore().readAudit({ org: ORG });
  const detour = rows.find((r) => r.action === "connector.consent_detour" && (r.detail as { detourId?: string })?.detourId === detourId);
  const resumed = rows.find((r) => r.action === "connector.consent_resume" && (r.detail as { detourId?: string })?.detourId === detourId);
  ok(!!detour, "the detour writes a connector.consent_detour row");
  ok(!!resumed, "the return hop writes a connector.consent_resume row");
  ok(detour?.principalId === "U-requester" && resumed?.principalId === "U-requester", "both rows name the person the link was minted FOR");
  ok(detour?.principalId !== "U777", "neither row falls back to the turn's acting principal");
  ok((resumed?.detail as { verdict?: string })?.verdict === "offer", "the resume row records the verdict it acted on");
  ok((resumed?.detail as { delivered?: boolean })?.delivered === true, "the resume row records whether the line landed");
  ok((resumed?.detail as { pausedSession?: string })?.pausedSession === "sess-abc", "the resume row names the paused session");
  ok(detour?.platform === "slack" && detour?.workspace === "T123" && detour?.surface === "C456", "the audit where is split out of the origin's surfaceKey");
  const blob = JSON.stringify([detour?.detail, resumed?.detail]);
  ok(!/https?:\/\//.test(blob), "no URL — capability-bearing or otherwise — reaches an audit row");

  const noSession = await cr.recordConsentDetour({
    connector: "notion",
    origin: { org: ORG, surfaceKey: "slack/T123/C456", target: { platform: "slack", channelId: "C456" }, principalId: "U9" },
    nowMs: T0,
    ttlMs: TTL,
    detourId: "det-no-session",
  });
  ok(noSession.origin.sessionId === undefined, "a record with no paused session carries no sessionId");
  const rows2 = await getOperationalStore().readAudit({ org: ORG });
  const row2 = rows2.find((r) => (r.detail as { detourId?: string })?.detourId === "det-no-session");
  ok(!!row2 && !("pausedSession" in (row2.detail as object)), "the audit row omits pausedSession rather than writing an empty one");
}

{
  const round = cr.asConsentResumeRecord(JSON.parse(JSON.stringify(record())));
  ok(round?.detourId === "det-1" && round?.origin.target.platform === "slack", "a record survives the persistence round-trip");
  ok(cr.asConsentResumeRecord(undefined) === undefined, "undefined is not a record");
  ok(cr.asConsentResumeRecord(null) === undefined, "null is not a record");
  ok(cr.asConsentResumeRecord("det-1") === undefined, "a string is not a record");
  ok(cr.asConsentResumeRecord({ ...record(), detourId: "" }) === undefined, "an empty detourId is refused");
  ok(cr.asConsentResumeRecord({ ...record(), connector: 7 }) === undefined, "a non-string connector is refused");
  ok(cr.asConsentResumeRecord({ ...record(), expiresAtMs: "soon" }) === undefined, "a non-numeric expiry is refused");
  ok(cr.asConsentResumeRecord({ ...record(), origin: undefined }) === undefined, "a record with no origin is refused");
  ok(cr.asConsentResumeRecord({ ...record(), origin: { ...SLACK_ORIGIN, target: undefined } }) === undefined, "an origin with no reply target is refused");
  ok(cr.asConsentResumeRecord({ ...record(), origin: { ...SLACK_ORIGIN, principalId: "" } }) === undefined, "an origin with no principal is refused");
  ok(cr.asConsentResumeRecord({ ...record(), origin: { ...SLACK_ORIGIN, surfaceKey: "" } }) === undefined, "an origin with no surfaceKey is refused");

  const target = (t: unknown) => cr.asConsentResumeRecord({ ...record(), origin: { ...SLACK_ORIGIN, target: t } });
  ok(target({ platform: "slack" }) === undefined, "a slack target with no channelId is refused");
  ok(target({ platform: "discord" }) === undefined, "a discord target with no channelId is refused");
  ok(target({ platform: "notion" }) === undefined, "a notion target with no discussionId is refused");
  ok(target({ platform: "teams", conversationId: "c" }) === undefined, "a teams target with no serviceUrl is refused");
  ok(target({ platform: "github", owner: "o", repo: "r" }) === undefined, "a github target with no issueNumber is refused");
  ok(target({ platform: "linear" }) === undefined, "a linear target with neither an issue nor an agent session is refused");
  ok(target({ platform: "myspace", channelId: "C1" }) === undefined, "an unknown platform is refused");
  ok(target({ platform: "discord", channelId: "C1" }) !== undefined, "a discord target with a channelId is accepted");
  ok(target({ platform: "teams", serviceUrl: "https://s", conversationId: "c" }) !== undefined, "a complete teams target is accepted");
  ok(target({ platform: "github", owner: "o", repo: "r", issueNumber: 7 }) !== undefined, "a complete github target is accepted");
  ok(target({ platform: "linear", issueId: "i" }) !== undefined, "a linear issue target is accepted");
  ok(target({ platform: "linear", agentSessionId: "as" }) !== undefined, "a linear agent-session target is accepted");
  ok(target({ platform: "notion", discussionId: "d" }) !== undefined, "a notion target with a discussionId is accepted");
}

{
  const P = cb.OE_OAUTH_CALLBACK_PATH;
  const call = (completer: OeOauthCallbackCompleter, resume: typeof cr.resumeAfterConsent) =>
    cb.handleOeOauthCallback(new Request(`https://oe.example${P}?state=S&code=C`), completer, { resume });

  const seen: ConsentResumeRecord[] = [];
  const spy = (async (rec: ConsentResumeRecord) => {
    seen.push(rec);
    return { verdict: "offer" as const, delivered: true };
  }) as typeof cr.resumeAfterConsent;

  const withCarriage: OeOauthCallbackCompleter = async () => ({ ok: true, connectionName: "notion", consent: JSON.parse(JSON.stringify(record())) });
  const res = await call(withCarriage, spy);
  const html = await res.text();
  ok(res.status === 200, "a completed authorization still renders 200");
  ok(seen.length === 1 && seen[0]?.detourId === "det-1", "the route hands the re-validated record to the resume plane");
  ok(/tell me there to carry on/i.test(html), "the page points the person back at their conversation");

  seen.length = 0;
  const noCarriage: OeOauthCallbackCompleter = async () => ({ ok: true, connectionName: "notion" });
  const html2 = await (await call(noCarriage, spy)).text();
  ok(seen.length === 0, "a completion with no carriage does nothing — there was no interrupted request");
  ok(!/carry on|paused/i.test(html2), "the page claims nothing when there is nothing to pick up");

  seen.length = 0;
  const junkCarriage: OeOauthCallbackCompleter = async () => ({ ok: true, connectionName: "notion", consent: { detourId: "d" } });
  await call(junkCarriage, spy);
  ok(seen.length === 0, "a partial carriage is refused at the route, not acted on");

  const failing = (async () => ({ verdict: "offer" as const, delivered: false })) as typeof cr.resumeAfterConsent;
  const html3 = await (await call(withCarriage, failing)).text();
  ok(/could not reach it from here/i.test(html3), "an undelivered line says so on the page");
  ok(!/tell me there to carry on/i.test(html3), "an undelivered line never also claims the room was told");

  const expired = (async () => ({ verdict: "expired" as const, delivered: true })) as typeof cr.resumeAfterConsent;
  const html4 = await (await call(withCarriage, expired)).text();
  ok(/too old to pick up/i.test(html4), "an expired return hop says so on the page");

  {
    let calls = 0;
    const singleUse: OeOauthCallbackCompleter = async () => {
      calls++;
      return calls === 1
        ? { ok: true, connectionName: "notion", consent: JSON.parse(JSON.stringify(record({ detourId: "det-replay" }))) }
        : { ok: false, detail: "authorization state already used" };
    };
    const before = (await getOperationalStore().readAudit({ org: ORG })).length;
    seen.length = 0;
    await call(singleUse, spy);
    ok(seen.length === 1, "the first callback runs the return hop once");

    const replay = await call(singleUse, spy);
    ok(replay.status === 502, "a replayed state renders the exchange-rejected page, not a second success");
    ok(seen.length === 1, "🔴 the replayed callback runs NO second return hop — the carriage was spent");
    const after = await getOperationalStore().readAudit({ org: ORG });
    ok(after.filter((r) => (r.detail as { detourId?: string })?.detourId === "det-replay").length === 0, "the spy path writes no audit row, so the count below reads only the route's own behaviour");
    ok(after.length === before, "a replayed callback adds no audit row at all");
  }

  const boom = (async () => {
    throw new Error("store down");
  }) as typeof cr.resumeAfterConsent;
  const res5 = await call(withCarriage, boom);
  ok(res5.status === 200, "a throwing resume still renders the 200 authorized page");
  ok(!/carry on|too old/i.test(await res5.text()), "a throwing resume claims nothing about the conversation");
}

console.log(`consent-resume: ${n} assertions passed`);
