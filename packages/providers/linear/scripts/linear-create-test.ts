import assert from "node:assert/strict";
import { createLinearIssue, linearTicketCreateAdapter } from "../agent/channels/linear-create.js";
import type { BindableContext } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface Call {
  readonly query: string;
  readonly variables: unknown;
}

function fakeLinearApi(table: ReadonlyArray<{ readonly match: RegExp; readonly data: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
    calls.push({ query: body.query, variables: body.variables });
    const hit = table.find((t) => t.match.test(body.query));
    if (!hit) throw new Error(`fakeLinearApi: no response configured for query starting: ${body.query.slice(0, 80)}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: hit.data }) };
  }) as unknown as typeof fetch;
  return { api: { fetch: fetchFn }, credentials: { accessToken: "test-token" }, calls };
}

const TEAMS = { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: "Operations" }] } };
const CREATED = { issueCreate: { success: true, issue: { id: "uuid-1", identifier: "ENG-42", url: "https://linear.app/acme/issue/ENG-42" } } };

{
  const { api, credentials, calls } = fakeLinearApi([
    { match: /OeFindTeam/, data: TEAMS },
    { match: /OeCreateIssue/, data: CREATED },
  ]);
  const out = await createLinearIssue("eng", { title: "Login 500s on retry", body: "Steps: …" }, { api, credentials });
  ok(calls.length === 2, "one teams-lookup query + one issueCreate mutation");
  const vars = calls[1].variables as { teamId: string; title: string; description: string };
  ok(vars.teamId === "t1", "the mutation uses the RESOLVED team id, not the input key");
  ok(vars.title === "Login 500s on retry" && vars.description === "Steps: …", "title + body ride through as title/description");
  ok(out.ref.platform === "linear" && out.ref.id === "ENG-42", "returns the new issue as a NEUTRAL EntityRef using its HUMAN identifier (what the mutation verbs accept)");
  ok(out.url === "https://linear.app/acme/issue/ENG-42", "carries the issue URL through");
  ok(out.summary.includes("ENG-42") && out.summary.includes("Login 500s on retry"), `the outcome names the issue and its title (${out.summary})`);
}
{
  const { api, credentials, calls } = fakeLinearApi([
    { match: /OeFindTeam/, data: TEAMS },
    { match: /OeCreateIssue/, data: CREATED },
  ]);
  await createLinearIssue("Operations", { title: "x", body: "" }, { api, credentials });
  ok((calls[1].variables as { teamId: string }).teamId === "t2", "a team NAME resolves as well as a key");
}
{
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const { api, credentials, calls } = fakeLinearApi([{ match: /OeCreateIssue/, data: CREATED }]);
  await createLinearIssue(uuid, { title: "x", body: "" }, { api, credentials });
  ok(calls.length === 1, "a literal UUID target skips the team-resolution query entirely");
  ok((calls[0].variables as { teamId: string }).teamId === uuid, "…and passes straight through as teamId");
}
{
  const { api, credentials } = fakeLinearApi([{ match: /OeFindTeam/, data: TEAMS }]);
  await assert.rejects(
    () => createLinearIssue("Bogus", { title: "x", body: "" }, { api, credentials }),
    /no team matching "Bogus".*available: ENG, OPS/s,
    "an unmatched team refuses, listing the real team keys (never guesses a destination)",
  );
  n++;
}
{
  const { api, credentials } = fakeLinearApi([
    { match: /OeFindTeam/, data: TEAMS },
    { match: /OeCreateIssue/, data: { issueCreate: { success: false } } },
  ]);
  await assert.rejects(
    () => createLinearIssue("ENG", { title: "x", body: "" }, { api, credentials }),
    /returned no issue/,
    "a mutation that comes back with no issue refuses rather than inventing a ref",
  );
  n++;
}

function ctx(attrs: Record<string, string>): BindableContext {
  return { channel: { kind: "linear" }, session: { auth: { current: { attributes: attrs } } } } as unknown as BindableContext;
}
{
  const d = linearTicketCreateAdapter.defaultTarget!;
  ok(d(ctx({ issue_id: "ENG-42" })) === "ENG", 'a human issue anchor ("ENG-42") yields team key "ENG" with no network call');
  ok(d(ctx({ issue_id: "PROD_X-7" })) === "PROD_X", "a key with an underscore/digits still parses (everything before the trailing -N)");
  ok(d(ctx({ issue_id: "550e8400-e29b-41d4-a716-446655440000" })) === undefined, "a UUID anchor yields NO default — the caller is asked for `target`, never guessed at");
  ok(d(ctx({})) === undefined, "no anchor at all yields no default");
}
{
  ok(linearTicketCreateAdapter.platform === "linear", "the adapter registers under platform \"linear\"");
  ok(linearTicketCreateAdapter.checkAccess === undefined, "no checkAccess — the workspace token is self-scoping (same doctrine as read_linear_issue / linearEntityAdapter)");
  ok(typeof linearTicketCreateAdapter.create === "function", "the adapter declares create — registration IS the declaration of support");
}

console.log(`✓ ${n} linear-create assertions passed`);
