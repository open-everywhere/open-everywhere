import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

// OPE-2789. A delivery of the SAME principal can join a running turn, and the framework then
// replaces the turn's attribute bag with the joining delivery's. These cases drive the unified
// channel's real `receive` and hand the auth it sends to the framework's real join gate
// (`isSteeringDelivery`, through the session input queue) and its real closing writer
// (`continueTurnAuth`, which the turn step and `joinAnswerToTurn` both call).

delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-turn-join-fence-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const eveModule = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(join(eveRoot, "dist/src", rel)).href)) as T;

type EveAuth = { readonly attributes?: Record<string, unknown>; readonly principalId?: string; readonly principalType?: string; readonly authenticator?: string; readonly issuer?: string };
type EveDelivery = { readonly payloads: readonly { readonly message?: string }[]; readonly auth?: EveAuth; readonly turnPolicy?: "queue" | "steer" };
type Selection = { readonly delivery: EveDelivery; readonly sequences: readonly number[] } | undefined;
interface InputQueue {
  enqueueDelivery(delivery: EveDelivery): { readonly sequence: number } | undefined;
  takeNext(): Selection;
  takeSteering(admitted: ReadonlySet<number>, turn: { callerCallId: string | undefined; principal: string }, options?: { heldSince?: number }): Selection;
  readonly nextAdmission: number;
}
const { SessionInputQueue, isSteeringDelivery } = await eveModule<{
  SessionInputQueue: new (keys: readonly string[]) => InputQueue;
  isSteeringDelivery: (delivery: EveDelivery, turn: { callerCallId: string | undefined; principal: string }, options?: { heldOnPerson?: boolean }) => boolean;
}>("execution/session/input-queue.js");
const { continueTurnAuth, principalOf, resolveTurnPrincipal } = await eveModule<{
  continueTurnAuth: (held: EveAuth | null | undefined, joining: EveAuth | undefined) => EveAuth | null | undefined;
  principalOf: (auth: EveAuth | null | undefined) => string;
  resolveTurnPrincipal: (input: undefined, serialized: Record<string, unknown>) => string;
}>("execution/session/principal.js");
const { AuthKey } = await eveModule<{ AuthKey: { readonly name: string } }>("context/keys.js");

const stubs = await import("./_slack-test-stubs.js");
stubs.registerSlackFixtureMapper();
stubs.registerSlackFixtureCodec();

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
const SLACK_KEY = "slack/T_TJ/C_TJ";
overrideSettingsForTest({ window: { topology: true } });
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", reach: [SLACK_KEY], ambientSupervisor: true, mode: "unified" }), defineDomain({ name: "org", match: "org" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_TJ" ? ["payments"] : []),
});

const unifiedChannel = (await import("../agent/channels/unified.js")).default as unknown as {
  receive(input: unknown, args: { from: (token: string) => unknown }): Promise<unknown>;
};
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { mintWakeId } = await import("../agent/channels/unified-window.js");
const { workTokenForSeat, OE_WORK_REQUEST_ATTR } = await import("../agent/channels/work.js");
const { workStampVerdict } = await import("../agent/access/work-step-stamp.js");
const { fenceTurnJoin, turnJoinIssuer, TURN_JOIN_ISSUER_PREFIX, TURN_JOIN_PER_WAKE_ATTRS } = await import("../agent/channels/turn-join-fence.js");

const SEAT = unifiedSupervisorToken("payments", 1);
const WORK = workTokenForSeat(SEAT);
ok(typeof WORK === "string", "fixture: the seat has a work session token");

// Sends one delivery through the unified channel's real receive, and returns the delivery the
// framework admits from that send: the auth the channel sent and the turn policy it set.
async function viaReceive(token: string, attributes: Record<string, unknown>, principal?: { principalId: string; principalType: string; authenticator: string }, authority?: Record<string, unknown>): Promise<EveDelivery> {
  const sent: { message: string; opts: { auth?: EveAuth; turnPolicy?: "queue" | "steer" } }[] = [];
  const from = () => ({
    async send(message: string, opts: { auth?: EveAuth; turnPolicy?: "queue" | "steer" }) {
      sent.push({ message, opts });
      return {} as never;
    },
  });
  await unifiedChannel.receive(
    {
      message: "a message",
      auth: { ...(principal ?? {}), attributes },
      target: { token, wakeId: mintWakeId(), surfaceKey: SLACK_KEY, origin: { platform: "slack", channelId: "C_TJ", threadTs: "111.1" }, ...(authority !== undefined ? { authority } : {}) },
    },
    { from },
  );
  eq(sent.length, 1, "fixture: receive sends exactly one delivery");
  const opts = sent[0]!.opts;
  return { payloads: [{ message: sent[0]!.message }], ...(opts.auth !== undefined ? { auth: opts.auth } : {}), turnPolicy: opts.turnPolicy ?? "queue" };
}

// A per-wake stamp set, as every window delivery carries one.
const wake = (id: string): Record<string, unknown> => ({ oe_wake_id: `wake-${id}`, oe_delivery_id: `dlv-${id}`, oe_reply_anchor: `slack:C_TJ:${id}`, oe_addressing: "direct-mention" });
const room = { oe_platform: "slack", oe_grain: "standing", oe_window_token: "oe-dom:payments:oe-sup:g1", team_id: "T_TJ", channel_id: "C_TJ" };

// The joining bags this fence must refuse, each against an opening bag A. Each one is a widening:
// it drops a restriction, raises posture, or re-targets a grant, a fire creator or a binding.
const OPENING = { ...room, oe_chat_nonmember: "true", oe_invoker_posture: "external", oe_requester: "U_A", open_everywhere_routine_grant_key: "grant-r1", oe_work_fire_creator: "U_A" };
const WIDENINGS: readonly { readonly name: string; readonly bag: Record<string, unknown> }[] = [
  { name: "drops the non-member restriction", bag: { ...OPENING, oe_chat_nonmember: undefined } },
  { name: "raises the invoker posture", bag: { ...OPENING, oe_invoker_posture: "internal" } },
  { name: "re-targets the routine grant", bag: { ...OPENING, open_everywhere_routine_grant_key: "grant-r2" } },
  { name: "re-targets the fire creator", bag: { ...OPENING, oe_work_fire_creator: "U_ADMIN" } },
  { name: "names another requester", bag: { ...OPENING, oe_requester: "U_B" } },
  { name: "adds an attribute the fence does not know", bag: { ...OPENING, oe_some_future_grant: "x" } },
];
const strip = (bag: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(bag).filter(([, v]) => v !== undefined));

// Pure fence properties.
{
  const a = { attributes: { ...OPENING, ...wake("1") }, principalId: "", principalType: "", authenticator: "" };
  ok(turnJoinIssuer(a).startsWith(TURN_JOIN_ISSUER_PREFIX), "F0: the fence writes an `oe-join:` issuer");
  eq(turnJoinIssuer(fenceTurnJoin(a)), turnJoinIssuer(a), "F0: the fence is idempotent — a fenced auth fences to the same issuer (receive runs it on an auth the divert already completed)");
  eq(turnJoinIssuer({ ...a, attributes: { ...OPENING, ...wake("2") } }), turnJoinIssuer(a), "F0: per-wake stamps do not move the issuer");
  eq(
    turnJoinIssuer({ ...a, attributes: Object.fromEntries(Object.entries(a.attributes).reverse()) }),
    turnJoinIssuer(a),
    "F0: attribute order does not move the issuer",
  );
  eq([...TURN_JOIN_PER_WAKE_ATTRS].sort(), ["oe_addressing", "oe_delivery_id", "oe_reply_anchor", "oe_wake_id"], "F0: the per-wake list is exactly the four window stamps — every other attribute is authority (fail-closed)");
  for (const w of WIDENINGS) ok(turnJoinIssuer({ ...a, attributes: { ...strip(w.bag), ...wake("2") } }) !== turnJoinIssuer(a), `F0: a bag that ${w.name} moves the issuer`);
  ok(turnJoinIssuer({ ...a, principalId: "U_X" }) !== turnJoinIssuer(a), "F0: the principal fields still count");
  {
    const { oe_requester: _dropped, ...withoutRequester } = a.attributes;
    void _dropped;
    ok(
      turnJoinIssuer({ ...a, attributes: { ...withoutRequester, oe_requester: undefined } }) !== turnJoinIssuer({ ...a, attributes: withoutRequester }),
      "F0: an attribute that is present but undefined hashes apart from the same attribute absent",
    );
  }
  ok(turnJoinIssuer(a, { requester: { kind: "requester", principalId: "U_A" } }) !== turnJoinIssuer(a, { requester: { kind: "requester", principalId: "U_B" } }), "F0: the wake's resolved authority moves the issuer");
}

// Case 1 — the HELD road (a seat window, `queue`): a delivery that arrived after the turn was held
// on a person is admitted whatever the turn policy, when the principal matches.
async function heldRoad(fenced: boolean, joining: Record<string, unknown>): Promise<{ joined: boolean; bag?: Record<string, unknown> }> {
  const queue = new SessionInputQueue([]);
  const opening = await viaReceive(SEAT, { ...OPENING, ...wake("1") });
  const later = await viaReceive(SEAT, { ...strip(joining), ...wake("2") });
  const strip2 = (d: EveDelivery): EveDelivery => (fenced ? d : { ...d, ...(d.auth ? { auth: { ...d.auth, issuer: undefined } } : {}) });
  const first = queue.enqueueDelivery(strip2(opening))!;
  const turn = queue.takeNext()!;
  eq(turn.sequences, [first.sequence], "fixture: the opening delivery starts the turn");
  const heldSince = queue.nextAdmission;
  const second = queue.enqueueDelivery(strip2(later))!;
  const principal = principalOf(turn.delivery.auth);
  const steered = queue.takeSteering(new Set([second.sequence]), { callerCallId: undefined, principal }, { heldSince });
  if (steered === undefined) return { joined: false };
  // The turn step's closing write keeps continueTurnAuth's result for a mid-turn message.
  const bag = continueTurnAuth(turn.delivery.auth, steered.delivery.auth);
  return { joined: true, bag: (bag?.attributes ?? {}) as Record<string, unknown> };
}

{
  const opening = await viaReceive(SEAT, { ...OPENING, ...wake("1") });
  eq(opening.turnPolicy, "queue", "C1: a seat window queues");
  ok(opening.auth?.issuer?.startsWith(TURN_JOIN_ISSUER_PREFIX) === true, "🔴 C1: the unified receive fences a SEAT window delivery — its auth carries the join issuer");
  for (const w of WIDENINGS) {
    const fenced = await heldRoad(true, w.bag);
    eq(fenced.joined, false, `🔴 C1 HELD road: a same-principal delivery that ${w.name} does NOT join the held turn — eve holds it for a turn of its own`);
    const raw = await heldRoad(false, w.bag);
    ok(raw.joined && raw.bag?.oe_wake_id === "wake-2", `C1 control: without the join issuer the same delivery DOES join and its bag replaces the turn's (${w.name}) — the road this fence closes`);
  }
  const same = await heldRoad(true, OPENING);
  ok(same.joined, "C1 negative control: a delivery that differs ONLY in per-wake stamps still joins the held turn");
  eq(same.bag?.oe_wake_id, "wake-2", "C1 negative control: …and its own per-wake stamps replace the earlier ones");
  eq(same.bag?.oe_reply_anchor, "slack:C_TJ:2", "C1 negative control: …its reply anchor included");
  eq(same.bag?.oe_chat_nonmember, "true", "C1 negative control: …while every authority attribute is the turn's own");
}

// Case 1a — the WAKE AUTHORITY road. Two deliveries with the SAME bag but a different resolved wake
// authority row (another requester). `work`, `cancel_work`, the task wake and the approval decision
// read that row through the turn's `oe_wake_id`, so a join that swaps the wake id re-targets them.
{
  const binding = { org: "default", platform: "slack", workspace: "T_TJ", surface: "C_TJ", mode: "channel", visibility: "public", trust: "internal", target: { channelId: "C_TJ" }, threadTs: "111.1" };
  const asker = (id: string) => ({ binding, requester: { kind: "requester", principalId: id }, nonMemberWake: false });
  const bag = { ...room, oe_non_requester: "seat-wake" };
  const run = async (fenced: boolean): Promise<boolean> => {
    const queue = new SessionInputQueue([]);
    const unfence = (d: EveDelivery): EveDelivery => (fenced ? d : { ...d, ...(d.auth ? { auth: { ...d.auth, issuer: undefined } } : {}) });
    const a = await viaReceive(SEAT, { ...bag, ...wake("1") }, undefined, asker("U_MEMBER"));
    const b = await viaReceive(SEAT, { ...bag, ...wake("2") }, undefined, asker("U_ADMIN"));
    queue.enqueueDelivery(unfence(a));
    const turn = queue.takeNext()!;
    const heldSince = queue.nextAdmission;
    const second = queue.enqueueDelivery(unfence(b))!;
    return queue.takeSteering(new Set([second.sequence]), { callerCallId: undefined, principal: principalOf(turn.delivery.auth) }, { heldSince }) !== undefined;
  };
  eq(await run(true), false, "🔴 C1a WAKE AUTHORITY: a delivery with the same bag but another wake requester does NOT join the held seat turn");
  eq(await run(false), true, "C1a control: without the join issuer it joins, and its wake id would re-key every authority read");
  const sameRow = await viaReceive(SEAT, { ...bag, ...wake("3") }, undefined, asker("U_MEMBER"));
  const firstRow = await viaReceive(SEAT, { ...bag, ...wake("4") }, undefined, asker("U_MEMBER"));
  eq(principalOf(sameRow.auth), principalOf(firstRow.auth), "C1a negative control: the same bag with the same wake authority is the same principal");
}

// Case 1b — turn-start batching: the queue folds consecutive same-principal deliveries into one
// turn, which then runs with the latest bag. A fenced delivery with other authority starts its own.
{
  const queue = new SessionInputQueue([]);
  const a = queue.enqueueDelivery(await viaReceive(SEAT, { ...OPENING, ...wake("1") }))!;
  queue.enqueueDelivery(await viaReceive(SEAT, { ...strip(WIDENINGS[0]!.bag), ...wake("2") }));
  eq(queue.takeNext()?.sequences, [a.sequence], "🔴 C1b batching: a queued delivery with other authority is NOT folded into the turn the first one starts");
  const raw = new SessionInputQueue([]);
  const deliveryA = await viaReceive(SEAT, { ...OPENING, ...wake("1") });
  const deliveryB = await viaReceive(SEAT, { ...strip(WIDENINGS[0]!.bag), ...wake("2") });
  const ra = raw.enqueueDelivery({ ...deliveryA, auth: { ...deliveryA.auth, issuer: undefined } })!;
  const rb = raw.enqueueDelivery({ ...deliveryB, auth: { ...deliveryB.auth, issuer: undefined } })!;
  eq(raw.takeNext()?.sequences, [ra.sequence, rb.sequence], "C1b control: without the join issuer eve folds both into ONE turn");
}

// Case 2 — the PROXIED ANSWERS road: a message to the parent that answers a child's question. eve
// resolves the message as an answer only when isSteeringDelivery admits it against the PARENT's
// serialized principal (held on a person), and joinAnswerToTurn then writes continueTurnAuth's
// result into the parent's serialized slot.
{
  const parent = await viaReceive(SEAT, { ...OPENING, ...wake("1") });
  const serialized = { [AuthKey.name]: parent.auth };
  for (const w of WIDENINGS) {
    const message = await viaReceive(SEAT, { ...strip(w.bag), ...wake("2") });
    const resolves = isSteeringDelivery(message, { callerCallId: undefined, principal: resolveTurnPrincipal(undefined, serialized) }, { heldOnPerson: true });
    eq(resolves, false, `🔴 C2 PROXIED road: a message that ${w.name} is NOT resolved as the child's answer, so joinAnswerToTurn never runs for it`);
    assert.throws(() => continueTurnAuth(parent.auth, message.auth), /another principal cannot join/u, `C2: …and eve's writer itself refuses that bag (${w.name})`);
    n++;
    const rawMessage = { ...message, auth: { ...message.auth, issuer: undefined } };
    const rawParent = { [AuthKey.name]: { ...parent.auth, issuer: undefined } };
    ok(
      isSteeringDelivery(rawMessage, { callerCallId: undefined, principal: resolveTurnPrincipal(undefined, rawParent) }, { heldOnPerson: true }) &&
        continueTurnAuth(rawParent[AuthKey.name], rawMessage.auth)?.attributes?.oe_wake_id === "wake-2",
      `C2 control: without the join issuer the message resolves and the writer hands the parent its bag (${w.name})`,
    );
  }
  const same = await viaReceive(SEAT, { ...OPENING, ...wake("2") });
  ok(isSteeringDelivery(same, { callerCallId: undefined, principal: resolveTurnPrincipal(undefined, serialized) }, { heldOnPerson: true }), "C2 negative control: a message with the turn's own authority still resolves");
}

// Case 3 — the STEER road (a work window). A work session's turn takes in every later job by
// design: two jobs run side by side. The receive does NOT fence a work window, and a step runs with
// the bag of the last job it delivers. The verdict checks below are a PIN of the stamp rule only:
// they cannot see whether the gate is wired. The work window's guarantee rests on the wiring tests
// in work-task-key-test.ts §3b (OPE-2783): eve's root approval policy runs `workStampApproval` before
// an `agent` call starts a worker, and a mismatch is refused and reissued.
{
  const jobA = await viaReceive(WORK!, { ...OPENING, ...wake("1"), [OE_WORK_REQUEST_ATTR]: "req-A" });
  const jobB = await viaReceive(WORK!, { ...strip(WIDENINGS[1]!.bag), ...wake("2"), [OE_WORK_REQUEST_ATTR]: "req-B" });
  eq(jobA.turnPolicy, "steer", "C3: a work window steers");
  eq(jobA.auth?.issuer, undefined, "🔴 C3: the receive does NOT fence a work window — its joins are the design");
  const queue = new SessionInputQueue([]);
  queue.enqueueDelivery(jobA);
  const turn = queue.takeNext()!;
  const b = queue.enqueueDelivery(jobB)!;
  const steered = queue.takeSteering(new Set([b.sequence]), { callerCallId: undefined, principal: principalOf(turn.delivery.auth) });
  ok(steered !== undefined, "C3: job B joins job A's open work turn (two jobs side by side)");
  const stepBag = continueTurnAuth(turn.delivery.auth, steered!.delivery.auth)?.attributes ?? {};
  const stamp = stepBag[OE_WORK_REQUEST_ATTR] as string;
  eq(stamp, "req-B", "C3: the step that delivered job B runs with job B's bag");
  eq(workStampVerdict("req-A", stamp).kind, "needs-reissue", "C3 (verdict pin; the gate wiring is work-task-key-test §3b): the stamp rule refuses job A under job B's bag — needs-reissue");
  eq(workStampVerdict("req-B", stamp).kind, "keyed", "C3 negative control: job B starts under its own bag");
}

// Case 4 — real Slack traffic. Slack stamps `working_signs_ts` (the message's own ts) into every
// bag, so a person's later top-level message is another principal: it does NOT join a parked seat
// turn and is NOT folded into the earlier message's turn. It runs as a turn of its own.
{
  const { buildSlackAuth } = await import("../../providers/slack/agent/channels/slack-identity.js");
  const slack = (ts: string) => buildSlackAuth({ channelId: "C_TJ", userId: "U_A", teamId: "T_TJ", channelType: "channel", isPrivate: false, isExternal: false, trustChecked: true, workingSignsTs: ts });
  const first = slack("1700000000.000100");
  const second = slack("1700000000.000200");
  ok(first.attributes.working_signs_ts !== second.attributes.working_signs_ts, "fixture: two Slack messages carry different working_signs_ts");
  const principal = { principalId: first.principalId, principalType: first.principalType, authenticator: first.authenticator };
  const a = await viaReceive(SEAT, { ...first.attributes, ...wake("1") }, principal);
  const b = await viaReceive(SEAT, { ...second.attributes, ...wake("2") }, principal);
  const queue = new SessionInputQueue([]);
  const sa = queue.enqueueDelivery(a)!;
  const turn = queue.takeNext()!;
  eq(turn.sequences, [sa.sequence], "C4: the first Slack message starts the turn");
  const heldSince = queue.nextAdmission;
  const sb = queue.enqueueDelivery(b)!;
  eq(queue.takeSteering(new Set([sb.sequence]), { callerCallId: undefined, principal: principalOf(turn.delivery.auth) }, { heldSince }), undefined, "🔴 C4: the SAME person's next Slack message does not join the parked seat turn — its working_signs_ts is authority to the fence");
  eq(queue.takeNext()?.sequences, [sb.sequence], "C4: …it runs as the next turn of its own");
  const sameMessage = await viaReceive(SEAT, { ...first.attributes, ...wake("3") }, principal);
  eq(principalOf(sameMessage.auth), principalOf(a.auth), "C4 negative control: a delivery with the same Slack bag and new per-wake stamps is the same principal");
}

// Case 5 — an eve pin, not an OE check: a delivery with NO auth keeps the turn's bag. No window
// delivery reaches eve without auth (completeWakeAuth always builds one), so this road is eve-internal.
{
  const parent = await viaReceive(SEAT, { ...OPENING, ...wake("1") });
  eq(continueTurnAuth(parent.auth, undefined), parent.auth, "C5 (eve pin): a mid-turn delivery with no auth keeps the turn's bag (the same object)");
}

console.log(`✓ turn-join-fence: ${n} assertions passed`);
process.exit(0);
