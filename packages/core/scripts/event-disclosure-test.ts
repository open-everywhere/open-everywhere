import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

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

const dir = join(tmpdir(), `open-everywhere-event-disclosure-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
delete process.env.OE_EVENT_MAX_FANOUT;

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
const { fanOutDelivery } = await import("../agent/routines/github-fanout.js");
const { computeAudienceFloor } = await import("../agent/access/audience-floor.js");
const { classifyFireDisclosure, checkFireDisclosure, fireWithheldNoticeText, announceFireWithheld } = await import(
  "../agent/routines/fire-disclosure.js"
);
type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;
type RoomRoster = import("../agent/access/audience-floor.js").RoomRoster;
type HydrationOutcome = import("../agent/routines/entity-read.js").HydrationOutcome;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;

const SLACK_CHANNEL = { __fixture: "slack" } as never;
registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });

const OBSERVED_GUEST: RoomRoster = { humanMemberIds: ["U1", "U2"], resolved: true, isPrivate: true, hasGuest: true };
const INTERNAL: RoomRoster = { humanMemberIds: ["U1", "U2"], resolved: true, isPrivate: true, hasGuest: false };
const UNOBSERVABLE: RoomRoster = { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false };

const PROMPT = "Watch for security issues in acme/payments and tell me immediately.";

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: "acme",
    surfaceKey: "slack/T1/C1",
    target: { channelId: "C1" },
    trigger: { kind: "event", source: "github" },
    prompt: PROMPT,
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

const CUSTOMER_ID = "cus_9F3XQ21LIVE";
const ISSUE_BODY = JSON.stringify({
  action: "opened",
  issue: { number: 7, title: `Leak affecting ${CUSTOMER_ID}`, html_url: "https://github.com/acme/payments/issues/7" },
  repository: { full_name: "acme/payments" },
  sender: { login: "alice" },
});

interface Fired {
  channel: unknown;
  message: string;
}

function harness(routines: Routine[], rosters: Record<string, RoomRoster>, hydration: HydrationOutcome = { status: "unsupported" }) {
  const fired: Fired[] = [];
  const audited: AuditInput[] = [];
  const posts: string[] = [];
  const reads: string[] = [];
  return {
    fired,
    audited,
    posts,
    reads,
    rows: (action: string) => audited.filter((a) => a.action === action),
    skips: (reason: string) => audited.filter((a) => a.action === "routine.skip" && (a.detail as { reason?: string })?.reason === reason),
    deps: {
      to: ((channel: unknown) => ({
        send: (message: string) => {
          fired.push({ channel, message });
          return Promise.resolve();
        },
      })) as never,
      listRoutines: async () => routines,
      audit: async (e: AuditInput) => {
        audited.push(e);
      },
      grant: { resolve: () => ({ repos: ["acme/payments"] }) as never },
      hydrate: {
        read: async (platform: string, id: string): Promise<HydrationOutcome> => {
          reads.push(`${platform} ${id}`);
          return hydration;
        },
      },
      disclosure: {
        floor: async (channelKey: string) => {
          const roster = rosters[channelKey] ?? UNOBSERVABLE;
          return { floor: computeAudienceFloor(roster, new Set<string>()), roster };
        },
      },
      notice: {
        post: async (_o: UnifiedWakeOrigin, text: string) => {
          posts.push(text);
          return "ts-1";
        },
      },
    },
  };
}

{
  const v = (roster: RoomRoster) => classifyFireDisclosure({ floor: computeAudienceFloor(roster, new Set<string>()), roster });
  const guestVerdict = v(OBSERVED_GUEST);
  ok(guestVerdict.ok === false, "classifier: an OBSERVED guest floor REFUSES the fire");
  ok(guestVerdict.ok === false && guestVerdict.reason === "audience-floor" && guestVerdict.floor === "guest", "classifier: the refusal names the audience floor");
  ok(v(INTERNAL).ok === true, "classifier: an internal room allows");
  ok(
    v(UNOBSERVABLE).ok === true,
    "🔴 classifier: an UNOBSERVABLE roster ALLOWS — its floor is `guest` by fail-closed default, and refusing on it would silently kill the event plane on every non-Slack surface",
  );
  ok(computeAudienceFloor(UNOBSERVABLE, new Set<string>()) === "guest", "classifier: …and the UNOBSERVABLE floor really is `guest` — the allow is the roster bit, not a floor difference");
  ok(v({ humanMemberIds: ["U1"], resolved: true, isPrivate: true, hasGuest: false }).ok === true, "classifier: an admin-floored room allows");
}

{
  const big = new Set(["U1", "U2", "U3"]);
  for (const roster of [OBSERVED_GUEST, UNOBSERVABLE]) {
    ok(
      computeAudienceFloor(roster, new Set<string>()) === computeAudienceFloor(roster, big) &&
        computeAudienceFloor(roster, big) === "guest",
      "admin-independence: the `guest` verdict is identical for an EMPTY and a fully-matching admin set — which is what makes fire-disclosure.ts's NO_ADMINS honest",
    );
  }
  const internal = INTERNAL;
  ok(
    computeAudienceFloor(internal, new Set<string>()) === "member" && computeAudienceFloor(internal, big) === "admin",
    "admin-independence CONTROL: the admin set changes a non-guest floor, so the independence above is a property of the `guest` branch, not of the whole function",
  );
}

{
  const src = readFileSync(join(REPO, "packages/core/agent/routines/fire-disclosure.ts"), "utf8");
  ok(/from "\.\.\/access\/audience-floor\.js"/.test(src), "single-source: consumer #3 (routines/fire-disclosure.ts) imports the audience-floor seam");
  ok(/export function computeAudienceFloor\b/.test(src) === false, "single-source: consumer #3 does NOT re-roll the floor computation (connector-disclosure-test §1 scans the whole tree for this)");
}

{
  const h = harness([routine({ id: "r-guest1" })], { "slack/T1/C1": OBSERVED_GUEST });
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  ok(h.fired.length === 0, "🔴 withhold: an OBSERVED guest floor stops the fire — the read grant proved the DOMAIN may read it, the ROOM is a different question");
  ok(h.skips("audience_floor").length === 1, "withhold: one `routine.skip` row, reason `audience_floor` — the SHARED forensics vocabulary, not a new action");
  ok(h.rows("routine.fire_lost").length === 0, "🔴 withhold: NO fire_lost row — the row a strike folds onto. Without this, one Slack Connect invite three-strike-disables every routine in the room");
  ok(h.posts.length === 1, "withhold: the room is TOLD something was withheld — a silent skip on an unattended path is the exact failure the audit wedge exists to prevent");
  const detail = h.skips("audience_floor")[0]!.detail as Record<string, unknown>;
  ok(detail["floor"] === "guest" && detail["event"] === "issues", "withhold: the audit row carries the floor and the event — the detail the ROOM may not be told goes here instead");
}

{
  const h = harness([routine({ id: "r-guest2", surfaceKey: "slack/T1/C9", target: { channelId: "C9" } })], { "slack/T1/C9": OBSERVED_GUEST });
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  ok(h.fired.length === 0 && h.skips("audience_floor").length === 1, "withhold: the refusal happens on a CHANNEL turn — no DM-only wall stands in front of this leg (connector narrowing n3 does not apply)");
}

{
  const h = harness([routine({ id: "r-guest3" })], { "slack/T1/C1": OBSERVED_GUEST }, { status: "ok", entity: {
    platform: "github",
    id: "acme/payments#7",
    title: `Leak affecting ${CUSTOMER_ID}`,
    state: "open",
    body: "internal detail",
    url: "https://github.com/acme/payments/issues/7",
    updatedAt: "2026-07-26T10:00:00.000Z",
    fetchedAt: "2026-03-30T11:30:00.000Z",
  } });
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  ok(
    h.reads.length === 0,
    "🔴 placement: a withheld routine spends NO hydration read — the disclosure check sits BEFORE hydration, so a room that may not hear the content never causes it to be fetched",
  );
}

{
  const h = harness([routine({ id: "r-guest4" })], { "slack/T1/C1": OBSERVED_GUEST });
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  const text = h.posts[0]!;
  ok(text.includes("r-guest4"), "notice: names the OE-minted routine id — the one handle an operator can act on");
  ok(text.includes(CUSTOMER_ID) === false, "🔴 notice: does NOT carry the customer id from the event title — the whole point of withholding");
  ok(text.includes("acme/payments") === false, "🔴 notice: does NOT carry the scope path — naming the repo tells the guest audience what is being watched");
  ok(text.includes(PROMPT) === false && text.includes("security issues") === false, "🔴 notice: does NOT echo the routine's PROMPT (disable-notice.ts does; here it would leak the routine's whole intent)");
  ok(text.includes("issues") === false || text.includes("opened") === false, "notice: does not render the event summary");
  const bare = fireWithheldNoticeText("r-xyz");
  ok(bare.includes("r-xyz") && bare.includes(CUSTOMER_ID) === false, "notice: the pure text function has exactly one variable — the routine id");
}

{
  const h = harness([routine({ id: "r-unobs" })], {});
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  ok(h.fired.length === 1, "🔴 inert: an unobservable roster still FIRES — this is every non-Slack surface today, and refusing there would be a silent outage of the whole event plane");
  ok(h.skips("audience_floor").length === 0 && h.posts.length === 0, "inert: an unobservable room writes NO disclosure row and posts NO notice");

  const baseline = harness([routine({ id: "r-unobs-b" })], {});
  const { disclosure: _dropped, ...withoutDisclosure } = baseline.deps;
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, withoutDisclosure as typeof baseline.deps);
  ok(baseline.fired.length === 1 && baseline.fired[0]!.message === h.fired[0]!.message, "inert: the fire's message is BYTE-IDENTICAL with and without the disclosure leg");
}

{
  const h = harness([routine({ id: "r-throttle" })], { "slack/T1/C1": OBSERVED_GUEST });
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  ok(h.fired.length === 0, "throttle: none of the three deliveries fired");
  ok(h.skips("audience_floor").length === 1, "throttle: three withholds in the hour window emit ONE skip row (fire-audit.ts's existing per-(routine, reason) throttle)");
  ok(
    h.posts.length === 1,
    "🔴 throttle: …and exactly ONE notice. The announcement is gated on the row having been EMITTED, so an inbound delivery stream cannot turn a standing misconfiguration into channel spam — one visibility mechanism, one rate limit, not two",
  );
}

{
  process.env.OE_EVENT_MAX_FANOUT = "1";
  const h = harness(
    [
      routine({ id: "r-cap-guest", surfaceKey: "slack/T1/CEXT", target: { channelId: "CEXT" } }),
      routine({ id: "r-cap-ok", surfaceKey: "slack/T1/CINT", target: { channelId: "CINT" } }),
    ],
    { "slack/T1/CEXT": OBSERVED_GUEST, "slack/T1/CINT": INTERNAL },
  );
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, h.deps);
  ok(h.fired.length === 1, "cap: with cap=1, the WITHHELD routine does not consume the slot — the internal room still gets its fire");
  ok(h.skips("fanout_cap").length === 0, "cap: and nothing was dropped for being over cap");
  delete process.env.OE_EVENT_MAX_FANOUT;
}

{
  const h = harness([routine({ id: "r-throw" })], {});
  const deps = {
    ...h.deps,
    disclosure: {
      floor: async () => {
        throw new Error("slack conversations.info exploded");
      },
    },
  };
  await fanOutDelivery(ISSUE_BODY, "issues", undefined, deps as typeof h.deps);
  ok(h.fired.length === 1, "fail-open: a THROWING floor seam still fires — a disclosure layer above a fail-closed authz gate must not turn a platform blip into a dead routine fleet");
  ok((await checkFireDisclosure("slack/T1/C1", { floor: async () => { throw new Error("boom"); } })).ok === true, "fail-open: checkFireDisclosure swallows the throw and allows");
}
{
  const landed = await announceFireWithheld("r-noorigin", "discord/G1/C1", undefined, {});
  ok(landed === false, "notice: a surface with no declared wake origin gets no notice (and no throw) — the skip row still stands");
  const threw = await announceFireWithheld("r-badpost", "slack/T1/C1", { platform: "slack", channelId: "C1" } as UnifiedWakeOrigin, {
    post: async () => {
      throw new Error("dead token");
    },
  });
  ok(threw === false, "notice: a failed post is swallowed — 'I withheld a fire' must never become the error that takes out the rest of the fan-out loop");
}

console.log(`✓ event-disclosure: ${passed} assertions passed`);
