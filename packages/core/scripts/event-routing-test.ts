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
async function throwsAsync(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
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
type TriggerDelivery = import("../agent/routines/event-model.js").TriggerDelivery;

const { storedFilter } = await import("../agent/routines/event-model.js");
const { evaluateSubscription, narrowsScope, validateSubscription } = await import("../agent/routines/event-match.js");
const { evaluateJqFilter, filterDocument, probeFilter, FILTER_MAX_LENGTH } = await import("../agent/routines/jq-filter.js");
const { liftGithubEvent, githubEventNormalizer } = await import("../agent/routines/github-normalizer.js");
const { storedTrigger } = await import("../agent/tools/create_routine.js");
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
  "defect: a REPEATED scope kind is refused — otherwise `.scope.container == \"a\"` would match an event inside b",
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

const ev = (e: NormalizedEvent, expression: string) => evaluateJqFilter(expression, filterDocument(e));
{
  ok("match" in (await ev(pr, '.event == "pull_request"')), "jq: a boolean-true predicate is a MATCH");
  const t = await ev(pr, '.event == "pull_request"');
  ok("match" in t && t.match === true, "jq: …and it is true, not merely well-formed");
  const fa = await ev(pr, '.event == "push"');
  ok("match" in fa && fa.match === false, "jq: a boolean-false predicate is a clean NO MATCH, never an error");

  ok("error" in (await ev(pr, ".event")), "jq: a STRING result is an error, never truthiness");
  ok("error" in (await ev(pr, ".fields.nope")), "jq: a NULL result is an error, not a silent false");
  ok("error" in (await ev(pr, "1")), "jq: a NUMBER result is an error");
  ok("error" in (await ev(pr, "empty")), "jq: NO output is an error — a filter must produce exactly one boolean");
  ok("error" in (await ev(pr, "(true, false)")), "jq: MORE THAN ONE output is an error, not first-wins");
  const parse = await ev(pr, ".event ==");
  ok("error" in parse && parse.error.length > 0, "jq: a PARSE ERROR is an error carrying a reason, and never a match");
  ok("error" in (await ev(pr, "input_filename")), "jq: an unknown function is an error (input/input_filename/halt_error are not implemented — a match predicate has no business with I/O)");
}

{
  const inj = await ev(pr, '.event == "$(echo pwned)"');
  ok("match" in inj && inj.match === false, "sandbox: `$(…)` in a filter is a literal string, not command substitution");
  const tick = await ev(pr, '.event == "`echo pwned`"');
  ok("match" in tick && tick.match === false, "sandbox: backticks likewise");
  process.env["OE_FILTER_PROBE_SECRET"] = "canary";
  const envLeak = await ev(pr, '(env | has("OE_FILTER_PROBE_SECRET")) == false and ($ENV.OE_FILTER_PROBE_SECRET == null)');
  ok("match" in envLeak && envLeak.match === true, "sandbox: neither `env` nor `$ENV` can see a variable this process really has — the isolation is by construction, not by a scrub");
  delete process.env["OE_FILTER_PROBE_SECRET"];
  ok("error" in (await ev(pr, "$x")), "sandbox: an undefined variable yields null — a real fidelity gap (jq itself errors) that the boolean contract turns into an ERROR, so it fails toward NO MATCH either way");

  const bomb = await ev(pr, "[limit(100000000; repeat(1))] | length > 0");
  ok("error" in bomb && /iteration/i.test(bomb.error), "bound: an unbounded jq construct hits the ITERATION limit and returns an error — it never hangs and never matches");
}

{
  const inAbsent = await ev(push, '(.fields["action"] | IN("opened"))');
  ok("match" in inAbsent && inAbsent.match === false, "absent field: every `in` is FALSE (a push has no action)");
  const notInAbsent = await ev(push, '(.fields["action"] | IN("opened") | not)');
  ok("match" in notInAbsent && notInAbsent.match === true, "absent field: every `notIn` is TRUE — which is what makes notIn usable as an actor exclusion");
  const inSet = await ev(pr, '(.fields["action"] | IN("opened", "reopened"))');
  ok("match" in inSet && inSet.match === true, "`in` matches any value in the set");
  const notInHit = await ev(pr, '(.fields["sender"] | IN("alice") | not)');
  ok("match" in notInHit && notInHit.match === false, "`notIn` excludes the value it names");
}

{
  const here = await ev(pr, '.scope.container == "me/proj"');
  ok("match" in here && here.match === true, "scope: an equality on the proved container matches");
  const other = await ev(pr, '.scope.container == "other/repo"');
  ok("match" in other && other.match === false, "scope: naming another container does not match");
  const outer = await ev(pr, '.scope.tenant == "me"');
  ok("match" in outer && outer.match === true, "scope: an OUTER step matches — a path makes containment structural");
  const anded = await ev(pr, '.scope.container == "me/proj" and (.fields["action"] | IN("closed"))');
  ok("match" in anded && anded.match === false, "scope: AND still ANDs — one failing conjunct fails the filter");
  const never = await ev(push, '.scope.entity == "1"');
  ok("match" in never && never.match === false, "scope: a level the delivery never proved is null, so an equality on it is false — never a wildcard");

  const documented = await ev(pr, '.scope.container == "me/proj" and (.fields.action | IN("opened","reopened"))');
  ok("match" in documented && documented.match === true, "docs: the exact expression shape the manual prints as its worked example evaluates true on a real PR delivery");

  const or = await ev(push, '.scope.container == "me/proj" and ((.fields["action"] | IN("opened")) or (.fields["sender"] | IN("bob")))');
  ok("match" in or && or.match === true, "jq subsumes any/all: an OR across clauses is one routine, not two");

  const noSummary = await ev(pr, ".summary == null and .actor == null and .pointer == null");
  ok("match" in noSummary && noSummary.match === true, "document: summary / actor / pointer are NOT exposed to filters — prose and identity stay out of the match surface");
  const redaction = await ev(pr, ".redacted == false and (.fields | type) == \"object\" and (.scopePath | length) > 0");
  ok("match" in redaction && redaction.match === true, "document: a filter still sees fields + scope, which is what keeps a trigger-only (redacted) delivery matchable");
}

{
  const jqRow = storedFilter({ jq: '.fields.action == "opened"' });
  ok(jqRow.kind === "jq" && jqRow.expression === '.fields.action == "opened"', "one language: a stored jq row reads as its expression");
  ok(storedFilter({ kind: "event", source: "github" } as never).kind === "none", "one language: a filter-less row is 'no filter' — the legacy all-events reading, still honoured");
  ok(storedFilter({ match: undefined } as never).kind === "none", "one language: an explicitly-undefined key is absent, not an unreadable shape");

  const retiredMatch = storedFilter({ match: { action: "opened" } } as never);
  ok(retiredMatch.kind === "unknown", "one language: a surviving pre-OPE-163 `match` row is UNREADABLE — never silently filter-less");
  ok(retiredMatch.kind === "unknown" && retiredMatch.keys.join(",") === "match", "one language: …and it names the offending key, so an audit row is actionable");
  const retiredFilter = storedFilter({ filter: { all: [{ key: "action", in: ["opened"] }] } } as never);
  ok(retiredFilter.kind === "unknown" && retiredFilter.keys.join(",") === "filter", "one language: a surviving OPE-163 `{all, under}` row is UNREADABLE too");
  const invented = storedFilter({ jq: "true", where: "action = opened" } as never);
  ok(invented.kind === "unknown" && invented.keys.join(",") === "where", "one language: an unknown key beats a valid `jq` beside it — a row nobody can fully read is not half-read");
  const two = storedFilter({ filter: {}, match: {} } as never);
  ok(two.kind === "unknown" && two.keys.join(",") === "filter,match", "one language: every unreadable key is named, sorted, not just the first");
}

{
  const unreadable = eventRoutine({ kind: "event", source: "github", match: { event: "pull_request" } } as never);
  const verdict = await evaluateSubscription(unreadable, pr);
  ok(verdict.match === false, "loud/fire: an unreadable stored row NEVER fires — the row was written to narrow, and reading it as all-events would be a fire-hose");
  ok("invalid" in verdict && verdict.invalid.includes("match"), "loud/fire: …it is reported INVALID (a routine.skip audit row) naming the key, not thrown — one bad row must not abort the fan-out");
  const filterless = await evaluateSubscription(eventRoutine({ kind: "event", source: "github" }), pr);
  ok(filterless.match === true && !("invalid" in filterless), "loud/fire: negative control — a genuinely filter-less row still matches every event");

  const rendered = describeTrigger({ kind: "event", source: "github", match: { action: "opened" } } as never);
  ok(rendered.includes("UNREADABLE") && rendered.includes("match"), "loud/render: an unreadable row describes itself as one — the renderer never differs from the behaviour");
  ok(!rendered.includes("EVERY event"), "loud/render: …and it must NOT borrow the filter-less wording, which is the one thing it is not");

  const { addRoutine } = await import("../agent/routines/store.js");
  const row = { id: "r-x", org: "default", surfaceKey: "local/dev/a", prompt: "x", createdAt: "2026-08-25T00:00:00Z", status: "active", consecutiveFailures: 0 };
  const refusal = await throwsAsync(() => addRoutine({} as never, { ...row, trigger: { kind: "event", source: "github", match: { action: "opened" } } } as never));
  ok(refusal !== null && refusal.includes("cannot read") && refusal.includes("match"), "loud/store: the DURABLE WRITE refuses an unreadable subscription, so a migrated or hand-built row cannot enter the store");
}

{
  const broken = eventRoutine({ kind: "event", source: "github", jq: ".fields.action ==" });
  const verdict = await evaluateSubscription(broken, pr);
  ok("invalid" in verdict && verdict.match === false, "fire-time: a filter that will not parse is INVALID, never a match");
  ok("invalid" in verdict && verdict.invalid.length > 0, "fire-time: the invalid verdict carries a reason to put in the audit row");

  const nonBool = await evaluateSubscription(eventRoutine({ kind: "event", source: "github", jq: ".fields.action" }), pr);
  ok("invalid" in nonBool && nonBool.match === false, "fire-time: a filter yielding a STRING is invalid, not a truthy match");

  const bombed = await evaluateSubscription(eventRoutine({ kind: "event", source: "github", jq: "[limit(100000000; repeat(1))] | length > 0" }), pr);
  ok("invalid" in bombed && bombed.match === false, "fire-time: an expression that blows the iteration bound is invalid — bounded, not hung, not fired");

  const unknownSource = eventRoutine({ kind: "event", source: "gitlab", jq: "true" });
  ok((await evaluateSubscription(unknownSource, pr)).match === false, "fire-time: a routine on a different source never matches");
  ok((await evaluateSubscription(eventRoutine({ kind: "interval", everyMinutes: 5 }), pr)).match === false, "fire-time: a clock routine never matches an event");
}

{
  const good = '.scope.container == "me/proj"';
  ok(throws(() => validateSubscription("github", good)) === null, "create: a well-formed subscription passes the static gate");
  ok((await throwsAsync(() => probeFilter(good, "github", ["event", "action", "repo", "sender"]))) === null, "create: …and the compile probe too");

  const unknown = throws(() => validateSubscription("gitlab", good));
  ok(unknown !== null && unknown.includes("github"), "create: an UNKNOWN SOURCE is refused, naming the known set — this is what kills the typo'd-source silent-no-op class");

  const badSyntax = await throwsAsync(() => probeFilter(".fields.action ==", "github", ["action"]));
  ok(badSyntax !== null && badSyntax.includes("github"), "create: an expression that will not PARSE is refused at authoring time, naming the source");
  ok((await throwsAsync(() => probeFilter(".fields.action", "github", ["action"]))) !== null, "create: an expression that yields a STRING is refused — it could never fire");
  ok((await throwsAsync(() => probeFilter("input_filename", "github", ["action"]))) !== null, "create: an unknown function is refused");
  ok((await throwsAsync(() => probeFilter("(true, false)", "github", ["action"]))) !== null, "create: an expression yielding two values is refused");
  ok((await throwsAsync(() => probeFilter("[limit(100000000; repeat(1))] | length > 0", "github", ["action"]))) !== null, "create: an expression that blows the iteration bound is refused BEFORE it is ever armed");

  ok(throws(() => validateSubscription("github", "")) !== null, "create: an empty expression is refused");
  ok(throws(() => validateSubscription("github", "x".repeat(FILTER_MAX_LENGTH + 1))) !== null, "create: an over-long expression is refused — past that it is not a predicate a human can check on a card");
}

{
  const naked = throws(() => validateSubscription("github", undefined));
  ok(naked !== null && naked.includes("narrow"), "narrowing: a filter-less subscription is REFUSED at create — 'every event in the tenant' has to be spelled out");
  ok(throws(() => validateSubscription("github", "true")) !== null, "narrowing: `true` is refused — subscribing to everything is exactly what the rule exists to make deliberate");
  ok(throws(() => validateSubscription("github", '(.fields["action"] | IN("opened"))')) !== null, "narrowing: narrowing only by a NON-scope field is not narrowing");
  ok(throws(() => validateSubscription("github", '(.fields["repo"] | IN("me/proj"))')) === null, "narrowing: a clause on a declared SCOPE key satisfies the rule");
  ok(throws(() => validateSubscription("github", '.fields.repo == "me/proj"')) === null, "narrowing: …in either jq spelling — `.fields.repo` as well as `.fields[\"repo\"]`");
  ok(throws(() => validateSubscription("github", '.scope.container == "me/proj"')) === null, "narrowing: a `.scope.<kind>` reference satisfies the rule");
  ok(throws(() => validateSubscription("github", '(.scopePath | any(.id == "me/proj"))')) === null, "narrowing: the ordered `.scopePath` form counts too");
  ok(narrowsScope('.fields.repository == "x"', githubEventNormalizer) === false, "narrowing: the scope-key check is word-bounded — a LONGER field that merely starts with a scope key does not count");
  ok((await evaluateSubscription(eventRoutine({ kind: "event", source: "github" }), pr)).match === true, "narrowing: a STORED filter-less row still matches at fire time (the reversal is not retroactive)");
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
  ok(throws(() => validateSubscription("flat", '(.fields["event"] | IN("x"))')) === null, "narrowing: a source with no container level is not asked to narrow below one");
}

{
  const t = storedTrigger({ kind: "event", source: "github", jq: '.scope.container == "me/proj" and (.fields.action | IN("opened","reopened"))' } as never);
  ok(t.kind === "event" && t.jq?.includes(".scope.container") === true, "authoring: the jq expression lands on the stored trigger verbatim");
  ok((t as { match?: unknown; filter?: unknown }).match === undefined && (t as { filter?: unknown }).filter === undefined, "authoring: nothing new is ever written in either LEGACY shape");

  ok(throws(() => storedTrigger({ kind: "event", source: "typo-hub", jq: '.scope.container == "x"' } as never)) !== null, "authoring: create_routine REFUSES a typo'd source (it used to accept any string and arm a dead routine)");
  ok(throws(() => storedTrigger({ kind: "event", source: "github", jq: '(.fields.action | IN("opened"))' } as never)) !== null, "authoring: create_routine enforces the narrowing rule");
  ok(throws(() => storedTrigger({ kind: "event", source: "github", jq: '.scope.container == "me/proj" and' } as never)) === null, "authoring: storedTrigger is the STATIC half — a parse error passes it and is caught by the async probe execute() awaits");
}

{
  const expression = '.scope.container == "me/proj" and (.fields.action | IN("opened","reopened"))';
  const d = describeTrigger({ kind: "event", source: "github", jq: expression });
  ok(d.includes(expression), "describe: the arm card renders the EXACT expression that will be evaluated");
  ok(describeFilter("github", {}).includes("EVERY event"), "describe: an unnarrowed subscription says so loudly");
}

resetEventNormalizersForTest();
ok(registeredEventSources().length === 0, "registry: the test reset seam clears every registration");
registerEventNormalizer(githubEventNormalizer);
ok(eventNormalizer("github") !== undefined, "registry: re-registration works after a reset");

console.log(`✓ event-routing: ${passed} assertions passed`);
