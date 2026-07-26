import { registerEventNormalizer, resetEventNormalizersForTest } from "../agent/routines/event-model.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const {
  SCOPE_KINDS,
  describeFilter,
  eventNormalizer,
  innermostScope,
  normalizeDelivery,
  normalizedEventDefect,
  registeredEventSources,
  scopeIdOf,
} = await import("../agent/routines/event-model.js");
type NormalizedEvent = import("../agent/routines/event-model.js").NormalizedEvent;
type EventNormalizer = import("../agent/routines/event-model.js").EventNormalizer;
type SubscriptionFilter = import("../agent/routines/event-model.js").SubscriptionFilter;
type TriggerDelivery = import("../agent/routines/event-model.js").TriggerDelivery;

const { evaluateFilter, evaluateSubscription, storedFilter, validateSubscription } = await import("../agent/routines/event-match.js");
const { liftGithubEvent, githubEventNormalizer } = await import("../agent/routines/github-normalizer.js");
const { storedTrigger, eventFilterFrom } = await import("../agent/tools/create_routine.js");
const { describeTrigger } = await import("../agent/routines/routine.js");
type Routine = import("../agent/routines/routine.js").Routine;

const PR_PAYLOAD = {
  action: "opened",
  pull_request: { number: 42, title: "Add caching", html_url: "https://github.com/me/proj/pull/42" },
  repository: { full_name: "me/proj", name: "proj" },
  sender: { login: "alice" },
};
const pr = liftGithubEvent("pull_request", PR_PAYLOAD)!;

function eventRoutine(trigger: Routine["trigger"]): Routine {
  return {
    id: "r-t",
    org: "acme",
    surfaceKey: "slack/T1/C1",
    target: { channelId: "C1" },
    trigger,
    prompt: "p",
    createdAt: "2026-07-26T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
  };
}

ok(pr.scope.map((s) => s.kind).join(">") === "tenant>container>entity", "scope: a PR delivery proves owner > repo > number, outermost-first");
ok(scopeIdOf(pr.scope, "container") === "me/proj", "scope: the container step is the repo — the unit GitHub's own permission model uses");
ok(scopeIdOf(pr.scope, "tenant") === "me", "scope: the tenant step is the owner segment");
ok(innermostScope(pr.scope)!.kind === "entity", "scope: innermostScope is the deepest step the delivery proved");

const deleted = liftGithubEvent("issues", { action: "deleted", issue: { number: 9, title: "Runbook" }, repository: { full_name: "me/proj" } })!;
ok(deleted.pointer?.gone === true, "deletion: the terminal bit comes from the VENDOR's own action, never from a failed fetch");
ok(scopeIdOf(deleted.scope, "container") === "me/proj", "deletion: the scope path survives the entity — 'someone deleted the runbook' stays authorizable");

const push = liftGithubEvent("push", { repository: { full_name: "me/proj" }, sender: { login: "bob" } })!;
ok(push.pointer === undefined, "no-entity: a push has no fetchable entity");
ok(scopeIdOf(push.scope, "container") === "me/proj" && innermostScope(push.scope)!.kind === "container", "no-entity: the scope path is still present and is the container");

const comment = liftGithubEvent("pull_request_review_comment", {
  action: "created",
  pull_request: { number: 42, title: "Add caching" },
  comment: { id: 777 },
  repository: { full_name: "me/proj" },
})!;
ok(scopeIdOf(comment.scope, "sub") === "777", "scope: a review comment occupies the `sub` level");

ok(pr.fields["repo"] === "me/proj" && pr.fields["action"] === "opened" && pr.fields["sender"] === "alice", "fields: the v1 flat keys survive verbatim");
ok(pr.fields["url"] === "https://github.com/me/proj/pull/42", "fields: url rides in fields (the fence reads it there, not from a top-level column)");
ok(pr.actor?.handle === "alice", "actor: the sender resolves (the self-trigger guard has something to stand on)");
ok(pr.summary.includes("#42") && pr.summary.includes("alice"), "summary: still the code-rendered one-liner events.ts produced");

const bad = (over: Partial<NormalizedEvent>): NormalizedEvent => ({ source: "x", event: "e", scope: [], fields: {}, summary: "s", ...over });
ok(normalizedEventDefect(bad({})) === null, "defect: a minimal well-formed event has no defect");
ok(normalizedEventDefect(bad({ event: "" })) !== null, "defect: an empty event name is refused");
ok(
  normalizedEventDefect(bad({ scope: [{ kind: "container", id: "a" }, { kind: "tenant", id: "b" }] })) !== null,
  "defect: an INVERTED scope path is refused — `under` is a prefix test implemented as kind lookup, and only a strictly outermost-first path makes those the same thing",
);
ok(
  normalizedEventDefect(bad({ scope: [{ kind: "container", id: "a" }, { kind: "container", id: "b" }] })) !== null,
  "defect: a REPEATED scope kind is refused — otherwise `under: [{container: a}]` would match an event inside b",
);
ok(normalizedEventDefect(bad({ scope: [{ kind: "container", id: "" }] })) !== null, "defect: an empty scope id is refused");
ok(SCOPE_KINDS.length === 5, "the scope vocabulary is CLOSED at five levels");

ok(registeredEventSources().includes("github"), "registry: github registers itself when its normalizer module loads");
ok(eventNormalizer("gitlab") === undefined, "registry: an unregistered source resolves to nothing — never a fallback to another source's normalizer");

const ghDelivery = (body: unknown, event = "pull_request"): TriggerDelivery => ({
  source: "github",
  headers: { "x-github-event": event },
  body: JSON.stringify(body),
  receivedAt: "2026-07-26T00:00:00.000Z",
});
ok(normalizeDelivery(ghDelivery(PR_PAYLOAD)) !== null, "registry: a declared, registered source normalizes");
let rejection = "";
ok(normalizeDelivery({ ...ghDelivery(PR_PAYLOAD), source: "gitlab" }, (r) => (rejection = r)) === null, "registry: an unregistered source normalizes to null (200-and-ignore)");
ok(rejection.includes("gitlab") && rejection.includes("github"), "registry: the rejection names the source AND the registered set");
ok(normalizeDelivery(ghDelivery({}, "ping")) === null, "registry: an unmodelled event (ping) is null, not an error");
ok(normalizeDelivery({ ...ghDelivery(PR_PAYLOAD), body: "not json" }) === null, "registry: an unparseable body is null, not a throw");

{
  const boom: EventNormalizer = {
    source: "boom",
    matchKeys: [],
    scopeKeys: [],
    scopeKinds: [],
    resolvesActor: false,
    normalize() {
      throw new Error("kaboom");
    },
  };
  registerEventNormalizer(boom);
  let why = "";
  ok(normalizeDelivery({ source: "boom", headers: {}, body: "{}", receivedAt: "x" }, (r) => (why = r)) === null, "registry: a THROWING normalizer is absorbed, not propagated");
  ok(why.includes("kaboom"), "registry: the throw is reported to the reject sink so it can be audited");

  registerEventNormalizer({
    source: "defective",
    matchKeys: [],
    scopeKeys: [],
    scopeKinds: [],
    resolvesActor: false,
    normalize: () => bad({ source: "defective", scope: [{ kind: "container", id: "a" }, { kind: "tenant", id: "b" }] }),
  });
  ok(normalizeDelivery({ source: "defective", headers: {}, body: "{}", receivedAt: "x" }) === null, "registry: a structurally defective event is refused, not routed");
}

{
  const long = "x".repeat(500);
  const lifted = normalizeDelivery(ghDelivery({ ...PR_PAYLOAD, pull_request: { number: 1, title: long } }))!;
  ok(lifted.fields["title"]!.length === 200, "fields: an over-long value is truncated to the cap");
}

ok(evaluateFilter(push, { all: [{ key: "action", in: ["opened"] }] }) === false, "absent field: every `in` is FALSE (a push has no action)");
ok(evaluateFilter(push, { all: [{ key: "action", notIn: ["opened"] }] }) === true, "absent field: every `notIn` is TRUE — which is what makes notIn usable as an actor exclusion");
ok(evaluateFilter(pr, { all: [{ key: "action", in: ["opened", "reopened"] }] }) === true, "`in` matches any value in the set");
ok(evaluateFilter(pr, { all: [{ key: "sender", notIn: ["alice"] }] }) === false, "`notIn` excludes the value it names");
ok(evaluateFilter(pr, undefined) === true, "no filter evaluates to a match at FIRE time (stored legacy rows keep their meaning)");

ok(evaluateFilter(pr, { under: [{ kind: "container", id: "me/proj" }] }) === true, "`under` matches the delivery's container");
ok(evaluateFilter(pr, { under: [{ kind: "container", id: "other/repo" }] }) === false, "`under` naming another container does not match");
ok(evaluateFilter(pr, { under: [{ kind: "tenant", id: "me" }] }) === true, "`under` on an OUTER step matches — a path makes containment structural");
ok(
  evaluateFilter(pr, { under: [{ kind: "container", id: "me/proj" }], all: [{ key: "action", in: ["closed"] }] }) === false,
  "everything is AND-ed: one failing clause fails the filter",
);
ok(evaluateFilter(push, { under: [{ kind: "entity", id: "1" }] }) === false, "`under` on a level the delivery never proved does not match (never a wildcard)");

{
  const legacy = { kind: "event", source: "github", match: { event: "pull_request", action: "opened" } } as const;
  const coerced = storedFilter(legacy)!;
  ok(coerced.all!.length === 2 && "in" in coerced.all![0]!, "legacy: `match` coerces to single-value `in` clauses at READ time (no row migration)");
  ok(evaluateFilter(pr, coerced) === true, "legacy: the coerced filter matches exactly what the old exact-equality matcher matched");
  ok(evaluateFilter(pr, storedFilter({ kind: "event", source: "github", match: { action: "closed" } })!) === false, "legacy: a mismatching legacy filter still does not match");
  ok(storedFilter({ kind: "event", source: "github" }) === undefined, "legacy: a filter-less stored row is 'no filter', not an empty filter");
}

{
  const drifted = eventRoutine({ kind: "event", source: "github", filter: { all: [{ key: "branch", in: ["main"] }] } });
  const verdict = evaluateSubscription(drifted, pr);
  ok("invalid" in verdict && verdict.match === false, "fire-time: a filter naming a key the source no longer declares is INVALID, not a match");
  ok("invalid" in verdict && verdict.invalid.includes("branch"), "fire-time: the invalid verdict names the offending key");

  const unknownSource = eventRoutine({ kind: "event", source: "gitlab", filter: { all: [{ key: "x", in: ["y"] }] } });
  ok(evaluateSubscription(unknownSource, pr).match === false, "fire-time: a routine on a different source never matches");
  ok(evaluateSubscription(eventRoutine({ kind: "interval", everyMinutes: 5 }), pr).match === false, "fire-time: a clock routine never matches an event");
  ok(
    evaluateSubscription(eventRoutine({ kind: "event", source: "github", filter: { under: [{ kind: "group", id: "g" }] } }), pr).match === false,
    "fire-time: an `under` on a kind the source cannot prove is invalid, never a silent all-match",
  );
}

{
  const good: SubscriptionFilter = { under: [{ kind: "container", id: "me/proj" }] };
  ok(throws(() => validateSubscription("github", good)) === null, "create: a well-formed subscription passes");

  const unknown = throws(() => validateSubscription("gitlab", good));
  ok(unknown !== null && unknown.includes("github"), "create: an UNKNOWN SOURCE is refused, naming the known set — this is what kills the typo'd-source silent-no-op class");

  const badKey = throws(() => validateSubscription("github", { under: good.under, all: [{ key: "branch", in: ["main"] }] }));
  ok(badKey !== null && badKey.includes("event, action, repo, sender"), "create: an unknown field is refused, naming the filterable set");

  const badKind = throws(() => validateSubscription("github", { under: [{ kind: "group", id: "g" }] }));
  ok(badKind !== null && badKind.includes("group"), "create: an `under` naming a kind this source never proves is refused — it could only ever match nothing");

  ok(throws(() => validateSubscription("github", { under: good.under, all: [{ key: "action", in: [] }] })) !== null, "create: an empty value list is refused");
  ok(
    throws(() => validateSubscription("github", { under: good.under, all: [{ key: "action", in: ["a"], notIn: ["b"] } as never] })) !== null,
    "create: a clause carrying BOTH in and notIn is refused rather than given a made-up precedence",
  );
  ok(throws(() => validateSubscription("github", { under: good.under, all: [{ key: "action" } as never] })) !== null, "create: a clause carrying NEITHER in nor notIn is refused");
  ok(
    throws(() => validateSubscription("github", { under: [{ kind: "container", id: "a" }, { kind: "container", id: "b" }] })) !== null,
    "create: two `under` selectors on the same kind are refused (a scope path holds at most one step per kind)",
  );
  ok(
    throws(() => validateSubscription("github", { under: good.under, all: [{ key: "action", in: Array.from({ length: 21 }, (_, i) => String(i)) }] })) !== null,
    "create: an over-long value list is refused (the evaluator's cost bound is a contract, not an accident)",
  );
  ok(
    throws(() => validateSubscription("github", { under: good.under, all: Array.from({ length: 9 }, () => ({ key: "action", in: ["x"] })) })) !== null,
    "create: more than 8 clauses is refused",
  );
}

{
  const naked = throws(() => validateSubscription("github", undefined));
  ok(naked !== null && naked.includes("narrow"), "narrowing: a filter-less subscription is REFUSED at create — 'every event in the tenant' has to be spelled out");
  ok(throws(() => validateSubscription("github", { all: [{ key: "action", in: ["opened"] }] })) !== null, "narrowing: narrowing only by a NON-scope field is not narrowing");
  ok(throws(() => validateSubscription("github", { all: [{ key: "repo", in: ["me/proj"] }] })) === null, "narrowing: an `in` on a SCOPE key satisfies the rule");
  ok(throws(() => validateSubscription("github", { under: [{ kind: "container", id: "me/proj" }] })) === null, "narrowing: an `under` selector satisfies the rule");
  ok(
    throws(() => validateSubscription("github", { all: [{ key: "repo", notIn: ["me/proj"] }] })) !== null,
    "narrowing: a NEGATIVE clause on a scope key is not narrowing — 'every repo except one' is still every repo",
  );
  ok(evaluateSubscription(eventRoutine({ kind: "event", source: "github" }), pr).match === true, "narrowing: a STORED filter-less row still matches at fire time (the reversal is not retroactive)");
}

{
  registerEventNormalizer({
    source: "flat",
    matchKeys: ["event"],
    scopeKeys: [],
    scopeKinds: ["tenant"],
    resolvesActor: true,
    normalize: () => null,
  });
  ok(throws(() => validateSubscription("flat", { all: [{ key: "event", in: ["x"] }] })) === null, "narrowing: a source with no container level is not asked to narrow below one");
}

{
  const t = storedTrigger({ kind: "event", source: "github", under: [{ kind: "container", id: "me/proj" }], all: [{ key: "action", in: ["opened", "reopened"] }] } as never);
  ok(t.kind === "event" && t.filter?.under?.[0]?.id === "me/proj" && t.filter?.all?.length === 1, "authoring: under + all land on the stored filter");
  ok((t as { match?: unknown }).match === undefined, "authoring: nothing new is ever written in the LEGACY match shape");

  const legacyAuthored = storedTrigger({ kind: "event", source: "github", match: { repo: "me/proj", action: "opened" } } as never);
  ok(legacyAuthored.kind === "event" && legacyAuthored.filter?.all?.length === 2, "authoring: the deprecated `match` shorthand is coerced AT THE BOUNDARY, not stored raw");

  ok(throws(() => storedTrigger({ kind: "event", source: "typo-hub", match: { event: "push" } } as never)) !== null, "authoring: create_routine REFUSES a typo'd source (it used to accept any string and arm a dead routine)");
  ok(throws(() => storedTrigger({ kind: "event", source: "github", all: [{ key: "action", in: ["opened"] }] } as never)) !== null, "authoring: create_routine enforces the narrowing rule");
  ok(eventFilterFrom({}) === undefined, "authoring: no under/all/match is 'no filter', which the validator then refuses for a containered source");
}

{
  const d = describeTrigger({ kind: "event", source: "github", filter: { under: [{ kind: "container", id: "me/proj" }], all: [{ key: "action", in: ["opened", "reopened"] }] } });
  ok(d.includes("container=me/proj") && d.includes("action in [opened, reopened]"), "describe: the arm card renders the scope AND the clauses");
  ok(describeTrigger({ kind: "event", source: "github", match: { action: "opened" } }).includes("action in [opened]"), "describe: a legacy row describes itself the way it BEHAVES (as its coercion), never differently");
  ok(describeFilter("github", undefined).includes("EVERY event"), "describe: an unnarrowed subscription says so loudly");
}

resetEventNormalizersForTest();
ok(registeredEventSources().length === 0, "registry: the test reset seam clears every registration");
registerEventNormalizer(githubEventNormalizer);
ok(eventNormalizer("github") !== undefined, "registry: re-registration works after a reset");

console.log(`✓ event-routing: ${passed} assertions passed`);
