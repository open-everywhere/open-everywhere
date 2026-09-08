
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-slack-attachments-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

import {
  registerSlackAttachment,
  resolveSlackAttachment,
  persistSlackAttachment,
  resolveSlackAttachmentDurable,
  registerSlackAttachmentResolver,
  _resetSlackAttachmentsForTest,
} from "../agent/channels/slack-attachments.js";
import { parseSlackFiles } from "../agent/channels/slack-events.js";
import {
  resolveGuardedAttachment,
  resolveAttachment,
  setHostEgressLookup,
  getOperationalStore,
  registerOperationalStore,
  resetOperationalStore,
  EGRESS_AUDIT_ROW_FIELDS,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
type OperationalStore = Parameters<typeof registerOperationalStore>[0];
import { fetchSlackAttachment } from "../agent/access/slack-attachment-fetch.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ctx = {
  channel: { kind: "slack" },
  session: { auth: { current: { attributes: { team_id: "T_SA", channel_id: "C_SA", channel_type: "channel" }, principalId: "U_SA", principalType: "slack-user" } } },
} as unknown as BindableContext;

{
  const refs = parseSlackFiles([
    { id: "F1", name: "a.png", mimetype: "image/png", url_private: "https://files.slack.test/F1" },
    { id: "F2", name: "b.pdf", mimetype: "application/pdf", url_private: "https://files.slack.test/F2" },
    { nothing: true },
    "junk",
  ]);
  ok(refs.length === 2, "parseSlackFiles: keeps well-formed entries, drops empty/non-object");
  ok(refs[0].kind === "image" && refs[0].id === "F1" && refs[0].url === "https://files.slack.test/F1", "parseSlackFiles: an image mimetype → kind image, with id/url");
  ok(refs[1].kind === "file" && refs[1].mimeType === "application/pdf", "parseSlackFiles: a non-image mimetype → kind file");
  ok(parseSlackFiles(undefined).length === 0 && parseSlackFiles("x").length === 0, "parseSlackFiles: non-array → []");
}

{
  _resetSlackAttachmentsForTest();
  registerSlackAttachmentResolver();
  registerSlackAttachment("F_KNOWN", { urlPrivate: "https://files.slack.com/files-pri/T/F_KNOWN/a.png", mimeType: "image/png", teamId: "T1" });
  const rec = resolveSlackAttachment("F_KNOWN");
  ok(rec?.urlPrivate === "https://files.slack.com/files-pri/T/F_KNOWN/a.png" && rec?.mimeType === "image/png", "registry: a registered file id resolves to its event url_private + mime");
  ok(rec?.platform === "slack", "registry: the record is stamped platform 'slack' at ingest (attachment-plane provenance)");
  ok(resolveSlackAttachment("F_NOPE") === undefined, "registry: an unregistered file id resolves to undefined (→ fail closed)");
  ok((await resolveAttachment("F_NOPE", ctx)) === undefined, "plane: an unknown id → undefined through resolve (fail closed, no fetch)");
  ok((await resolveGuardedAttachment("F_NOPE", ctx)) === undefined, "plane: an unknown id → undefined through resolveGuarded (fail closed, no fetch)");
  _resetSlackAttachmentsForTest();
}

{
  _resetSlackAttachmentsForTest();
  await persistSlackAttachment("F_CSV", { urlPrivate: "https://files.slack.com/files-pri/T/F_CSV/data.csv", mimeType: "text/csv", name: "data.csv", teamId: "T_SA" });
  _resetSlackAttachmentsForTest();
  const rec = await resolveSlackAttachmentDurable("F_CSV");
  ok(rec?.urlPrivate === "https://files.slack.com/files-pri/T/F_CSV/data.csv" && rec?.mimeType === "text/csv" && rec?.name === "data.csv", "durable: a persisted attachment resolves cross-process (in-memory cleared) from the store");
  ok(rec?.platform === "slack", "durable: the cross-process record is stamped platform 'slack' too");
  ok((await resolveSlackAttachmentDurable("F_NOPE")) === undefined, "durable: an unknown id resolves to undefined (→ fail closed)");
}

{
  _resetSlackAttachmentsForTest();
  registerSlackAttachmentResolver();
  registerSlackAttachment("F_PDF", { urlPrivate: "https://files.slack.com/files-pri/T/F_PDF/report.pdf", mimeType: "application/pdf", name: "report.pdf", teamId: "T_SA" });
  const guarded = await resolveGuardedAttachment("F_PDF", ctx);
  ok(guarded !== undefined && guarded.mimeType === "application/pdf" && guarded.name === "report.pdf", "resolveGuarded: metadata (name+mime) comes from the trusted record, NO fetch performed");
  ok(guarded !== undefined && guarded.ref === "slack-file:F_PDF", "resolveGuarded: the ref carries the slack-file provenance stamp");
  _resetSlackAttachmentsForTest();
}

{
  const BOT_TOKEN = "xoxb-sec15-never-real";
  process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
  const realFetch = globalThis.fetch;
  const egress: Array<{ url: string; tokenSent: boolean }> = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const auth = new Headers(init?.headers ?? {}).get("authorization");
    egress.push({ url: u, tokenSent: Boolean(auth?.includes(BOT_TOKEN)) });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) } as unknown as Response;
  }) as typeof fetch;
  setHostEgressLookup(async () => ["93.184.216.34"]);
  const liveStore = getOperationalStore();
  const auditRows: { action: string; detail?: Record<string, unknown> }[] = [];
  registerOperationalStore({
    ...liveStore,
    appendAudit: async (r: { action: string; detail?: Record<string, unknown> }) => void auditRows.push(r),
  } as unknown as OperationalStore);
  resetOperationalStore();
  try {
    const res = await fetchSlackAttachment(ctx, { urlPrivate: "https://files.slack.com/files-pri/T123-F1/screenshot.png", id: "F1" });
    ok(res.status === 200, "host-pin: a genuine files.slack.com url_private is fetched");
    ok(egress.length === 1 && egress[0].url.startsWith("https://files.slack.com/") && egress[0].tokenSent, "host-pin: the bot token rides ONLY to the pinned Slack file host");
    let denied = false;
    try {
      await fetchSlackAttachment(ctx, { urlPrivate: "https://evil.attacker.test/files-pri/steal?x=1", id: "F2" });
    } catch {
      denied = true;
    }
    ok(denied, "host-pin: a spoofed non-Slack host is REFUSED (throws)");
    ok(egress.length === 1, "host-pin: the refusal produced ZERO egress (no fetch, no token, host never contacted)");

    const allow = auditRows.filter((r) => r.action === "slack.attachment.allow").at(-1)?.detail;
    ok(allow !== undefined, "🔴 an allowed attachment download appends a `slack.attachment.allow` row");
    for (const field of EGRESS_AUDIT_ROW_FIELDS) {
      ok(allow![field] !== undefined, `🔴 …carrying the shared egress field \`${field}\``);
    }
    ok(allow!.credential === "SLACK_BOT_TOKEN", "🔴 …naming the credential that rode by REF — the identity an operator can look up");
    ok(!JSON.stringify(allow).includes(BOT_TOKEN), "🔴 …and NEVER the token value, which the seam holds two lines above the row");
    ok(allow!.plane === "host" && allow!.unit === "call", "…on the host plane, at call unit");
    ok(allow!.verb!.toString() === "GET" && allow!.outcome === "allowed", "…with the verb it sent and the outcome it got");
    ok(allow!.route === "direct" || allow!.route === "proxy", "…and the dispatch ROUTE under `route`");
    ok(allow!.via === undefined, "🔴 …and no `via`: that name means the credential identity on the sandbox plane, so it may not mean a route here");

    const deny = auditRows.filter((r) => r.action === "slack.attachment.deny").at(-1)?.detail;
    ok(deny !== undefined, "🔴 the host-pin refusal appends a `slack.attachment.deny` row");
    ok(deny!.outcome === "denied", "…whose outcome is `denied` — a policy refusal, not a failure");
    ok(deny!.credential === null, "🔴 …with `credential: null` as a POSITIVE claim: the host-pin is decided before the token is read");
    ok(deny!.host === "evil.attacker.test", "…naming the host the token was refused to");
  } finally {
    registerOperationalStore(liveStore);
    resetOperationalStore();
    globalThis.fetch = realFetch;
    setHostEgressLookup(undefined);
    delete process.env.SLACK_BOT_TOKEN;
  }
}

console.log(`✓ slack-attachments: ${n} assertions passed (parseSlackFiles · trusted-registry provenance · durable cross-process resolve · guarded metadata-without-fetch · url_private host-pin)`);
