import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function throwsWith(fn: () => unknown, needle: RegExp, label: string): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg !== null && needle.test(msg), `${label} (got: ${msg ?? "no throw"})`);
}

const dir = mkdtempSync(join(tmpdir(), "oe-routine-fire-eligibility-"));
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });
delete process.env.OE_TRUST;
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: false } });

const { registerSlackTestBridge, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const dispatch = await import("../agent/schedules/dispatch.js");
const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const routineStore = await import("../agent/routines/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_AUDIT, resetRoutineSkipThrottle } = await import("../agent/routines/fire-audit.js");
const { checkFireEligibility, _resetFireEligibilityCachesForTest } = await import("../agent/routines/fire-eligibility.js");
const { applyOutcome, MIN_CONSECUTIVE_FAILURE_SPAN_MS } = await import("../agent/routines/lifecycle.js");
const { foldRoutineOutcome } = await import("../agent/routines/outcome-fold.js");
const { routineMarker } = await import("../agent/routines/routine.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { bindFrom, actingPrincipalId } = await import("../agent/identity/binding.js");
const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");

type Routine = import("../agent/routines/routine.js").Routine;
type Domain = import("../agent/memory/domain.js").Domain;

const ORG = "acme";
const TEAM = "T_ELIG";
const CHAN = "C_ELIG";
const SURFACE = `slack/${TEAM}/${CHAN}`;
const CREATOR = "U_CREATOR";

registerSlackTestBridge({ channel: { __fixture: "slack" } as never, confirmChannelInternal: async () => true });
registerSlackFixtureMapper();
const domain = defineDomain({ name: "eligibility", reach: [SURFACE] });
const DOMAINS: readonly Domain[] = [domain];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [...DOMAINS],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? ["eligibility"] : []),
});

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "Post the daily digest.",
    createdBy: CREATOR,
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-02T12:00:00.000Z",
    ...over,
  };
}

const TEAMS_TENANT = "TEN1";
const TEAMS_CONVERSATION = "19:conv1@thread.tacv2";
const TEAMS_TEAM_ID = "team-1";
const TEAMS_CHANNEL_ID = "19:chan1@thread.tacv2";
const TEAMS_AAD_ID = "aad-0001-creator";
const TEAMS_CREATED_BY = "29:bf-creator";
const TEAMS_SURFACE = `teams/${TEAMS_TENANT}/${TEAMS_CONVERSATION}`;

const teamsFakeChannel = { kind: "teams-fake-elig" };
routineDispatch.registerRoutineDispatch("teams", {
  resolveTarget: (r) => ({
    channel: teamsFakeChannel as never,
    target: { conversationId: TEAMS_CONVERSATION },
    mode: "channel",
    attributes: {
      conversation_id: TEAMS_CONVERSATION,
      team_id: TEAMS_TEAM_ID,
      channel_id: TEAMS_CHANNEL_ID,
      ...(typeof r.target?.["aadObjectId"] === "string" ? { aad_object_id: r.target["aadObjectId"] as string } : {}),
    },
  }),
});

function teamsRoutine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: TEAMS_SURFACE,
    target: { serviceUrl: "https://smba.example.com", conversationId: TEAMS_CONVERSATION, teamId: TEAMS_TEAM_ID, channelId: TEAMS_CHANNEL_ID, aadObjectId: TEAMS_AAD_ID },
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "Post the daily digest.",
    createdBy: TEAMS_CREATED_BY,
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-02T12:00:00.000Z",
    ...over,
  };
}

async function tick(now: Date, receive: unknown, extra: Record<string, unknown> = {}): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to: receive,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} },
    postJobKickoff: async () => "1700000000.0001",
    ...extra,
  } as never);
  await Promise.all(pending);
}

const rejectingReceive = (() => ({
  send: async () => {
    throw new Error("channel_not_found");
  },
})) as never;

{
  const alwaysThrows = async (): Promise<boolean | undefined> => {
    throw new Error("this check must never be called");
  };

  const removed = await checkFireEligibility({
    createdBy: CREATOR,
    platform: "slack",
    roomId: CHAN,
    membershipCheck: async () => false,
    activeCheck: async () => true,
  });
  ok(!removed.eligible && removed.reason === "creator_removed_from_room", "§1: a CONFIRMED non-member skips with reason creator_removed_from_room");

  const inactive = await checkFireEligibility({
    createdBy: CREATOR,
    platform: "slack",
    roomId: CHAN,
    membershipCheck: async () => true,
    activeCheck: async () => false,
  });
  ok(!inactive.eligible && inactive.reason === "creator_account_inactive", "§1: a CONFIRMED inactive account skips with reason creator_account_inactive, independently of membership");

  const both = await checkFireEligibility({
    createdBy: CREATOR,
    platform: "slack",
    roomId: CHAN,
    membershipCheck: async () => true,
    activeCheck: async () => true,
  });
  ok(both.eligible, "§1: a confirmed member with an active account is eligible");

  const unresolvedMember = await checkFireEligibility({
    createdBy: CREATOR,
    platform: "slack",
    roomId: CHAN,
    membershipCheck: async () => undefined,
    activeCheck: async () => true,
  });
  ok(unresolvedMember.eligible, "§1: 🔴 fail-CLOSED means a CONFIRMED no skips — it does not mean an UNRESOLVED probe skips. 'Cannot check' is a real answer, not a default of removed");

  const unresolvedBoth = await checkFireEligibility({
    createdBy: CREATOR,
    platform: "slack",
    roomId: CHAN,
    membershipCheck: async () => undefined,
    activeCheck: async () => undefined,
  });
  ok(unresolvedBoth.eligible, "§1: both probes unresolvable is still eligible, never a manufactured skip");

  ok(
    (await checkFireEligibility({ createdBy: undefined, platform: "slack", roomId: CHAN, membershipCheck: alwaysThrows, activeCheck: alwaysThrows })).eligible,
    "§1: no creator on the row ⇒ nothing to ask — eligible, and the probes are never even called (see the throwing stub)",
  );
  ok(
    (await checkFireEligibility({ createdBy: CREATOR, platform: "discord", roomId: CHAN, membershipCheck: alwaysThrows, activeCheck: alwaysThrows })).eligible,
    "§1: an unsupported platform is a no-op, exactly like fire-creator.ts's recheckFireCreator draws the same Slack-only line — never a manufactured skip on a surface with no check",
  );
  ok(
    (await checkFireEligibility({ createdBy: CREATOR, platform: "slack", roomId: undefined, membershipCheck: alwaysThrows, activeCheck: alwaysThrows })).eligible,
    "§1: no resolvable room ⇒ nothing to ask — eligible",
  );

  const brokenMembership = await checkFireEligibility({
    createdBy: CREATOR,
    platform: "slack",
    roomId: CHAN,
    membershipCheck: async () => {
      throw new Error("network down");
    },
    activeCheck: async () => true,
  });
  ok(brokenMembership.eligible, "§1: a THROWING membership probe degrades to 'unresolved', never a crash and never a manufactured skip");
}

{
  const alwaysThrows = async (): Promise<boolean | undefined> => {
    throw new Error("this check must never be called");
  };

  const removed = await checkFireEligibility({
    createdBy: TEAMS_CREATED_BY,
    platform: "teams",
    roomId: TEAMS_CHANNEL_ID,
    teamsTeamId: TEAMS_TEAM_ID,
    teamsCreatorAadObjectId: TEAMS_AAD_ID,
    teamsMembershipCheck: async () => false,
    teamsActiveCheck: async () => true,
  });
  ok(!removed.eligible && removed.reason === "creator_removed_from_room", "§1b: TEAMS — a CONFIRMED non-member skips with reason creator_removed_from_room");

  const inactive = await checkFireEligibility({
    createdBy: TEAMS_CREATED_BY,
    platform: "teams",
    roomId: TEAMS_CHANNEL_ID,
    teamsTeamId: TEAMS_TEAM_ID,
    teamsCreatorAadObjectId: TEAMS_AAD_ID,
    teamsMembershipCheck: async () => true,
    teamsActiveCheck: async () => false,
  });
  ok(!inactive.eligible && inactive.reason === "creator_account_inactive", "§1b: TEAMS — a CONFIRMED inactive account skips with reason creator_account_inactive, independently of membership");

  const both = await checkFireEligibility({
    createdBy: TEAMS_CREATED_BY,
    platform: "teams",
    roomId: TEAMS_CHANNEL_ID,
    teamsTeamId: TEAMS_TEAM_ID,
    teamsCreatorAadObjectId: TEAMS_AAD_ID,
    teamsMembershipCheck: async () => true,
    teamsActiveCheck: async () => true,
  });
  ok(both.eligible, "§1b: TEAMS — a confirmed member with an active account is eligible");

  const unresolvedBoth = await checkFireEligibility({
    createdBy: TEAMS_CREATED_BY,
    platform: "teams",
    roomId: TEAMS_CHANNEL_ID,
    teamsTeamId: TEAMS_TEAM_ID,
    teamsCreatorAadObjectId: TEAMS_AAD_ID,
    teamsMembershipCheck: async () => undefined,
    teamsActiveCheck: async () => undefined,
  });
  ok(unresolvedBoth.eligible, "§1b: TEAMS — both probes unresolvable is still eligible, never a manufactured skip");

  ok(
    (
      await checkFireEligibility({
        createdBy: TEAMS_CREATED_BY,
        platform: "teams",
        roomId: TEAMS_CHANNEL_ID,
        teamsCreatorAadObjectId: TEAMS_AAD_ID,
        teamsMembershipCheck: alwaysThrows,
        teamsActiveCheck: alwaysThrows,
      })
    ).eligible,
    "§1b: TEAMS — no teamId ⇒ nothing to ask (Graph needs team+channel together) — eligible, probes never called",
  );
  ok(
    (
      await checkFireEligibility({
        createdBy: TEAMS_CREATED_BY,
        platform: "teams",
        roomId: TEAMS_CHANNEL_ID,
        teamsTeamId: TEAMS_TEAM_ID,
        teamsMembershipCheck: alwaysThrows,
        teamsActiveCheck: alwaysThrows,
      })
    ).eligible,
    "§1b: 🔴 TEAMS — no AAD object id ⇒ nothing to ask. `createdBy` (the Bot Framework id) is NOT a substitute — this is the exact identity-mismatch the file header documents",
  );
  ok(
    (
      await checkFireEligibility({
        createdBy: undefined,
        platform: "teams",
        roomId: TEAMS_CHANNEL_ID,
        teamsTeamId: TEAMS_TEAM_ID,
        teamsCreatorAadObjectId: TEAMS_AAD_ID,
        teamsMembershipCheck: alwaysThrows,
        teamsActiveCheck: alwaysThrows,
      })
    ).eligible,
    "§1b: TEAMS — no creator on the row ⇒ eligible, and the probes are never even called",
  );

  const brokenMembership = await checkFireEligibility({
    createdBy: TEAMS_CREATED_BY,
    platform: "teams",
    roomId: TEAMS_CHANNEL_ID,
    teamsTeamId: TEAMS_TEAM_ID,
    teamsCreatorAadObjectId: TEAMS_AAD_ID,
    teamsMembershipCheck: async () => {
      throw new Error("graph 403");
    },
    teamsActiveCheck: async () => true,
  });
  ok(brokenMembership.eligible, "§1b: TEAMS — a THROWING membership probe degrades to 'unresolved', never a crash and never a manufactured skip");

  const slackOverridesIgnoredOnTeams = await checkFireEligibility({
    createdBy: TEAMS_CREATED_BY,
    platform: "teams",
    roomId: TEAMS_CHANNEL_ID,
    teamsTeamId: TEAMS_TEAM_ID,
    teamsCreatorAadObjectId: TEAMS_AAD_ID,
    membershipCheck: async () => false,
    activeCheck: async () => false,
    teamsMembershipCheck: async () => true,
    teamsActiveCheck: async () => true,
  });
  ok(slackOverridesIgnoredOnTeams.eligible, "§1b: 🔴 NEGATIVE CONTROL — a Slack-shaped `membershipCheck`/`activeCheck` override does not leak into the Teams branch; only `teamsMembershipCheck`/`teamsActiveCheck` are read there");
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-removed";
  await routineStore.addRoutine({} as never, routine({ id }));

  const neverFires = (() => ({
    send: (): never => {
      throw new Error("this fire must never be delivered — the creator was removed from the room");
    },
  })) as never;

  await tick(new Date("2026-07-02T12:05:00.000Z"), neverFires, { confirmRoomMembership: async () => false });
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.lastOutcome === "skipped", "§2: the run is recorded SKIPPED, not failed — a confirmed-removed creator is the deployment's state, not the routine's mistake");
  ok(after?.consecutiveFailures === 0, "§2: 🔴 THE CORE CLAIM — a fire-time eligibility skip is NEVER a failure. It must not feed the three-strike counter at all");
  ok(after?.status === "active", "§2: the routine stays ACTIVE — this is a skip, not a self-disable");
  ok(
    after?.nextRunAt === "2026-07-02T12:15:00.000Z",
    "§2: 🔴 RETRY POLICY (point 2) — the schedule ADVANCES to the routine's own next scheduled fire. No early retry, no backoff: the same shape an over-budget decline takes",
  );

  const rows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.skip, limit: 500 })).filter((r) => (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(rows.length === 1, "§2: a `routine.skip` reason row IS written, even though no session ever started");
  ok((rows[0]?.detail as { reason?: string } | undefined)?.reason === "creator_removed_from_room", "§2: …carrying the exact reason a reader would need to diagnose it");

  const okReceive = (() => ({ send: async () => undefined })) as never;
  await tick(new Date("2026-07-02T12:15:00.000Z"), okReceive, { confirmRoomMembership: async () => true });
  const recovered = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(recovered?.lastRunAt === "2026-07-02T12:15:00.000Z", "§2: the very next scheduled fire runs normally once membership is confirmed again — nothing about the skip left it stuck");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-inactive";
  await routineStore.addRoutine({} as never, routine({ id }));
  const neverFires = (() => ({
    send: (): never => {
      throw new Error("this fire must never be delivered — the creator's account is inactive");
    },
  })) as never;

  await tick(new Date("2026-07-02T12:05:00.000Z"), neverFires, { confirmRoomMembership: async () => true, confirmCreatorActive: async () => false });
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.consecutiveFailures === 0 && after?.status === "active", "§2b: an inactive-account skip is ALSO not a failure — checked independently of room membership");
  const rows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.skip, limit: 500 })).filter((r) => (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok((rows[0]?.detail as { reason?: string } | undefined)?.reason === "creator_account_inactive", "§2b: …with the DIFFERENT reason — an operator can tell the two failure modes apart from the row alone");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-unresolved";
  await routineStore.addRoutine({} as never, routine({ id }));
  const delivered: unknown[] = [];
  const receive = (() => ({ send: async (m: string) => void delivered.push(m) })) as never;

  await tick(new Date("2026-07-02T12:05:00.000Z"), receive, { confirmRoomMembership: async () => undefined, confirmCreatorActive: async () => undefined });
  ok(delivered.length === 1, "§2c: an unresolved probe on BOTH legs still fires — 'cannot check' is not 'removed'");
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.lastOutcome !== "skipped", "§2c: and the run is not recorded skipped for eligibility reasons");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-no-creator";
  await routineStore.addRoutine({} as never, routine({ id, createdBy: undefined }));
  const delivered: unknown[] = [];
  const receive = (() => ({ send: async (m: string) => void delivered.push(m) })) as never;
  await tick(new Date("2026-07-02T12:05:00.000Z"), receive, { confirmRoomMembership: async () => false, confirmCreatorActive: async () => false });
  ok(delivered.length === 1, "§2d: a creator-less routine fires normally — there is no creator to be removed or deactivated, so the predicate never engages");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-teams-removed";
  await routineStore.addRoutine({} as never, teamsRoutine({ id }));

  const neverFires = (() => ({
    send: (): never => {
      throw new Error("this fire must never be delivered — the creator was removed from the Teams channel");
    },
  })) as never;

  await tick(new Date("2026-07-02T12:05:00.000Z"), neverFires, { confirmTeamsRoomMembership: async () => false });
  const after = await routineStore.getRoutine(ORG, TEAMS_SURFACE, id);
  ok(after?.lastOutcome === "skipped", "§2-teams: TEAMS — the run is recorded SKIPPED, not failed");
  ok(after?.consecutiveFailures === 0, "§2-teams: 🔴 THE CORE CLAIM ON TEAMS TOO — a fire-time eligibility skip is NEVER a failure");
  ok(after?.status === "active", "§2-teams: the routine stays ACTIVE — this is a skip, not a self-disable");
  ok(after?.nextRunAt === "2026-07-02T12:15:00.000Z", "§2-teams: RETRY POLICY — the schedule ADVANCES to the routine's own next scheduled fire, no early retry");

  const rows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.skip, limit: 500 })).filter((r) => (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(rows.length === 1, "§2-teams: a `routine.skip` reason row IS written");
  ok((rows[0]?.detail as { reason?: string } | undefined)?.reason === "creator_removed_from_room", "§2-teams: …carrying the SAME reason string the Slack leg uses — one vocabulary across platforms");

  const okReceive = (() => ({ send: async () => undefined })) as never;
  await tick(new Date("2026-07-02T12:15:00.000Z"), okReceive, { confirmTeamsRoomMembership: async () => true });
  const recovered = await routineStore.getRoutine(ORG, TEAMS_SURFACE, id);
  ok(recovered?.lastRunAt === "2026-07-02T12:15:00.000Z", "§2-teams: TEAMS — the very next scheduled fire runs normally once membership is confirmed again");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: TEAMS_SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-teams-inactive";
  await routineStore.addRoutine({} as never, teamsRoutine({ id }));
  const neverFires = (() => ({
    send: (): never => {
      throw new Error("this fire must never be delivered — the creator's Entra account is disabled");
    },
  })) as never;

  await tick(new Date("2026-07-02T12:05:00.000Z"), neverFires, { confirmTeamsRoomMembership: async () => true, confirmTeamsCreatorActive: async () => false });
  const after = await routineStore.getRoutine(ORG, TEAMS_SURFACE, id);
  ok(after?.consecutiveFailures === 0 && after?.status === "active", "§2-teams-b: TEAMS — an inactive-account skip is ALSO not a failure, checked independently of room membership");
  const rows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.skip, limit: 500 })).filter((r) => (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok((rows[0]?.detail as { reason?: string } | undefined)?.reason === "creator_account_inactive", "§2-teams-b: …with the DIFFERENT reason, distinguishable from a room removal");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: TEAMS_SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-teams-unresolved";
  await routineStore.addRoutine({} as never, teamsRoutine({ id }));
  const delivered: unknown[] = [];
  const receive = (() => ({ send: async (m: string) => void delivered.push(m) })) as never;

  await tick(new Date("2026-07-02T12:05:00.000Z"), receive, { confirmTeamsRoomMembership: async () => undefined, confirmTeamsCreatorActive: async () => undefined });
  ok(delivered.length === 1, "§2-teams-c: TEAMS — an unresolved probe on BOTH legs still fires");
  const after = await routineStore.getRoutine(ORG, TEAMS_SURFACE, id);
  ok(after?.lastOutcome !== "skipped", "§2-teams-c: and the run is not recorded skipped for eligibility reasons");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: TEAMS_SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  _resetFireEligibilityCachesForTest();
  const id = "r-teams-no-aad";
  await routineStore.addRoutine({} as never, teamsRoutine({ id, target: { serviceUrl: "https://smba.example.com", conversationId: TEAMS_CONVERSATION, teamId: TEAMS_TEAM_ID, channelId: TEAMS_CHANNEL_ID } }));
  const delivered: unknown[] = [];
  const receive = (() => ({ send: async (m: string) => void delivered.push(m) })) as never;
  await tick(new Date("2026-07-02T12:05:00.000Z"), receive, { confirmTeamsRoomMembership: async () => false, confirmTeamsCreatorActive: async () => false });
  ok(delivered.length === 1, "§2-teams-d: 🔴 TEAMS — no AAD object id on the stored target ⇒ fires normally, even though `createdBy` IS set and the probes would confirm 'removed' if consulted");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: TEAMS_SURFACE } as never, id);
}

{
  const id = "r-denied";
  await routineStore.addRoutine({} as never, routine({ id }));
  const before = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(before?.consecutiveFailures === 0 && before?.lastOutcome === undefined, "§3: fixture sanity — the routine starts clean");

  const beforePending = (await getOperationalStore().listPendingActions(ORG)).length;
  await throwsWith(
    () =>
      requestApproval(
        {
          org: ORG,
          kind: "skill.delete",
          args: { org: ORG, domain: "eligibility", name: "ghost-skill", requestedBy: CREATOR },
          scopeKey: SURFACE,
          domain: "eligibility",
          channelId: CHAN,
          requestedBy: CREATOR,
          threadTs: null,
          chain: { unattended: true },
        } as never,
        {},
      ),
    /DENIED by the approver chain/,
    "§3: the approval plane genuinely DENIES an unattended ask — the scenario this ticket is about",
  );
  ok((await getOperationalStore().listPendingActions(ORG)).length === beforePending, "§3: …and mints no card, exactly like any other denied propose");

  const afterDeny = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(
    afterDeny?.consecutiveFailures === 0 && afterDeny?.lastOutcome === undefined,
    "§3: 🔴 THE CORE CLAIM — the DENY touched NOTHING on the routine's own row. The approval plane has no reach into routine failure bookkeeping at all",
  );

  const marker = { id, surfaceKey: SURFACE, org: ORG };
  const folded = await foldRoutineOutcome({ marker, sessionOutcome: "ok", at: new Date("2026-07-02T12:00:00.000Z"), sessionId: "sess-denied" });
  ok(folded.folded && folded.outcome === "ok" && folded.consecutiveFailures === 0, "§3: …and a session that merely SAW a deny and then completed normally settles ok, with the counter untouched");
  const finalRoutine = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(finalRoutine?.status === "active", "§3: the routine is still active — being denied one thing does not disable a routine that otherwise runs fine");

  const failId = "r-genuinely-broken";
  await routineStore.addRoutine({} as never, routine({ id: failId }));
  const failedFold = await foldRoutineOutcome({ marker: { id: failId, surfaceKey: SURFACE, org: ORG }, sessionOutcome: "failed", at: new Date("2026-07-02T12:00:00.000Z"), sessionId: "sess-real-failure" });
  ok(failedFold.consecutiveFailures === 1, "§3: negative control — an ACTUAL session failure (unrelated to any deny) DOES increment the counter, proving the fold mechanism is live");

  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, failId);
}

{
  resetRoutineSkipThrottle();
  const id = "r-once-fails";
  await routineStore.addRoutine(
    {} as never,
    routine({ id, trigger: { kind: "once", at: "2026-07-02T12:00:00.000Z" }, nextRunAt: "2026-07-02T12:00:00.000Z" }),
  );

  await tick(new Date("2026-07-02T12:05:00.000Z"), rejectingReceive);
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.consecutiveFailures === 1, "§4: a ONE-TIME routine's single failed fire counts as one failure");
  ok(after?.status === "disabled", "§4: 🔴 THE CORE CLAIM — it disables on its FIRST failure. There is no second chance to wait for (computeNextRun is always null for `once`)");
  ok(after?.nextRunAt === null, "§4: terminal — no next run");
  ok(
    (after?.disabledReason ?? "").length > 0 && !(after?.disabledReason ?? "").startsWith("once: fired at"),
    `§4: 🔴 the reason REFLECTS THE FAILURE — not the old generic "once: fired at <time>" note a failure could never overwrite (got: "${after?.disabledReason}")`,
  );

  const disabledRows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.disabled, limit: 500 })).filter((r) => (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(disabledRows.length === 1, "§4: the failure IS announced/audited as a genuine self-disable — a once's only chance failing is exactly the case an operator needs to see");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  resetRoutineSkipThrottle();
  const id = "r-once-ok";
  await routineStore.addRoutine(
    {} as never,
    routine({ id, trigger: { kind: "once", at: "2026-07-02T12:00:00.000Z" }, nextRunAt: "2026-07-02T12:00:00.000Z" }),
  );
  const okReceive = (() => ({ send: async () => undefined })) as never;
  await tick(new Date("2026-07-02T12:05:00.000Z"), okReceive);

  const marker = { id, surfaceKey: SURFACE, org: ORG };
  const folded = await foldRoutineOutcome({ marker, sessionOutcome: "ok", at: new Date("2026-07-02T12:06:00.000Z"), sessionId: "sess-once-ok" });
  ok(folded.folded && folded.outcome === "ok", "§4b: the session settles ok, same as any other successful fire");
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.status === "disabled" && after?.nextRunAt === null, "§4b: a successful one-shot is STILL terminal — it has no second scheduled instant, so it must not sit `active` with nothing scheduled forever");
  ok(
    !(after?.disabledReason ?? "").includes("failed"),
    `§4b: …and the row's own reason says so honestly, not as a failure (got: "${after?.disabledReason}")`,
  );
  ok(
    folded.disabled !== true,
    "§4b: 🔴 THE REGRESSION GUARD — outcome-fold's transition flag must NOT fire for an ordinary once completion, or the 🛑 self-disable notice would misreport a clean run as a breakage",
  );
  const disabledRows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.disabled, limit: 500 })).filter((r) => (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(disabledRows.length === 0, "§4b: 🔴 …and NO `routine.disabled` audit row is written for it — this is the row an operator reads to mean 'something broke'");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  ok(MIN_CONSECUTIVE_FAILURE_SPAN_MS === 60 * 60_000, "§5: the span floor is exactly one hour");
  const start = new Date("2026-04-04T23:30:00.000Z");
  let r: Routine = routine({ id: "r-pure-span", consecutiveFailures: 0 });
  r = applyOutcome(r, "failed", start);
  ok(r.status === "active" && r.firstFailureAt === start.toISOString(), "§5: the first failure of a streak stamps firstFailureAt and does not disable");
  r = applyOutcome(r, "failed", new Date(start.getTime() + 30 * 60_000));
  r = applyOutcome(r, "failed", new Date(start.getTime() + 59 * 60_000));
  ok(r.status === "active" && r.consecutiveFailures === 3, "§5: 3 failures at 59 minutes — one minute short — still does not disable");
  r = applyOutcome(r, "failed", new Date(start.getTime() + 60 * 60_000));
  ok(r.status === "disabled" && r.consecutiveFailures === 4, "§5: crossing the floor (>=60 minutes) with the count already past 3 disables");
}

{
  const start = new Date("2026-08-02T00:00:00.000Z");
  let r: Routine = routine({ id: "r-corrupted-stamp", consecutiveFailures: 2, firstFailureAt: "not-a-real-timestamp" });
  r = applyOutcome(r, "failed", start);
  ok(
    r.status === "disabled" && r.consecutiveFailures === 3,
    "§5b: 🔴 THE CONFIRMED FINDING — a routine whose firstFailureAt is corrupted (unparseable) still disables at the bare 3-strike count, exactly like an absent stamp. Without the finite-parse guard this fold settles NaN >= floor === false and the row stays active FOREVER, however many times it fails",
  );
  ok(r.firstFailureAt !== "not-a-real-timestamp" && r.firstFailureAt !== undefined, "§5b: …and the corrupted stamp is self-healed on the way out — the row carries a real instant afterward, not the garbage that got it here");
}

{
  const bag = routineFireAttributes(
    { id: "r-elig-fence", org: ORG, surfaceKey: SURFACE, trigger: { kind: "cron", expr: "0 9 * * *" }, prompt: "p", createdBy: CREATOR, createdAt: "x", status: "active", consecutiveFailures: 0 } as never,
    { team_id: TEAM, channel_id: CHAN, channel_type: "channel" },
    "channel",
    true,
  );
  const fireCtx = { channel: { kind: "slack" }, session: { auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: bag } } } } as never;
  const bound = bindFrom(fireCtx);
  ok(bound.principalId === CREATOR && bound.principalAttested === true, "§6: the fire is attributable to its creator");
  ok(actingPrincipalId(bound) === undefined, "§6: 🔴 …and holds NO acting authority — an eligible fire runs on the room's own reach, never the creator's personal standing");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine fire eligibility + lifecycle (OPE-506): ${passed} assertions passed`);
