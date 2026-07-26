import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-ticket-create-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { sessionGrantKind } = await import("../agent/approvals/session-grant.js");
const {
  registerTicketCreateAdapter,
  resolveTicketCreate,
  supportedTicketCreatePlatforms,
  ticketCreateFn,
} = await import("../agent/channels/ticket-create.js");
const { createGithubIssue } = await import("../agent/scm/issue-actions.js");
type TicketCreateAdapter = import("../agent/channels/ticket-create.js").TicketCreateAdapter;
type TicketCreateArgs = import("../agent/approvals/ticket-create.js").TicketCreateArgs;
type BindableContext = import("../agent/identity/binding.js").BindableContext;
await import("../agent/approvals/flow.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function ctx(platform: string, attrs: Record<string, string> = {}, sources?: readonly string[]): BindableContext {
  return {
    channel: { kind: platform },
    session: { auth: { current: { attributes: { ...attrs, ...(sources ? { oe_sources: sources.join(",") } : {}) } } } },
  } as unknown as BindableContext;
}

{
  const platforms = supportedTicketCreatePlatforms();
  ok(platforms.includes("github"), "github's create adapter is registered (module-load side effect)");
  ok(!platforms.includes("linear"), "linear is NOT registered in core alone (its adapter is bundle-registered at boot)");
  ok(!platforms.includes("notion"), "notion is NOT registered — a database row's property schema can't be inferred (deliberate omission)");
  ok(typeof ticketCreateFn("github") === "function", "ticketCreateFn resolves a real registered adapter's create fn");
  ok(ticketCreateFn("bogus-platform") === undefined, "ticketCreateFn is undefined for an unregistered platform");
}

{
  let msg = "";
  try {
    resolveTicketCreate(ctx("notion", {}), { platform: "notion", target: "db-1" }, []);
    assert.fail("expected a throw");
  } catch (err) {
    msg = String((err as Error).message);
  }
  ok(/not supported on "notion"/.test(msg), `an unregistered platform refuses cleanly (${msg})`);
  ok(msg.includes("github"), "the refusal NAMES the supported set (github, in core alone)");
  ok(!msg.includes("filed") && !msg.includes("created"), "the refusal never claims anything was filed");
}

{
  assert.throws(
    () => resolveTicketCreate(ctx("slack", {}), { platform: "github", target: "acme/web" }, []),
    /not one of this window's sources/,
    "filing into a platform that doesn't fan into this window is refused (topology gate)",
  );
  n++;
}

{
  const calls: { target: string; title: string; body: string }[] = [];
  const adapter: TicketCreateAdapter = {
    platform: "test-create-a",
    create: async (target, draft) => {
      calls.push({ target, title: draft.title, body: draft.body });
      return { ref: { platform: "test-create-a", id: `${target}#1` }, url: "https://example.test/1", summary: `filed ${target}#1` };
    },
  };
  registerTicketCreateAdapter(adapter);
  registerTicketCreateAdapter({ platform: "test-create-b", create: async () => ({ ref: { platform: "test-create-b", id: "b#1" }, summary: "filed b#1" }) });

  const resolved = resolveTicketCreate(ctx("slack", {}, ["slack", "test-create-a"]), { target: "T-1" }, []);
  ok(resolved.platform === "test-create-a" && resolved.target === "T-1", "a window with ONE work surface infers the platform");
  const created = await resolved.run({ title: "hi", body: "there" });
  ok(created.ref.id === "T-1#1" && created.url === "https://example.test/1", "the bound `run` closure calls the adapter with (target, draft) and returns the neutral ref");
  ok(calls.length === 1 && calls[0].title === "hi" && calls[0].body === "there", "the draft reaches the adapter intact");

  let noneMsg = "";
  try {
    resolveTicketCreate(ctx("slack", {}), undefined, []);
    assert.fail("expected a throw");
  } catch (err) {
    noneMsg = String((err as Error).message);
  }
  ok(/none of this window's sources/.test(noneMsg), `a window with no work surface refuses (${noneMsg})`);
  ok(noneMsg.includes("github") && noneMsg.includes("test-create-a"), "that refusal also names the supported set");

  assert.throws(
    () => resolveTicketCreate(ctx("slack", {}, ["slack", "test-create-a", "test-create-b"]), { target: "T-1" }, []),
    /more than one work surface.*pass `platform`/s,
    "an ambiguous window refuses rather than guessing which surface to file on",
  );
  n++;
}

{
  registerTicketCreateAdapter({
    platform: "test-create-default",
    defaultTarget: (c) => ((c as unknown as { session: { auth: { current: { attributes: Record<string, string> } } } }).session.auth.current.attributes.team ? "INFERRED" : undefined),
    create: async (target) => ({ ref: { platform: "test-create-default", id: `${target}#9` }, summary: `filed on ${target}` }),
  });
  const inferred = resolveTicketCreate(ctx("test-create-default", { team: "yes" }), undefined, []);
  ok(inferred.target === "INFERRED", "defaultTarget supplies the destination when the caller named none");
  const explicit = resolveTicketCreate(ctx("test-create-default", { team: "yes" }), { target: "EXPLICIT" }, []);
  ok(explicit.target === "EXPLICIT", "an explicit target always wins over defaultTarget");
  assert.throws(
    () => resolveTicketCreate(ctx("test-create-default", {}), undefined, []),
    /no destination.*pass `target`/s,
    "no target and nothing inferable refuses asking for it (never guesses a destination)",
  );
  n++;
}

{
  registerTicketCreateAdapter({
    platform: "test-create-gated",
    checkAccess: (_c, target) => {
      if (target === "forbidden") throw new Error("nope, not granted");
    },
    create: async (target) => ({ ref: { platform: "test-create-gated", id: `${target}#1` }, summary: "filed" }),
  });
  assert.throws(
    () => resolveTicketCreate(ctx("test-create-gated", {}), { target: "forbidden" }, []),
    /nope, not granted/,
    "checkAccess's refusal propagates from resolveTicketCreate (before anything is frozen)",
  );
  n++;
  ok(resolveTicketCreate(ctx("test-create-gated", {}), { target: "ok" }, []).target === "ok", "checkAccess passing lets resolution through");
}

const created: { target: string; title: string }[] = [];
registerTicketCreateAdapter({
  platform: "test-kind-platform",
  create: async (target, draft) => {
    created.push({ target, title: draft.title });
    return { ref: { platform: "test-kind-platform", id: `${target}#7` }, url: "https://example.test/7", summary: `Filed ${target}#7: "${draft.title}".` };
  },
});

function createArgs(over: Partial<TicketCreateArgs> = {}): TicketCreateArgs {
  return {
    org: "default",
    scopeKey: "slack/T1/C1",
    platform: "test-kind-platform",
    target: "ENG",
    title: "Login 500s on retry",
    body: "Steps: …",
    requestedBy: "U_PROPOSER",
    ...over,
  };
}

{
  const kind = actionKind("ticket.create");
  ok(kind !== undefined, "ticket.create is registered (flow.ts side-effect import)");
  ok(kind!.policy === "member", "ticket.create is MEMBER policy — audience-expanding, same tier as pr.open/ticket.set_state");
}

{
  const kind = actionKind("ticket.create")!;
  const lines = kind.summarize(createArgs());
  ok(lines[0].includes("test-kind-platform") && lines[0].includes("ENG"), "the card names the destination platform + target");
  ok(lines.some((l) => l.includes("Login 500s on retry")), "the card renders the exact title that will be published");
  ok(lines.some((l) => l.includes("Steps: …")), "the card renders the body too — a human reads the text before it reaches watchers");
  ok(!lines.some((l) => l.includes("⚠")), "no taint banner on a clean proposal");
  const tainted = kind.summarize(createArgs({ tainted: true }));
  ok(tainted.some((l) => l.includes("⚠") && l.includes("external content")), "a tainted proposal gets the reviewer-scrutiny banner (flagged, never auto-rejected — the sibling doctrine)");
}

{
  const row = (tainted: boolean) => ({ kind: "ticket.create", argsJson: JSON.stringify(createArgs({ tainted })) });
  ok(sessionGrantKind(row(false)) === null, "ticket.create is NOT session-grantable even untainted — an 'approve for session' click can never arm standing issue-filing");
  ok(sessionGrantKind(row(true)) === null, "…and a tainted one certainly isn't");
  ok(sessionGrantKind({ kind: "pr.open", argsJson: "{}" }) === "pr.open", "control: pr.open IS the session-grantable kind (so the null above is a real property, not a broken call)");
}

{
  created.length = 0;
  const kind = actionKind("ticket.create")!;
  const outcome = await kind.execute(createArgs(), "U_APPROVER");
  ok(outcome.includes("ENG#7") && outcome.includes("https://example.test/7"), `execute() returns the adapter's summary plus the item URL (${outcome})`);
  ok(created.length === 1 && created[0].target === "ENG" && created[0].title === "Login 500s on retry", "the adapter fn ran with the FROZEN target + draft");
  const audit = await readAudit({ org: "default", limit: 5 });
  const entry = audit.find((a) => a.action === "ticket.create");
  ok(entry !== undefined, "audits ticket.create");
  ok(entry!.principalId === "U_APPROVER", "audit principal is the DECIDER (approver), not the proposer");
  const detail = entry!.detail as Record<string, unknown>;
  ok(detail.platform === "test-kind-platform" && detail.target === "ENG" && detail.requestedBy === "U_PROPOSER", "audit detail carries platform/target/requestedBy");
  ok(detail.entityId === "ENG#7", "audit detail records the id of the item that was actually created");
  ok(detail.tainted === false, "audit detail stamps tainted:false on a clean proposal");
}

{
  const kind = actionKind("ticket.create")!;
  await assert.rejects(
    () => kind.execute(createArgs({ platform: "platform-that-no-longer-exists" }), "U_APPROVER"),
    /no create adapter is registered for platform "platform-that-no-longer-exists"/,
    "a stale pending row whose platform's adapter was removed fails with a legible reason",
  );
  n++;
}

interface StubCall {
  url: string;
  method: string;
  body: unknown;
}
function stubFetch(status: number, payload: unknown) {
  const calls: StubCall[] = [];
  const fetchFn = (async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
      json: async () => payload,
    };
  }) as never;
  return { fetchFn, calls };
}

{
  const { fetchFn, calls } = stubFetch(201, { number: 123, html_url: "https://github.com/acme/web/issues/123" });
  const out = await createGithubIssue(
    "acme/web",
    { title: "Login 500s on retry", body: "Steps: …" },
    { fetchFn, apiBase: "https://api.test", resolveToken: async () => "t0k" },
  );
  ok(calls.length === 1 && calls[0].url === "https://api.test/repos/acme/web/issues" && calls[0].method === "POST", "POSTs to the repo's issues collection");
  ok((calls[0].body as { title: string; body: string }).title === "Login 500s on retry", "sends the exact title");
  ok(out.ref.platform === "github" && out.ref.id === "acme/web#123", "returns the new item as a NEUTRAL EntityRef the mutation verbs already accept");
  ok(out.url === "https://github.com/acme/web/issues/123", "carries the human URL through");
}
{
  const { fetchFn, calls } = stubFetch(201, { number: 1 });
  await assert.rejects(
    () => createGithubIssue("not-a-repo", { title: "x", body: "" }, { fetchFn, resolveToken: async () => "t0k" }),
    /invalid repo "not-a-repo"/,
    "a malformed repo refuses BEFORE any network call",
  );
  n++;
  ok(calls.length === 0, "…and it really made no call");
}
{
  const { fetchFn } = stubFetch(422, "Validation Failed");
  await assert.rejects(
    () => createGithubIssue("acme/web", { title: "x", body: "" }, { fetchFn, resolveToken: async () => "t0k" }),
    /issue creation failed for acme\/web: 422/,
    "a non-2xx refuses loudly with the status (never a silent no-op)",
  );
  n++;
}
{
  const { fetchFn } = stubFetch(201, { html_url: "https://github.com/acme/web/issues/1" });
  await assert.rejects(
    () => createGithubIssue("acme/web", { title: "x", body: "" }, { fetchFn, resolveToken: async () => "t0k" }),
    /returned no issue number/,
    "a 2xx with no issue number refuses rather than inventing a ref",
  );
  n++;
}

console.log(`✓ ${n} ticket-create assertions passed`);
