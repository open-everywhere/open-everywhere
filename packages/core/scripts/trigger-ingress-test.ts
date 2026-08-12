
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const dir = join(tmpdir(), `open-everywhere-trigger-ingress-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
const { admitTrigger, deliveryDedupeKey } = await import("../agent/routines/ingress.js");
const { fanOutDelivery } = await import("../agent/routines/github-fanout.js");
const { registerEventNormalizer } = await import("../agent/routines/event-model.js");
const { registerEventScopeGrant } = await import("../agent/routines/event-authz.js");
const { registerEntityRead } = await import("../agent/routines/entity-read.js");

type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;
type TriggerDelivery = import("../agent/routines/event-model.js").TriggerDelivery;
type NormalizedEvent = import("../agent/routines/event-model.js").NormalizedEvent;
type TriggerReport = import("../agent/routines/ingress.js").TriggerReport;

const SLACK_CHANNEL = { __fixture: "slack" } as never;
registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });

registerEntityRead({ platform: "github", read: async () => ({ status: "gone" }) });

const QUEUE_SOURCE = "deploys";

registerEventNormalizer({
  source: QUEUE_SOURCE,
  matchKeys: ["event", "env", "service", "actor"],
  scopeKeys: ["service"],
  scopeKinds: ["tenant", "container"],
  resolvesActor: true,
  normalize(d: TriggerDelivery): NormalizedEvent | null {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(d.body) as Record<string, unknown>;
    } catch {
      return null;
    }
    const event = d.headers["x-bus-event"] ?? "";
    if (!event || event === "heartbeat") return null;
    const service = String(payload["service"] ?? "");
    const env = String(payload["env"] ?? "");
    const actor = String(payload["actor"] ?? "");
    return {
      source: QUEUE_SOURCE,
      event,
      scope: [
        { kind: "tenant", id: "acme" },
        { kind: "container", id: service },
      ],
      ...(actor ? { actor: { id: actor, handle: actor } } : {}),
      fields: { event, env, service, actor },
      ...(d.deliveryId ? { deliveryId: d.deliveryId } : {}),
      summary: `${event} of ${service} to ${env} (by ${actor})`,
    };
  },
});
registerEventScopeGrant({
  source: QUEUE_SOURCE,
  grantsRead(scope, access) {
    const service = scope.find((s) => s.kind === "container")?.id;
    return service !== undefined && (access.repos ?? []).includes(service);
  },
});

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: "acme",
    surfaceKey: "slack/T1/C1",
    target: { channelId: "C1" },
    trigger: { kind: "event", source: QUEUE_SOURCE, filter: { under: [{ kind: "container", id: "checkout" }] } },
    prompt: "Tell the channel about the deploy.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

interface Fired {
  channel: unknown;
  message: string;
  target: unknown;
}

function harness(routines: Routine[], grantedServices: string[] = ["checkout"]) {
  const fired: Fired[] = [];
  const audited: AuditInput[] = [];
  return {
    fired,
    audited,
    skips: (reason: string) => audited.filter((a) => a.action === "routine.skip" && (a.detail as { reason?: string })?.reason === reason),
    deps: {
      to: ((channel: unknown, target: unknown) => ({
        send: (message: string) => {
          fired.push({ channel, message, target });
          return Promise.resolve();
        },
      })) as never,
      org: "acme",
      listRoutines: async () => routines,
      audit: async (e: AuditInput) => {
        audited.push(e);
      },
      grant: { resolve: () => ({ repos: grantedServices }) as never },
    },
  };
}

{
  const raw = readFileSync(join(REPO, "packages/core/agent/routines/ingress.ts"), "utf8");
  const src = raw
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  const noOutbound = src.replaceAll("RouteHandlerArgs", "");
  ok(noOutbound.includes("Request") === false, "seam: the only `Request`-shaped token in ingress.ts is eve's OUTBOUND RouteHandlerArgs — no inbound request type crosses the funnel");
  for (const forbidden of ["req.", "new Response", "statusCode", "visibilityTimeout", "queueUrl", "ARN", "http"]) {
    ok(src.includes(forbidden) === false, `seam: routines/ingress.ts mentions no "${forbidden}" — no hosting topology crosses the funnel`);
  }
  for (const vendor of ["github", "notion", "linear", "x-hub-signature"]) {
    ok(src.toLowerCase().includes(vendor) === false, `seam: routines/ingress.ts carries no "${vendor}" string in CODE — the routing plane is vendor-free`);
  }
  const slackLines = src.split("\n").filter((l) => /slack/i.test(l));
  ok(
    slackLines.length === 4,
    `seam: exactly 4 Slack-coupled code lines remain in the routing plane (the live trust recheck), got ${slackLines.length} — a new one is a vendor leak, a removed one is progress`,
  );
  ok(
    slackLines.every((l) => l.includes("slack-bridge") || l.includes("slackChannelId") || l.includes('"slack"')),
    "seam: …and every one of them belongs to the trust-recheck block — no vendor string has leaked into filtering, granting or hydration",
  );
  const adapter = readFileSync(join(REPO, "packages/core/agent/routines/github-fanout.ts"), "utf8");
  ok(adapter.includes("x-github-event"), "adapter: the GitHub header name stayed in the ADAPTER, which is the ingress that received it");
  ok(/\basync function fanOut\(/.test(adapter) === false, "adapter: the fan-out loop is GONE from github-fanout.ts — there is exactly one copy of it, in ingress.ts");
}

interface QueueMessage {
  readonly messageId: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly body: string;
}
async function consumeQueueBatch(messages: readonly QueueMessage[], deps: unknown): Promise<{ delete: string[]; redrive: string[]; reports: TriggerReport[] }> {
  const out = { delete: [] as string[], redrive: [] as string[], reports: [] as TriggerReport[] };
  for (const m of messages) {
    let report: TriggerReport;
    try {
      report = await admitTrigger(
        {
          source: QUEUE_SOURCE,
          headers: m.attributes,
          body: m.body,
          deliveryId: m.messageId,
          receivedAt: new Date().toISOString(),
        },
        deps as Parameters<typeof admitTrigger>[1],
      );
    } catch {
      out.redrive.push(m.messageId);
      continue;
    }
    out.reports.push(report);
    out.delete.push(m.messageId);
  }
  return out;
}

{
  const h = harness([routine({ id: "r-queue" })]);
  const result = await consumeQueueBatch(
    [{ messageId: "msg-1", attributes: { "x-bus-event": "deploy.succeeded" }, body: JSON.stringify({ service: "checkout", env: "prod", actor: "ci-bot" }) }],
    h.deps,
  );
  ok(h.fired.length === 1, "🔴 queue: a delivery that never touched HTTP FIRED a routine — the seam is genuinely transport-agnostic, not HTTP-with-extra-steps");
  const msg = h.fired[0]!;
  ok(msg.message.includes("deploy.succeeded of checkout to prod"), "🔴 queue: the fired message carries the event's own code-rendered summary — output reached its destination, not merely a code path");
  ok(msg.message.includes("Tell the channel about the deploy."), "queue: …and the routine's operator-authored prompt is in it");
  ok((msg.target as { channelId?: string })?.channelId === "C1", "queue: …addressed to the routine's own surface target");
  ok(result.reports[0]!.accepted && result.reports[0]!.fired === 1 && result.reports[0]!.matched === 1, "queue: the TriggerReport tells the consumer what happened without it knowing what a routine is");
  ok(result.delete.length === 1 && result.redrive.length === 0, "queue: the consumer deleted the message off a report it could act on — the one transport-shaped value crosses OUTWARD");
}

{
  const h = harness([routine({ id: "r-unreg" })]);
  const unregistered = await admitTrigger(
    { source: "a-source-nobody-registered", headers: {}, body: "{}", receivedAt: new Date().toISOString() },
    h.deps as never,
  );
  ok(unregistered.accepted === false, "report: an UNREGISTERED source is refused — resolution is by declared source and a miss is a refusal, never a fallback");
  ok((unregistered.reason ?? "").includes("no normalizer registered"), "report: …and the reason says which registry refused it");
  ok(h.fired.length === 0, "report: an unregistered source fires nothing");

  const unmodelled = await admitTrigger(
    { source: QUEUE_SOURCE, headers: { "x-bus-event": "heartbeat" }, body: "{}", deliveryId: "msg-hb", receivedAt: new Date().toISOString() },
    h.deps as never,
  );
  ok(unmodelled.accepted === false && h.fired.length === 0, "report: an event the source does not model (the `ping` analogue) is refused, not an error");

  const defective = await admitTrigger(
    { source: QUEUE_SOURCE, headers: { "x-bus-event": "deploy.succeeded" }, body: "NOT JSON", deliveryId: "msg-bad", receivedAt: new Date().toISOString() },
    h.deps as never,
  );
  ok(defective.accepted === false && h.fired.length === 0, "report: an unparseable body is a refusal, NOT a throw — a throw on a per-delivery path is how an ingress 500s and provokes a redelivery storm");
}

{
  const h = harness([routine({ id: "r-dedupe" })]);
  const send = (id: string) =>
    admitTrigger(
      {
        source: QUEUE_SOURCE,
        headers: { "x-bus-event": "deploy.succeeded" },
        body: JSON.stringify({ service: "checkout", env: "prod", actor: "ci-bot" }),
        deliveryId: id,
        receivedAt: new Date().toISOString(),
      },
      h.deps as never,
    );
  const first = await send("msg-dupe");
  const second = await send("msg-dupe");
  ok(first.accepted && first.fired === 1, "dedupe: the first sighting fires");
  ok(second.accepted === false && h.fired.length === 1, "🔴 dedupe: the SAME id again fires NOTHING — a queue consumer inherits the replay guard for free, without implementing one");
  ok((second.reason ?? "").includes("replay"), "dedupe: …and the report says WHY, so the consumer still deletes rather than redriving");

  ok(
    deliveryDedupeKey("deploys", "msg-1") !== deliveryDedupeKey("github", "msg-1"),
    "🔴 dedupe: the key is SOURCE-SCOPED — two transports whose id spaces overlap (a queue UUID and a vendor delivery id) must not suppress each other's deliveries",
  );
}

{
  const gh = (over: Partial<Routine>): Routine => ({
    org: "acme",
    surfaceKey: "slack/T1/C1",
    target: { channelId: "C1" },
    trigger: { kind: "event", source: "github", filter: { under: [{ kind: "container", id: "acme/web" }] } },
    prompt: "Say something about the PR.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    id: "r-gh",
    ...over,
  });
  const h = harness([gh({})], ["acme/web"]);
  const body = JSON.stringify({
    action: "opened",
    pull_request: { number: 4, title: "Add retries", html_url: "https://github.com/acme/web/pull/4" },
    repository: { full_name: "acme/web" },
    sender: { login: "alice" },
  });
  const report = await fanOutDelivery(body, "pull_request", "gh-1", h.deps as never);
  ok(h.fired.length === 1 && h.fired[0]!.message.includes("Add retries"), "github: the HTTP-shaped adapter still fires, and the PR title reached the sink");
  ok(report.accepted && report.matched === 1 && report.fired === 1, "github: …and it now returns the same TriggerReport a queue consumer gets — ONE contract, two transports");
}

{
  const h = harness([routine({ id: "r-lost" })]);
  const deps = {
    ...h.deps,
    to: (() => ({ send: () => Promise.reject(new Error("channel_not_found")) })) as never,
  };
  const report = await admitTrigger(
    {
      source: QUEUE_SOURCE,
      headers: { "x-bus-event": "deploy.succeeded" },
      body: JSON.stringify({ service: "checkout", env: "prod", actor: "ci-bot" }),
      deliveryId: "msg-lost",
      receivedAt: new Date().toISOString(),
    },
    deps as never,
  );
  ok(report.accepted && report.matched === 1, "lost fire: the delivery was still admitted and still matched");
  ok(report.fired === 0, "🔴 lost fire: `fired` is 0 — a rejected delivery is a MATCH that never reached a room, and reporting it as fired would be the OPE-181 failure in miniature");
  ok(report.skipped === 1, "lost fire: it is counted as skipped, so matched === fired + skipped holds");
  ok(h.audited.some((a) => a.action === "routine.fire_lost"), "lost fire: …and the forensic row is still written (the strike fold is unchanged by the extraction)");
}

{
  const h = harness([routine({ id: "r-ungranted" })], ["some-other-service"]);
  const report = await admitTrigger(
    {
      source: QUEUE_SOURCE,
      headers: { "x-bus-event": "deploy.succeeded" },
      body: JSON.stringify({ service: "checkout", env: "prod", actor: "ci-bot" }),
      deliveryId: "msg-ungranted",
      receivedAt: new Date().toISOString(),
    },
    h.deps as never,
  );
  ok(h.fired.length === 0, "grant: an ungranted scope fires nothing, on the queue transport exactly as on the HTTP one");
  ok(report.matched === 1 && report.fired === 0 && report.skipped === 1, "grant: the report distinguishes 'your filter matched but was refused' from 'your filter matched nothing' — different problems, different fixes");
  ok(h.skips("grant_refused").length === 1, "grant: …and the audited skip row is written below the seam, so no transport can forget to write it");
}

console.log(`✓ trigger-ingress: ${passed} assertions passed`);
