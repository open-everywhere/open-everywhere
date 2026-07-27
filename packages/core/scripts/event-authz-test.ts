
import "./_register-test-config.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const {
  checkEventReadGrant,
  eventGrantPartitions,
  eventScopeGrant,
  registerEventScopeGrant,
  registeredEventGrantSources,
  requestForPartition,
  resetEventScopeGrantsForTest,
} = await import("../agent/routines/event-authz.js");
const { routinePartition } = await import("../agent/routines/partition.js");
const { liftGithubEvent, githubEventScopeGrant } = await import("../agent/routines/github-normalizer.js");
type EffectiveAccess = import("../agent/access/resolver.js").EffectiveAccess;
type Partition = import("../agent/memory/partition.js").Partition;
type Routine = import("../agent/routines/routine.js").Routine;
type NormalizedEvent = import("../agent/routines/event-model.js").NormalizedEvent;

const pr = liftGithubEvent("pull_request", {
  action: "opened",
  pull_request: { number: 42, title: "Add caching" },
  repository: { full_name: "me/proj" },
  sender: { login: "alice" },
})!;
const push = liftGithubEvent("push", { repository: { full_name: "me/proj" } })!;
const deleted = liftGithubEvent("issues", { action: "deleted", issue: { number: 9 }, repository: { full_name: "me/proj" } })!;

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "r-a",
    org: "acme",
    surfaceKey: "slack/T1/C1",
    target: { channelId: "C1" },
    trigger: { kind: "event", source: "github" },
    prompt: "p",
    createdAt: "2026-07-26T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}
const access = (repos: readonly string[]): EffectiveAccess => ({ repos }) as never;
const resolveWith = (byKey: Readonly<Record<string, readonly string[]>>) => (p: Partition) => access(byKey[p.surfaceKey] ?? []);

{
  const p = routinePartition(routine());
  ok(p.org === "acme" && p.platform === "slack" && p.workspace === "T1" && p.surface === "C1", "partition: a routine's surfaceKey splits into platform/workspace/surface");
  ok(routinePartition(routine({ surfaceKey: "discord/G1/parent/thread" })).surface === "parent/thread", "partition: a multi-segment surface keeps its slashes");
  const req = requestForPartition(p);
  ok(req.mode === "channel" && req.platform === "slack" && req.channel === "C1", "partition: a session-free ResolveRequest is derivable from the stored surfaceKey alone");
  ok(req.principalId === undefined, "partition: answering 'can' needs NO calling principal — a fire has no human");
}

{
  const granted = resolveWith({ "slack/T1/C1": ["me/proj"] });
  ok(checkEventReadGrant(pr, [routinePartition(routine())], { resolve: granted }).ok, "grant: a granted repo authorizes an event under it");

  const refused = checkEventReadGrant(pr, [routinePartition(routine())], { resolve: resolveWith({ "slack/T1/C1": ["me/other"] }) });
  ok(!refused.ok && refused.reason === "refused" && refused.partition === "slack/T1/C1", "grant: an ungranted repo is REFUSED, naming the partition that said no");

  ok(checkEventReadGrant(deleted, [routinePartition(routine())], { resolve: granted }).ok, "grant: a DELETED entity is still authorizable — the check is on the scope, never a fetch result");
  ok(checkEventReadGrant(push, [routinePartition(routine())], { resolve: granted }).ok, "grant: an event with NO entity (a push) is authorizable — the scope path is what the rule stands on");
}

{
  const p = [routinePartition(routine())];
  const granted = resolveWith({ "slack/T1/C1": ["me/proj"] });

  const noAdapter = checkEventReadGrant({ ...pr, source: "gitlab" } as NormalizedEvent, p, { resolve: granted });
  ok(!noAdapter.ok && noAdapter.reason === "no-grant-adapter", "fail-closed: an unregistered source has NO grant adapter and therefore never fires");

  const noScope = checkEventReadGrant({ ...pr, scope: [] } as NormalizedEvent, p, { resolve: granted });
  ok(!noScope.ok && noScope.reason === "no-scope", "fail-closed: a delivery proving NO scope is refused — treating an empty path as 'matches any grant' would make a normalizer bug an authz bypass");

  const noPartitions = checkEventReadGrant(pr, [], { resolve: granted });
  ok(!noPartitions.ok && noPartitions.reason === "unresolvable", "fail-closed: zero partitions to check is a refusal, not a vacuous pass");

  const boom = checkEventReadGrant(pr, p, {
    resolve: () => {
      throw new Error("config unloadable");
    },
  });
  ok(!boom.ok && boom.reason === "unresolvable", "fail-closed: an unloadable config REFUSES (matching grantedForCtx's 'override-store failure must fail CLOSED')");

  registerEventScopeGrant({
    source: "throwy",
    grantsRead() {
      throw new Error("adapter bug");
    },
  });
  const adapterBoom = checkEventReadGrant({ ...pr, source: "throwy" } as NormalizedEvent, p, { resolve: granted });
  ok(!adapterBoom.ok && adapterBoom.reason === "unresolvable", "fail-closed: a THROWING grant adapter is absorbed into a refusal — a throw here would abort every other routine's fire in the same loop");
}

{
  const own: Partition = routinePartition(routine());
  const other: Partition = routinePartition(routine({ surfaceKey: "slack/T1/C-SECURITY" }));
  const bothGranted = resolveWith({ "slack/T1/C1": ["me/proj"], "slack/T1/C-SECURITY": ["me/proj"] });
  const onlyOwn = resolveWith({ "slack/T1/C1": ["me/proj"], "slack/T1/C-SECURITY": [] });
  const onlyOther = resolveWith({ "slack/T1/C1": [], "slack/T1/C-SECURITY": ["me/proj"] });

  ok(checkEventReadGrant(pr, [own, other], { resolve: bothGranted }).ok, "multi-partition: BOTH partitions granting is the only pass");
  const half = checkEventReadGrant(pr, [own, other], { resolve: onlyOwn });
  ok(!half.ok && half.partition === "slack/T1/C-SECURITY", "🔴 multi-partition: the OWNING domain's grant does NOT authorize delivery into a room whose own partition lacks it");
  ok(!checkEventReadGrant(pr, [own, other], { resolve: onlyOther }).ok, "multi-partition: a granted report room does not rescue an ungranted owner either — it is an AND, not an OR");
  ok(checkEventReadGrant(pr, [own], { resolve: onlyOwn }).ok, "multi-partition: the same event with only the owning partition in play still passes (the extra check is what changes the answer)");
}

{
  ok(eventGrantPartitions(routine()).length === 1, "report: a routine with no report contributes exactly its own partition");
  ok(eventGrantPartitions(routine())[0]!.surfaceKey === "slack/T1/C1", "report: that partition is the routine's own surface");
  const silent = eventGrantPartitions(routine({ report: { kind: "silent" } }));
  ok(silent.length === 1 && silent[0]!.surfaceKey === "slack/T1/C1", "report: `silent` REMOVES the post rather than redirecting it, so it adds no partition");
  let threw = false;
  try {
    eventGrantPartitions(routine({ report: { kind: "digest" } as never }));
  } catch {
    threw = true;
  }
  ok(threw, "report: an unhandled report kind THROWS rather than defaulting to the owning partition — a silent default is exactly how the wrong room gets authorized");
}

{
  ok(githubEventScopeGrant.grantsRead(pr.scope, access(["me/proj"])), "github: the CONTAINER step is the grant unit — the same repoAllowed gate the read tools enforce");
  ok(!githubEventScopeGrant.grantsRead(pr.scope, access(["me/other"])), "github: a different repo does not grant");
  ok(
    !githubEventScopeGrant.grantsRead([{ kind: "tenant", id: "me" }], access(["me/proj"])),
    "github: an owner-level delivery is NOT authorized by a repo grant — widening to 'any repo under a granted owner' would silently make every single-repo grant org-wide",
  );
  ok(!githubEventScopeGrant.grantsRead([], access(["me/proj"])), "github: no container step ⇒ no grant");
}

{
  ok(registeredEventGrantSources().includes("github"), "registry: github's grant adapter registers when its module loads");
  resetEventScopeGrantsForTest();
  ok(eventScopeGrant("github") === undefined, "registry: the test reset seam clears every registration");
  registerEventScopeGrant(githubEventScopeGrant);
  ok(eventScopeGrant("github") !== undefined, "registry: re-registration works after a reset");
}

console.log(`✓ event-authz: ${passed} assertions passed`);
