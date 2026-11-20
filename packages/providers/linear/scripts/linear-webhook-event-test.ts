import { parseLinearWebhookEvent } from "../agent/channels/linear-webhook-event.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const headers = new Headers({ "linear-delivery": "delivery-1", "linear-event": "AgentSessionEvent" });
const parse = (payload: unknown): ReturnType<typeof parseLinearWebhookEvent> => parseLinearWebhookEvent({ body: JSON.stringify(payload), headers });

console.log("1. agent-session events:");
{
  const ev = parse({
    action: "prompted",
    agentActivity: { content: { body: "please look again", type: "prompt" }, id: "act-1", signal: null, sourceCommentId: "c-2", user: { id: "u-1", name: "Ada" } },
    agentSession: {
      commentId: "c-1",
      creator: { id: "u-1", name: "Ada" },
      id: "as-1",
      issue: { id: "i-1", identifier: "ENG-1", title: "Fixture issue", url: "https://example.test/i-1" },
      issueId: "i-1",
      organizationId: "org-1",
      sourceCommentId: null,
      summary: null,
    },
    appUserId: "app-1",
    organizationId: "org-1",
    previousComments: ["first", { body: "second" }, { other: 1 }, 7],
    promptContext: "<issue/>",
    type: "AgentSessionEvent",
  });
  ok(ev !== null && ev.kind === "agent_session", "an AgentSessionEvent parses to the agent_session kind");
  if (ev === null || ev.kind !== "agent_session") process.exit(1);
  ok(ev.action === "prompted" && ev.organizationId === "org-1" && ev.appUserId === "app-1", "the top-level facts carry over");
  ok(ev.agentSession.id === "as-1" && ev.agentSession.issue?.identifier === "ENG-1" && ev.agentSession.commentId === "c-1", "the agent session and its issue carry over");
  ok(ev.agentSession.sourceCommentId === null && ev.agentSession.summary === null, "an explicit null is kept, not dropped");
  ok(ev.agentActivity?.body === "please look again" && ev.agentActivity.sourceCommentId === "c-2" && ev.agentActivity.signal === null, "the activity body comes from its content");
  ok(JSON.stringify(ev.previousComments) === JSON.stringify(["first", "second"]), "previous comments keep strings and bodies, and drop anything else");
  ok(ev.delivery.id === "delivery-1" && ev.delivery.event === "AgentSessionEvent", "the delivery headers carry over");
  ok((ev.raw as { promptContext?: unknown }).promptContext === "<issue/>", "the raw payload rides along for the normalizers");
  const created = parse({ agentSession: { id: "as-2" }, type: "AgentSessionEvent" });
  ok(created !== null && created.kind === "agent_session" && created.action === "created", "a missing action defaults to created");
  ok(parse({ agentSession: { issueId: "i-1" }, type: "AgentSessionEvent" }) === null, "🔴 an agent session with no id is null — never a session the router can act on");
  ok(parse({ type: "AgentSessionEvent" }) === null, "🔴 an AgentSessionEvent with no agent session is null");
}

console.log("2. data events and refusals:");
{
  const data = parse({ action: "create", data: { id: "c-9" }, organizationId: "org-1", type: "Comment" });
  ok(data !== null && data.kind === "data" && data.type === "Comment" && data.action === "create" && data.organizationId === "org-1", "any other typed payload is a data event");
  ok(parse({ action: "create" }) === null, "a payload with no type is null");
  ok(parse({ action: "create", type: "" }) === null, "an empty type is null");
  for (const body of ["not json", "[]", "42", "null"]) {
    let threw = false;
    try {
      parseLinearWebhookEvent({ body, headers });
    } catch {
      threw = true;
    }
    ok(threw, `a body that is not a JSON object throws (${body}) — the route's catch drops it`);
  }
}

console.log(`\n✓ linear-webhook-event: ${passed} assertions passed`);
