import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-routine-permission-review-"));
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_EGRESS_SPOOF = "1";
process.env.OE_ORG = "acme";

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { addRoutine, updateRoutine } = await import("../agent/routines/store.js");
const { routineGrantKey } = await import("../agent/routines/routine.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { ROUTINE_PERMISSION_KIND } = await import("../agent/approvals/routine-permission.js");
const { declarationForPermissionKind, routinePermissionMemoParts } = await import("../agent/approvals/session-grant.js");
const { emptyRoutinePermissionView, readRoutinePermissionViews } = await import("../agent/routines/permission-review.js");
const listRoutinesTool = (await import("../agent/tools/list_routines.js")).default;

type Routine = import("../agent/routines/routine.js").Routine;
type View = import("../agent/routines/permission-review.js").RoutinePermissionView;

const ORG = "acme";
const SURFACE = "slack/T1/C1";
const OTHER_SURFACE = "slack/T1/C9";
const store = getOperationalStore();
const now = (): string => new Date().toISOString();

routineDispatch.registerRoutineDispatch("slack", {
  resolveTarget: (r) => {
    const channelId = (r.target as { channelId?: string } | undefined)?.channelId;
    if (!channelId) return null;
    return { channel: {} as never, target: { channelId }, mode: "channel", attributes: {}, origin: { platform: "slack", channelId } };
  },
});

async function makeRoutine(id: string, surfaceKey: string, channelId: string): Promise<Routine> {
  return await addRoutine(
    { org: ORG, surfaceKey } as never,
    {
      id,
      org: ORG,
      surfaceKey,
      target: { channelId },
      trigger: { kind: "cron", cron: "0 3 * * *" },
      prompt: "Every night, open a pull request that bumps the changelog.",
      createdBy: "U_OWNER",
      createdAt: now(),
      status: "active",
    } as never,
  );
}

async function refuse(grantKey: string, scopeKey: string): Promise<string> {
  const proposal = {
    org: ORG,
    kind: "pr.open",
    args: { org: ORG, scopeKey, repo: "acme/site", head: "bump", base: "main", title: "bump", body: "", headSha: "abc", requestedBy: "U_OWNER", tainted: false, sessionId: grantKey },
    scopeKey,
    domain: null,
    requestedBy: "U_OWNER",
    channelId: "C_ELSEWHERE",
    chain: { unattended: true },
  };
  try {
    await requestApproval(proposal as never, {});
    return "";
  } catch (e) {
    return String(e);
  }
}

const viewOf = async (r: Routine): Promise<View> => (await readRoutinePermissionViews(ORG, [r], now())).get(r.id) ?? emptyRoutinePermissionView();

const cardRows = async (): Promise<{ id: string; argsJson: string; createdAt: string }[]> =>
  (await store.listPendingActions(ORG)).filter((x) => x.kind === ROUTINE_PERMISSION_KIND) as never;

{
  const asked = routinePermissionMemoParts("routine.permission.asked:pr.open");
  ok(asked?.marker === "asked" && asked.grantKind === "pr.open", "§parse: an ask marker yields its marker and the permission it is about");
  const declined = routinePermissionMemoParts("routine.permission.declined:connector.tool:notion__share_page");
  ok(declined?.marker === "declined" && declined.grantKind === "connector.tool:notion__share_page", "§parse: a decline marker keeps the WHOLE grant kind, colons and all");
  ok(routinePermissionMemoParts("pr.open") === undefined, "§parse: a real grant is NOT a marker — the row that lifts a gate must never read as bookkeeping");
  ok(routinePermissionMemoParts("connector.tool:notion__share_page") === undefined, "§parse: nor is a connector-tool grant");
  ok(routinePermissionMemoParts("routine.permission.asked:") === undefined, "§parse: a bare prefix names no permission, so it yields nothing to render");

  ok(declarationForPermissionKind("pr.open") === "pr.open", "§parse: pr.open is spelled as itself");
  ok(declarationForPermissionKind("connector.tool:notion__share_page") === "tool:notion__share_page", "§parse: a connector-tool grant spells back as the `tool:` declaration edit_routine takes");
  ok(declarationForPermissionKind("connector.op:notion") === undefined, "§parse: a legacy connector.op row lifts no tool, so no declaration is offered for it");
  ok(declarationForPermissionKind("connector.tool:notion") === undefined, "§parse: a stored kind naming no connection segment spells back to nothing — advice edit_routine would refuse is never offered");
  ok(declarationForPermissionKind("skill.create") === undefined, "§parse: a non-declarable kind offers no declaration");
}

const nightly = await makeRoutine("r-nightly", SURFACE, "C1");
{
  ok((await viewOf(nightly)).asks.length === 0, "§waiting: a routine that has asked for nothing has an empty record — the state is read, never assumed");

  const told = await refuse(routineGrantKey(nightly), SURFACE);
  ok(told.includes("ask-unattended"), "§waiting: the fire is still refused — the review surface changes no verdict");
  const card = (await cardRows())[0];
  ok(card !== undefined, "§waiting: the real planner posted one card");

  const view = await viewOf(nightly);
  ok(view.asks.length === 1, "§waiting: the record carries exactly the one permission the routine asked for");
  const ask = view.asks[0]!;
  ok(ask.state === "waiting", "§waiting: a pending card row reads as waiting");
  ok(ask.permission === "open pull requests", "§waiting: the permission is named in the same words a live grant is");
  ok(ask.declaration === "pr.open", "§waiting: …and the declaration is the string edit_routine would take");
  ok(ask.room === SURFACE, "§waiting: the record names the room the card is actually in, read off the row");
  ok(ask.askedAt === card!.createdAt, "§waiting: …and when it was asked, off the same row");
  ok(ask.nextStep.includes(SURFACE) && ask.nextStep.includes("card"), "§waiting: the next step points at the card that is already there");
  ok(view.permissions.length === 0, "§waiting: a permission that was ASKED for is not a permission the routine HAS");
}

const elsewhere = await makeRoutine("r-elsewhere", OTHER_SURFACE, "C9");
{
  await refuse(routineGrantKey(elsewhere), OTHER_SURFACE);
  ok((await cardRows()).length === 2, "§scope: both routines now hold a card in the same org");

  const mine = await viewOf(nightly);
  ok(mine.asks.length === 1 && mine.asks[0]!.room === SURFACE, "§scope: the first routine's record shows ONLY its own card");
  const theirs = await viewOf(elsewhere);
  ok(theirs.asks.length === 1 && theirs.asks[0]!.room === OTHER_SURFACE, "§scope: …and the other routine's shows only the other card");

  const bystander = await makeRoutine("r-bystander", SURFACE, "C1");
  ok((await viewOf(bystander)).asks.length === 0, "§scope: a routine that never asked has an empty record however many cards the org holds");
}

{
  const kind = actionKind(ROUTINE_PERMISSION_KIND);
  const card = (await cardRows()).find((r) => (JSON.parse(r.argsJson) as { routineId?: string }).routineId === "r-nightly")!;
  await kind!.execute(JSON.parse(card.argsJson) as never, "U_CLICKER");
  await store.decidePendingAction(ORG, card.id, "approved", "U_CLICKER", now());

  const view = await viewOf(nightly);
  ok(view.permissions.includes("open pull requests"), "§armed: the click's grant row shows up as a standing permission");
  ok(view.asks.length === 0, "§armed: …and the ask is gone — a permission the routine HOLDS is never still reported as wanted");
  ok(view.permissions.length === 1, "§armed: the ask MARKER left on the key is not rendered as a permission — the one direction this reader may never fail in");
}

const refused = await makeRoutine("r-refused", SURFACE, "C1");
{
  await refuse(routineGrantKey(refused), SURFACE);
  const kind = actionKind(ROUTINE_PERMISSION_KIND);
  const card = (await cardRows()).find((r) => (JSON.parse(r.argsJson) as { routineId?: string }).routineId === "r-refused")!;
  await store.decidePendingAction(ORG, card.id, "rejected", "U_CLICKER", now());
  await kind!.declined!(JSON.parse(card.argsJson) as never, "U_CLICKER");

  const view = await viewOf(refused);
  ok(view.asks.length === 1 && view.asks[0]!.state === "declined", "§declined: the real decline hook's row reads back as declined");
  ok(view.asks[0]!.askedAt === null && view.asks[0]!.room === null, "§declined: no card row survives, so the record claims neither an instant nor a room");
  ok(view.asks[0]!.nextStep.includes("edit_routine"), "§declined: the next step is the one thing that re-opens it — editing the instruction");
  ok(view.permissions.length === 0, "§declined: a decline grants nothing");
}

const lapsed = await makeRoutine("r-lapsed", SURFACE, "C1");
{
  await refuse(routineGrantKey(lapsed), SURFACE);
  const card = (await cardRows()).find((r) => (JSON.parse(r.argsJson) as { routineId?: string }).routineId === "r-lapsed")!;
  await store.decidePendingAction(ORG, card.id, "approved", "U_CLICKER", now());

  const view = await viewOf(lapsed);
  ok(view.asks.length === 1 && view.asks[0]!.state === "lapsed", "§lapsed: an ask marker with no card, no grant and no decline reads as lapsed");
  ok(view.asks[0]!.nextStep.includes(SURFACE), "§lapsed: the next step names the room later runs still point at, which is why this state is worth reporting");
  ok(view.permissions.length === 0, "§lapsed: nothing was armed");
}

{
  const real = store.listPendingActions.bind(store);
  (store as { listPendingActions: unknown }).listPendingActions = async (): Promise<never> => {
    throw new Error("card store is down");
  };
  let broken: View;
  let stillDeclined: View;
  try {
    broken = await viewOf(lapsed);
    stillDeclined = await viewOf(refused);
  } finally {
    (store as { listPendingActions: unknown }).listPendingActions = real;
  }
  ok(broken.asks.length === 1 && broken.asks[0]!.state === "unreadable", "§unreadable: a failed card read reports what it is — not the absence `lapsed` asserts");
  ok(!broken.asks[0]!.nextStep.includes("edit_routine"), "§unreadable: …and it does not send the reader to an edit, which would kill the card this read never saw");
  ok(broken.asks[0]!.nextStep.includes(SURFACE), "§unreadable: it still names the room to look in");
  ok(stillDeclined.asks[0]!.state === "declined", "§unreadable: a decline is a row on the routine's own key, so a broken CARD read cannot move it — the negative control");
  ok((await viewOf(lapsed)).asks[0]!.state === "lapsed", "§unreadable: with the store answering again, the same rows read as lapsed — the state tracks the READ, not the routine");
}

const edited = await makeRoutine("r-edited", SURFACE, "C1");
{
  await refuse(routineGrantKey(edited), SURFACE);
  ok((await viewOf(edited)).asks[0]!.state === "waiting", "§superseded: before the edit the card is simply waiting");

  await updateRoutine(ORG, SURFACE, "r-edited", { promptGeneration: 2 });
  const after = { ...edited, promptGeneration: 2 } as Routine;
  const view = await viewOf(after);
  ok(view.asks.length === 1 && view.asks[0]!.state === "superseded", "§superseded: after an edit the same pending card reads as superseded, because answering it now records nothing");
  ok(view.asks[0]!.room === SURFACE, "§superseded: the record still names the room, so the dead card can be found");
  ok(view.asks[0]!.nextStep.includes("fresh card"), "§superseded: the next step says what actually happens — the next run posts a new one");
  ok(view.permissions.length === 0, "§superseded: the edit took the whole key with it");
}

{
  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel" }, principalId: "U1", principalType: "slack-user" } } },
  } as never;
  const out = (await listRoutinesTool.execute({ includeDisabled: true } as never, ctx)) as {
    routines: { id: string; permissions: string[]; permissionAsks: { state: string; permission: string; room: string | null; nextStep: string }[] }[];
  };
  const seen = new Map(out.routines.map((r) => [r.id, r]));
  ok(seen.get("r-elsewhere") === undefined, "§tool: the listing is still surface-scoped — the other room's routine is not in it");

  const waiting = seen.get("r-lapsed");
  ok(waiting?.permissionAsks.length === 1, "§tool: the record reaches the tool's output — nothing above proves the reader is ever called");
  ok(waiting?.permissionAsks[0]?.state === "lapsed", "§tool: …with the state the rows say");
  ok(seen.get("r-refused")?.permissionAsks[0]?.state === "declined", "§tool: a declined permission is reported per routine, not collapsed across them");
  ok(seen.get("r-nightly")?.permissionAsks.length === 0, "§tool: an armed routine reports no outstanding ask");
  ok(seen.get("r-nightly")?.permissions.includes("open pull requests") === true, "§tool: …and the standing set it did get is unchanged by any of this");
  ok(seen.get("r-nightly")?.permissions.length === 1, "§tool: the standing set carries no card marker");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ routine permission review: ${passed} assertions passed`);
