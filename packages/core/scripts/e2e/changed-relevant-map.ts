import { pathMatchesGlob } from "../../agent/review/facts-artifact.js";

export interface ChangedRelevantArea {
  readonly area: string;
  readonly globs: readonly string[];
  readonly scenarios: readonly string[];
  readonly why: string;
}

export const CHANGED_RELEVANT_MAP: readonly ChangedRelevantArea[] = [
  {
    area: "slack-provider",
    globs: ["packages/providers/slack/**"],
    scenarios: [
      "J1", "J2", "S-MEM-READ", "J3", "S6", "S8", "S9", "S10", "S11", "S13", "S14", "S-LINK-SLACK",
      "J4", "J-MPIM", "S20", "S23", "S24", "F-ART", "F-QA-REPO", "F-EDIT", "F-SEC", "J-SUP", "J-UNIFIED", "J-UNI-X", "J-PR",
      "S-PR-SESSION", "S-PR-BOUNDARY", "S-AWS-BOUNDARY", "J-WORKFLOW", "S-NOTION-WRITE",
      "S-CONNECTOR-TIER", "S-DM-NOTION", "S-EVE-CARD", "S-CONNECT-CARD", "S-APIKEY-INTAKE",
      "S-UNATTENDED-DENY", "S-MEMORY-CANVAS", "S-DM-MCP-PROPOSE",
    ],
    why: "Slack is the default e2e surface — every scenario without its own dedicated surface drives through it (`surface: \"slack\"` or `\"cross\"` in scenarios.ts), so a Slack provider change is broadly relevant by construction, not an over-selection.",
  },
  {
    area: "discord-provider",
    globs: ["packages/providers/discord/**"],
    scenarios: ["J-DISC", "S8", "S-DISCORD-GRANT", "S-DELEGATED-discord", "S-AMBIENT-discord", "S-SIBLING-discord", "S-SUSPENDED-discord", "S-LINK-discord"],
    why: "J-DISC is surface: \"discord\"; S8 is the Slack→Discord cross-surface recall leg (surface: \"cross\"); S-DISCORD-GRANT drives the Discord grant-card door (access/discord-grant-click.ts) and the Discord DM arm the owner notice rides. (S-DM-DISCORD retired at OPE-725 — see scenarios.ts.)",
  },
  {
    area: "teams-provider",
    globs: ["packages/providers/teams/**"],
    scenarios: ["J-TEAMS", "J-TEAMS-DM", "J-ENGAGED-teams", "S-DELEGATED-teams", "S-AMBIENT-teams", "S-SIBLING-teams", "S-SUSPENDED-teams", "S-LINK-teams", "S-CARD-teams", "S-CARD-teams-dm", "J-NAMEDROP-teams", "S-OE-CMD-teams", "S-INTRO-teams", "S-COVER-teams"],
    why: "The three surface: \"teams\" scenarios — the channel, the 1:1 DM, and the ambient engagement seam (OPE-1500: @mention engages, a plain follow-up wakes, stand_down stops it). J-TEAMS is also the smoke-lane's non-Slack half (scenarios.ts smoke: true); the other two are not — J-TEAMS-DM self-skips until the driver's Chat.* Graph scope is consented (OPE-972), and J-ENGAGED-teams self-skips when the tenant has not consented to the ChannelMessage.Read.Group RSC grant, without which Microsoft never delivers the plain follow-up it asserts on.",
  },
  {
    area: "github-provider",
    globs: ["packages/providers/github/**"],
    scenarios: ["J-GH", "J-ENGAGED-github", "J-PR", "S-PR-SESSION", "S-PR-BOUNDARY", "J-WORKFLOW", "J-UNI-X", "S-DELEGATED-github", "S-SUSPENDED-github", "S-GITHUB-NOTION-REST"],
    why: "J-GH and J-ENGAGED-github are surface: \"github\"; S-GITHUB-NOTION-REST is cross-surface with a GitHub origin. J-ENGAGED-github drives the ambient engagement seam (OPE-1501), while S-GITHUB-NOTION-REST joins an exact issue comment through the GitHub dispatch/wake/session/reply path to a verified shared Notion write. The rest open, read status on, or subscribe to a real GitHub PR (open_pull_request's chain) and would break silently on a GitHub adapter regression even though they run through Slack.",
  },
  {
    area: "linear-provider",
    globs: ["packages/providers/linear/**"],
    scenarios: ["J-LIN", "J-ENGAGED-linear", "S-DELEGATED-linear", "S-AMBIENT-linear", "S-SUSPENDED-linear"],
    why: "The two surface: \"linear\" scenarios. J-ENGAGED-linear drives the ambient engagement seam (OPE-1501), which no other Linear scenario reads — and it is the only leg that exercises Linear's plain-comment path as a FOLLOW-UP route, because the Agent Session ends on its own reply.",
  },
  {
    area: "notion-provider",
    globs: ["packages/providers/notion/**"],
    scenarios: ["J-NOT", "J-ENGAGED-notion", "S24", "S-NOTION-WRITE", "S-CONNECTOR-TIER", "S-DM-NOTION", "S-EVE-CARD", "S-CONNECT-CARD", "S-APIKEY-INTAKE", "S-OWN-ACCOUNT-NOTION", "S-DELEGATED-notion", "S-SIBLING-notion", "S-GITHUB-NOTION-REST"],
    why: "J-NOT and J-ENGAGED-notion are surface: \"notion\" — the second drives the ambient engagement seam (OPE-1501: a NAME-DROP engages the page, because Notion has no @mention of an integration) and is the only leg that reads the ingress's addressing-aware ambient gate. The rest drive a live Notion integration (read at S24/S-DM-NOTION, write at S-NOTION-WRITE/S-CONNECTOR-TIER, offer/intake at S-CONNECT-CARD/S-APIKEY-INTAKE, and raw shared REST plus independent API readback at S-GITHUB-NOTION-REST). S-OWN-ACCOUNT-NOTION (OPE-1599) is surface: \"notion\" as well, and it is the only leg that GATES on the `connector.acting_identity` row. J-NOT's ordinary reads run the same seam and write `install` rows, but assert nothing about them, so a gate regression that flips a refusal is visible only here. The dispatcher `channels/notion-acting-identity.ts` lives in THIS package and is the sole route to the own-account gate, so a change to it decides whether that row can be written at all.",
  },

  {
    area: "approvals",
    globs: ["packages/core/agent/approvals/**", "packages/core/agent/access/approver-chain.ts", "packages/core/agent/access/approval-*.ts", "packages/core/agent/access/pre-approval-rules.ts"],
    scenarios: ["J3", "J4", "S-PR-BOUNDARY", "S-AWS-BOUNDARY", "S-CONNECTOR-TIER", "S-NOTION-WRITE", "S-EVE-CARD", "J-PR", "S-PR-SESSION", "F-SEC", "S-JUDGE-LIFT-NOTICE", "S-CARD-SUMMARY", "S-SUSPENDED-slack", "S-SUSPENDED-discord", "S-SUSPENDED-teams", "S-SUSPENDED-linear", "S-SUSPENDED-github"],
    why: "These gate on an `approval.chain` row (verdict, transform, card-vs-judge path) — the doctrine's P1.1 list of what the approval seam must prove. S-EVE-CARD is the one exception and belongs here for the opposite reason: it drives the EVE-MINTED card, which never enters OE's approvals plane, so it gates on the card's identity and on the click resuming the turn, and RECORDS the approval.chain row count instead of gating on it (OPE-1056). S-JUDGE-LIFT-NOTICE (OPE-1902) belongs here because it is the only leg on the road a lift takes INSTEAD of a card: `approvals/flow.ts` posts the notice off the row's frozen `postedTo` and `approvals/card.ts` renders it, so a change under this glob decides whether an act that ran without asking leaves any trace in the room at all. S-CARD-SUMMARY (OPE-2434) belongs here because `approvals/card.ts` and `approvals/plain-summary.ts` write the plain first line it reads off a live card.",
  },
  {
    area: "a2a",
    globs: [
      "packages/core/agent/a2a/**",
      "packages/core/agent/approvals/a2a-delegate.ts",
      "packages/core/agent/tools/delegate_to_agent.ts",
      "packages/core/agent/tools/check_agent_task.ts",
      "agent/access/a2a-agents.ts",
      "agent/access/a2a-inbound.ts",
      "packages/core/agent/channels/a2a-inbound.ts",
    ],
    scenarios: ["S-A2A-DELEGATE", "S-A2A-INBOUND"],
    why: "S-A2A-DELEGATE is the only live leg on the outbound A2A client (OPE-2425): the a2a.delegate card, the armed second call, the declared agent's answer in the thread, and the two a2a.* audit rows. S-A2A-INBOUND is the live leg on the inbound ingress (OPE-2448): the published card and the 401 an unauthenticated call gets.",
  },
  {
    area: "taint",
    globs: [
      "packages/core/agent/access/taint-*.ts",
      "packages/core/agent/access/untrusted*.ts",
      "packages/core/agent/access/ingestion-*.ts",
      "packages/core/agent/channels/channel-read.ts",
      "packages/core/agent/access/skill-taint-envelope.ts",
      "packages/core/agent/access/subagent-taint.ts",
      "packages/core/agent/access/task-call-link.ts",
      "packages/core/agent/approvals/taint-disclosure.ts",
      "packages/core/agent/hooks/spawn-taint.ts",
    ],
    scenarios: ["F-SEC"],
    why: "F-SEC's untrusted-content probe is the live leg on the envelope these files render. OPE-2726 removed the two taint legs (S-TAINT-DRYRUN, S-TAINT-ROUTE-LIVE) with the taint plane, and renamed the third to S-UNATTENDED-DENY, which proves the presence fence and is mapped under routines. The repo-root approver config (agent/access/bundles.ts) left this area with ARM E's lowering fixture; it stays mapped in its own area.",
  },
  {
    area: "identity",
    globs: ["packages/core/agent/identity/**"],
    scenarios: ["S-LINK-SLACK", "S-LINK-discord", "S-LINK-teams"],
    why: "S-LINK-SLACK is the only scenario asserting on `identity.link.*` audit rows (doctrine P1.4's worked example lives one layer below, in the derivation unit tests, not the live pack).",
  },
  {
    area: "memory",
    globs: ["packages/core/agent/memory/**"],
    scenarios: ["S-MEM-READ", "J2", "S-DM-NOTION"],
    why: "S-MEM-READ and J2 exercise recall/silo isolation/purge directly; S-DM-NOTION's DM seat carries personal memory as part of its journey.",
  },
  {
    area: "exit-kit",
    globs: ["packages/core/agent/exit/**"],
    scenarios: ["S-EXIT-KIT"],
    why: "S-EXIT-KIT (OPE-2527) is the only leg that runs the org export and the per-person erasure against a live store, so a change to the catalogue, the SQL builder or either function reds it.",
  },
  {
    area: "routines",
    globs: ["packages/core/agent/routines/**", "packages/core/agent/tools/*_routine*.ts", "packages/core/agent/tools/*routine*.ts"],
    scenarios: ["S23", "S-UNATTENDED-DENY", "S-ROUTINE-CONNECTOR-WRITE", "S-ROUTINE-TEST", "S-ASK-WATCH", "S-FIRST-DAY-BRIEF"],
    why: "S23 proves create_routine(\"once\") acks; S-UNATTENDED-DENY proves a real dispatcher-fired routine's gated action is refused before the approval plane (doctrine P2.6); S-ROUTINE-CONNECTOR-WRITE is the only leg reading a routine's DECLARED standing-permission row back at fire time (routines/declared-permissions.ts), so a change to the grant key or the declare vocabulary reds it; S-ROUTINE-TEST (OPE-2515) is the only leg on a test run, so a change to the test stamp or the allow list (routines/test-run.ts) reds it; S-ASK-WATCH (OPE-2510) is the only leg on a watch asked for in chat, so a change to routines/ask-watch.ts or the watch headline reds it; S-FIRST-DAY-BRIEF (OPE-2662) is the only leg on a host-raised card that arms two routines and a first run due at the click, so a change to the routine.create execute's first run or the watch's quiet-when-empty rule reds it.",
  },
  {
    area: "routine-test-run",
    globs: [
      "packages/core/agent/schedules/routine-test-run.ts",
      "packages/core/agent/hooks/routine-test-run.ts",
      "packages/core/agent/access/test-run-fence.ts",
      "packages/core/agent/access/test-run-state.ts",
    ],
    scenarios: ["S-ROUTINE-TEST", "S-ROUTINE-TEST-discord"],
    why: "S-ROUTINE-TEST (OPE-2515) is the only live leg on a Slack routine test run: the dispatcher starts it in its own thread, the toolset fence blocks the run's write on a real model turn, and the hook posts the summary. S-ROUTINE-TEST-discord (OPE-2540) is the same road on Discord, through the bundle's test-run arm. `test:routine-test-run` and `test:routine-test-run-surfaces` drive both offline.",
  },
  {
    area: "webhooks",
    globs: [
      "packages/core/agent/webhooks/**",
      "packages/core/agent/tools/declare_webhook.ts",
      "packages/core/agent/tools/rotate_webhook.ts",
      "packages/core/agent/tools/read_webhook_history.ts",
      "packages/core/agent/tools/list_webhooks.ts",
    ],
    scenarios: ["S20", "J-GH", "J-LIN", "J-NOT"],
    why: "S20 is the direct signed-POST ingress proof; J-GH/J-LIN/J-NOT each include a forge-replay ambient wake off the same webhook plane.",
  },
  {
    area: "spend",
    globs: ["packages/core/agent/spend/**"],
    scenarios: ["S10"],
    why: "S10 is the only scenario proving the spend-cap circuit breaker and which ingress door it refused at.",
  },
  {
    area: "credentials-and-connectors",
    globs: ["packages/core/agent/credentials/**", "packages/core/agent/connections/**", "packages/core/agent/hooks/own-account-ask.ts"],
    scenarios: ["S-NOTION-WRITE", "S-CONNECTOR-TIER", "S-EVE-CARD", "S-CONNECT-CARD", "S-APIKEY-INTAKE", "S-AWS-BOUNDARY", "S-ROUTINE-CONNECTOR-WRITE", "S-DISCORD-GRANT", "S-OWN-ACCOUNT-NOTION", "S-GITHUB-NOTION-REST"],
    why: "These are the connector-WRITE and credential-intake legs (doctrine P3.9) — a credential broker or connector-auth regression breaks them without necessarily breaking a read-only Notion scenario. S-ROUTINE-CONNECTOR-WRITE is the only leg on `withUnattendedConnectorFence` (connections/connector-auth.ts), and S-DISCORD-GRANT the only one on the credential-GRANT plane. S-OWN-ACCOUNT-NOTION (OPE-1599) is the only leg that GATES on the `connector.acting_identity` row — the row `connections/own-account-gate.ts` writes when it refuses a team-key read of a member's own account. J-NOT's ordinary Notion reads run the same gate and write `install` rows, but assert nothing about them. That gate decides WHICH credential a connector read spends, so the leg belongs with the credential legs even though it reads rather than writes. `hooks/own-account-ask.ts` is in the globs for the same leg: it is the sole producer AND clearer of the `oe_own_account_ask` stamp the gate reads before the requester's own words (OPE-1597), so a change there decides whether the refusal can be produced at all. That file sat outside every glob until OPE-1599 — a change touched it and this map selected no leg that drives it. S-EVE-CARD is the only leg that SETTLES a `connectorApprovalPolicy()` card, so a change that stops eve receiving the policy — the OPE-1218 class, where the resolver drops a non-function `approval` — reds it.",
  },
  {
    area: "shared-notion-rest-egress",
    globs: [
      "agent/access/bundles.ts",
      "agent/plugins/registry.ts",
      "agent/plugins/skill-content.ts",
      "packages/core/agent/access/bundle.ts",
      "packages/core/agent/access/resolver.ts",
      "packages/core/agent/access/credentials.ts",
      "packages/core/agent/access/egress.ts",
      "packages/core/agent/hooks/egress.ts",
      "packages/core/agent/skills/scoped.ts",
    ],
    scenarios: ["S-GITHUB-NOTION-REST"],
    why: "S-GITHUB-NOTION-REST is the live workflow that crosses every part of the shared notion-rest route: the domain binding and connection in app access config, the plugin alias and packaged skill, scoped skill resolution, brokered header resolution, and sandbox policy compilation/application. It verifies the mutation through an independent Notion credential and requires a policy row for the GitHub scope to name the notion-rest credentialed write route.",
  },
  {
    area: "memory-you-can-see",
    globs: [
      "packages/core/agent/home/**",
      "packages/core/agent/memory/visible.ts",
      "packages/providers/slack/agent/channels/slack-home.ts",
    ],
    scenarios: ["S-APP-HOME"],
    why: "S-APP-HOME (OPE-2451) is the only live leg on the person's Home tab: a signed open publishes the page, Export hands the person their memory, and a forged Forget erases nothing. A change to the page model, the memory data plane behind it or the Slack half reaches exactly that leg. The domain memory canvas is NOT here: S-APP-HOME never reads a canvas, so it has its own area below (OPE-2499).",
  },
  {
    area: "outbound-filter",
    globs: [
      "packages/core/agent/access/sensitive-data.ts",
      "packages/core/agent/access/outbound-filter.ts",
      "packages/core/agent/audit/secret-shapes.ts",
    ],
    scenarios: ["S-OUTBOUND-SENSITIVE"],
    why: "S-OUTBOUND-SENSITIVE (OPE-2665) is the only live leg on the outbound sensitive-data filter. It plants a card number and a passport number in a file the agent reads, asks for both to be posted, and gates that neither reaches the room and that no `outbound.withheld` row names a value. The detectors, the sink table and the shared secret shapes decide what it refuses.",
  },
  {
    area: "voice-clips",
    globs: [
      "packages/core/agent/channels/voice-clips.ts",
      "packages/providers/slack/agent/channels/slack-voice-clips.ts",
      "packages/adapters/agent/model/meeting-gateway.ts",
      "packages/adapters/agent/model/transcription-routes.ts",
    ],
    scenarios: ["S-VOICE-CLIP"],
    why: "S-VOICE-CLIP (OPE-2524) is the only live leg that sends a real voice clip. It uploads a spoken clip with no typed text into the real DM and gates that the reply carries the word the clip spoke, and that a `voice.transcribed` row with no transcript landed. The core file decides and bills, the Slack file fetches and rewrites the message, and the two adapters files build the transcriber from the stack's transcription role, so a change to any of them changes whether the agent hears the clip.",
  },
  {
    area: "data-policy",
    globs: ["packages/adapters/agent/model/gateway.ts", "packages/core/agent/model/data-policy.ts"],
    scenarios: ["S-DATA-POLICY"],
    why: "S-DATA-POLICY (OPE-2535) is the only leg that runs a turn under `models.dataPolicy`. It reads the policy off `/oe status` and gates that a DM turn is answered under it. `gateway.ts` puts the rows on every model call and names a refusal, and `data-policy.ts` defines and validates them, so a change to either decides whether a turn under a policy is served.",
  },
  {
    area: "model-targets",
    globs: ["packages/adapters/agent/model/gateway.ts", "packages/adapters/agent/model/target-url.ts", "packages/core/agent/model/targets.ts"],
    scenarios: ["S-MODEL-TARGET"],
    why: "S-MODEL-TARGET (OPE-2556) is the only leg that runs a turn through a target with a `providers.only` row. It reads the target off `/oe status` and gates that a DM turn is answered through it. `gateway.ts` puts the target's rows on every call and builds the provider from its url, `target-url.ts` resolves that url, and `targets.ts` defines and validates the target, so a change to any of them decides whether a turn through the target is served.",
  },
  {
    area: "doing-for-you",
    globs: [
      "packages/core/agent/home/doing-home.ts",
      "packages/core/agent/status/doing-for-me.ts",
      "packages/core/agent/status/waiting-on-me.ts",
      "packages/core/agent/tools/doing_for_me.ts",
    ],
    scenarios: ["S-DOING"],
    why: "S-DOING (OPE-2522) is the only live leg on the person's one list: a signed Pause on their own watch item turns the watch off, and a Pause naming nothing of theirs changes nothing. The list's reads and the DM tool are driven offline by `test:doing-for-me`.",
  },
  {
    area: "slack-side-panel",
    globs: ["packages/providers/slack/agent/channels/slack-side-panel.ts"],
    scenarios: ["S-SIDE-PANEL"],
    why: "S-SIDE-PANEL (OPE-2505) is the only live leg on the Slack side panel. It forges a signed side-panel message that names the e2e channel as the viewed room, and gates that the person's DM seat answers in the panel thread, that the seat's wake carries the host note naming the room, and that no tool call of the turn reads the room: none names it by id or name, apart from the answer tools and the name lookup, and no no-target read returns it. `slack-side-panel.ts` parses the room, runs the strictest-default gates and writes the note, so a change to it changes all three answers.",
  },
  {
    area: "dm-approval-card",
    globs: [
      "packages/core/agent/approvals/card-disclosure.ts",
      "packages/core/agent/approvals/card-venue.ts",
      "packages/core/agent/access/audience-floor.ts",
      "packages/core/agent/tools/propose_mcp_server.ts",
      "packages/core/agent/approvals/mcp-server-propose.ts",
      "packages/providers/slack/agent/channels/slack-events.ts",
      "packages/providers/slack/agent/channels/slack-identity.ts",
    ],
    scenarios: ["S-DM-MCP-PROPOSE"],
    why: "S-DM-MCP-PROPOSE (OPE-2640) is the only live leg that posts an approval card in the person's own 1:1 DM and gates that no audience refusal came first. The card-disclosure floor (`card-disclosure.ts`, `audience-floor.ts`) reads the DM roster (`slack-events.ts` `slackImRoster`, OPE-2630), and `propose_mcp_server`'s own audience refusal reads the DM binding's trust (`slack-identity.ts` `bindSlack`). A change in any of these files decides whether a full member can approve in their own DM. The Grid shape of the DM is forged at tier 2 (tests/integration/approvals/grid-dm-card.test.ts).",
  },
  {
    area: "slack-agent-session",
    globs: [
      "packages/providers/slack/agent/channels/slack-agent-session.ts",
      "packages/providers/slack/agent/channels/slack-working-signs.ts",
      "packages/core/agent/channels/surface-session-state.ts",
    ],
    scenarios: ["S-SESSION-STOP", "J-MPIM"],
    why: "S-SESSION-STOP (OPE-2519) is the only live leg on Slack's Stop event. It forges a signed agent_session_stopped press for the person's running DM turn, and gates that the press takes the ✋ arm's cancel road (`turn.cancel_requested` with via `stop-button`) and that the turn's own process writes `turn.cancelled`. `slack-agent-session.ts` parses the press and resolves the turn. The leg also reads `reactions.get` on the DM message: 👀 while the turn runs, gone after the stop, and no 🛑 (a stop is not a failure). The setter in `slack-agent-session.ts` draws that sign through `surface-session-state.ts`, with the mention door's own function (`slack-working-signs.ts`). J-MPIM reads 👀 on the group-DM message while its turn runs and gone after the reply, and since OPE-2668 gates a `surface.working_sign_cleared` row within a short bound of the reply: the 👀 comes off at the answer through the answerer `surface-session-state.ts` registers.",
  },
  {
    area: "reply-feedback",
    globs: [
      "packages/providers/slack/agent/channels/slack-reply-blocks.ts",
      "packages/providers/slack/agent/channels/slack-reply-feedback.ts",
      "packages/core/agent/channels/reply-feedback.ts",
    ],
    scenarios: ["S-REPLY-FEEDBACK"],
    why: "S-REPLY-FEEDBACK (OPE-2520) is the only live leg on the native thumbs. It reads a DM answer back and gates that it carries Slack's feedback_buttons, then forges a signed thumbs-down on that message and gates on the one reply.feedback row. `slack-reply-blocks.ts` renders the control, `slack-reply-feedback.ts` parses the click and `reply-feedback.ts` writes the row, so a change to any of them changes an answer this leg gates.",
  },
  {
    area: "reply-follow-ups",
    globs: [
      "packages/providers/slack/agent/channels/slack-follow-ups.ts",
      "packages/providers/slack/agent/channels/slack-reply-blocks.ts",
      "packages/core/agent/channels/reply-follow-ups.ts",
    ],
    scenarios: ["S-REPLY-FOLLOWUPS"],
    why: "S-REPLY-FOLLOWUPS (OPE-2516) is the only live leg on suggested follow-ups. It reads a DM answer back and gates that it carries the promised follow-up as a button, then forges a signed press on it and gates that the agent answers the button's text in the same DM. `reply-follow-ups.ts` decides which follow-ups an answer keeps, `slack-reply-blocks.ts` renders the buttons and `slack-follow-ups.ts` turns a press into the person's next message, so a change to any of them changes what this leg gates.",
  },
  {
    area: "domain-memory-canvas",
    globs: [
      "packages/providers/slack/agent/channels/slack-memory-canvas.ts",
      "packages/core/agent/memory/write-road.ts",
      "packages/core/agent/memory/visible.ts",
      "packages/core/agent/channels/slack-canvas-list.ts",
    ],
    scenarios: ["S-MEMORY-CANVAS"],
    why: "S-MEMORY-CANVAS (OPE-2499) is the only leg that reads a channel canvas. It teaches a run-unique fact in the internal e2e channel, gates on the `memory.canvas_refresh` row the write road's Slack observer writes, and reads the channel's canvas back with the driver's own token to find the fact. Its second half classifies the domain's other channels from Slack itself, and in each shared or guest one gates that the refresh held the canvas back and that no canvas of the bot's holds the fact. `write-road.ts` notifies the observer, `visible.ts` renders the canvas document, and `slack-canvas-list.ts` names the channel canvas the observer rewrites, so a change to any of them decides what the canvas shows.",
  },
  {
    area: "agent-canvas-list",
    globs: [
      "packages/core/agent/channels/slack-canvas-list.ts",
      "packages/core/agent/approvals/slack-doc-write.ts",
      "packages/core/agent/tools/write_canvas.ts",
      "packages/core/agent/tools/update_list.ts",
    ],
    scenarios: ["S-CANVAS-LIST", "S-LIST-WRITE"],
    why: "S-CANVAS-LIST (OPE-2521) is the only leg that drives an agent-written canvas. It asks for a canvas in the e2e channel, gates that the canvas.write card previews it, approves it, and reads the canvas the canvas.write row names back from Slack with the driver's own token. S-LIST-WRITE (OPE-2551) is the only leg that drives an agent-written List. It asks for a row in the fixture List shared in the e2e channel and then for an edit of that row, gates that each list.write card quotes the change, approves it, and reads the row back from Slack with the driver's own token.",
  },
  {
    area: "cover",
    globs: ["packages/core/agent/cover/**", "packages/core/agent/commands/cover.ts", "packages/core/agent/schedules/cover-recap.ts"],
    scenarios: ["S-COVER", "S-COVER-teams"],
    why: "S-COVER (OPE-2513) and S-COVER-teams (OPE-2548) are the only live legs on out-of-office cover: `/oe cover on` from the DM, a mention in the base channel answered with the host's cover label, `/oe cover off`, and the recap row. S-COVER-teams drives it with two real Teams users, and its recap row is the one live read of the Teams team roster.",
  },
  {
    area: "reaction-feedback",
    globs: ["packages/core/agent/channels/reaction-ingest.ts", "packages/providers/slack/agent/channels/slack-events.ts"],
    scenarios: ["J-REACT-slack"],
    why: "J-REACT-slack (OPE-2271) is the only live leg on reaction feedback: a real 👍 on the agent's Slack reply, gated on the `reaction.feedback` row `reaction-ingest.ts` writes, and on the removed row after the 👍 comes off.",
  },
  {
    area: "personal-watch",
    globs: [
      "packages/core/agent/personal-watch/**",
      "packages/core/agent/commands/watch.ts",
      "packages/core/agent/commands/suggest.ts",
      "packages/core/agent/home/watch-home.ts",
      "packages/core/agent/hooks/personal-watch-enroll.ts",
      "packages/core/agent/hooks/question-ledger.ts",
      "packages/core/agent/schedules/personal-watch.ts",
      "packages/core/agent/onboarding/first-day-brief.ts",
    ],
    scenarios: ["S-WATCH", "S-DOING", "S-ROOM-SUGGEST", "S-FIRST-DAY-BRIEF"],
    why: "S-WATCH (OPE-2422) is the only live leg on the chief-of-staff watch: the person's dial through `/oe watch` and the Home tab, and a forged Not useful that moves no dose. The check itself has no live fixture and is driven offline. S-ROOM-SUGGEST (OPE-2550) is the live leg on the room's stop for room discovery's cards. S-FIRST-DAY-BRIEF (OPE-2662) is the only live leg on the first-day card: the enrolment hook posts it, and its click arms the brief and the check-in.",
  },
  {
    area: "meetings",
    globs: [
      "packages/core/agent/meetings/**",
      "packages/core/agent/tools/meeting_join.ts",
      "packages/core/agent/approvals/meeting-join.ts",
      "packages/core/agent/tools/meeting_recap.ts",
      "packages/core/agent/approvals/meeting-recap.ts",
      "packages/adapters/agent/meetings/**",
      "packages/core/agent/channels/meeting-callback.ts",
      "packages/core/agent/sandbox/long-lived-box.ts",
      "packages/adapters/agent/sandbox/long-lived-box.ts",
      "packages/adapters/agent/model/meeting-gateway.ts",
      "agent/meetings/policy.ts",
      "deploy/meeting-bot/**",
      "deploy/discord-relay/voice.js",
    ],
    scenarios: ["S-MEETING-RECAP", "S-MEETING-NATIVE-RECAP", "S-MEETING-DISCORD-VOICE"],
    why: "S-MEETING-RECAP (OPE-2459) is the only live leg on OE's own meeting bot: a channel ask with a Meet link raises one meeting.join card and nothing joins before a click. The join, the callbacks, the speaker names and the recap are tier 2's (OPE-2469); the bot's cut rule, handover and page reader are scripts/meeting-bot-test.ts. S-MEETING-NATIVE-RECAP (OPE-2471) is its twin for the platform's own transcript: a Zoom ask raises one meeting.recap card and nothing is read before a click; the read, the watch and the native recap are tier 2's. S-MEETING-DISCORD-VOICE (OPE-2473) is the same card leg asked in the e2e guild with a Discord voice channel link; the Discord bot's frame filter, member count, re-subscribe and cuts are scripts/meeting-bot-discord-test.ts, and the relay's voice sync is scripts/discord-relay-voice-test.ts.",
  },
  {
    area: "email",
    globs: [
      "packages/core/agent/email/**",
      "packages/core/agent/approvals/email-sender.ts",
      "packages/core/agent/tools/propose_email_sender.ts",
      "packages/providers/email/**",
      "agent/email/**",
    ],
    scenarios: ["S-EMAIL-ROOM-REPLY", "S-EMAIL-DM-FORWARD", "S-EMAIL-STRANGER-REFUSED"],
    why: "The three email legs (OPE-2440) are the only live legs on the email surface: an allowed sender's mail answered in its thread, a declared person's forward answered in their DM seat with the forward untrusted, and a stranger refused with no reply.",
  },
  {
    area: "personal-browser",
    globs: [
      "packages/core/agent/personal-browser/**",
      "packages/core/agent/tools/my_browser.ts",
      "packages/core/agent/tools/my_browser_handoff.ts",
      "packages/core/agent/approvals/personal-browser.ts",
      "packages/core/agent/channels/personal-browser.ts",
      "packages/core/agent/schedules/personal-browser-sweep.ts",
      "agent/personal-browser/policy.ts",
      "deploy/personal-browser/**",
    ],
    scenarios: ["S-PERSONAL-BROWSER"],
    why: "S-PERSONAL-BROWSER (OPE-2441) is the only live leg on the person's own browser: a channel ask opens nothing, and a DM ask opens, reads and closes with the hours billed. The watch page, the take-over lock and the act card are tier 2's.",
  },
  {
    area: "personal-surface-mcp",
    globs: [
      "packages/core/agent/connections/mcp-servers.ts",
      "packages/core/agent/connections/mcp-server-connection.ts",
      "packages/core/agent/connections/personal-surface-fence.ts",
      "packages/providers/slack/agent/slack-as-you.ts",
      "agent/access/mcp-servers.ts",
    ],
    scenarios: ["S-SLACK-AS-YOU"],
    why: "S-SLACK-AS-YOU (OPE-2421) is the only live leg on a personal-surface MCP server: Slack's own MCP server on a person's own sign-in. It proves the person's DM reads a channel the bot is not in, a channel seat never reaches the connection, and a post as the person raises a card.",
  },
  {
    area: "proactive-dm-road",
    globs: [
      "packages/core/agent/channels/dm-audience.ts",
      "packages/core/agent/channels/proactive-dm-manifest.ts",
      "packages/core/agent/tools/set_dm_delivery.ts",
      "packages/core/agent/access/chat-dm-grant.ts",
      "packages/core/agent/access/credential-grant-card.ts",
      "packages/core/agent/access/credential-grant-notice.ts",
    ],
    scenarios: ["S-DM-STOP-GRANT", "S-DISCORD-GRANT"],
    why: "S-DM-STOP-GRANT (OPE-1855) is the only leg that drives a person's own DM stop against a SECOND plane — it sets the stop by inference in a real 1:1 DM, then raises a credential-grant ask naming that same person as the owner, and gates on the dm.refused row rather than on any reply. It is the live half of the one-road rule the deterministic test:proactive-dm-road leg pins offline. S-DISCORD-GRANT rides beside it as the NEGATIVE control the stop leg cannot give: it proves the grant card and the first-use notice still reach an owner who has NOT stopped, so a road change that refused everything would red there rather than pass here.",
  },
  {
    area: "aws-tool",
    globs: ["packages/core/agent/tools/aws.ts", "packages/core/agent/connections/aws-*.ts"],
    scenarios: ["S-AWS-BOUNDARY"],
    why: "S-AWS-BOUNDARY is the only scenario on the ungated `aws` tool's one control — the fail-closed awsRoles grant.",
  },
  {
    area: "artifacts-and-attachments",
    globs: ["packages/core/agent/tools/post_file.ts", "packages/core/agent/tools/describe_image.ts", "packages/core/agent/tools/read_file_upload.ts"],
    scenarios: ["F-ART", "F-QA-REPO"],
    why: "F-ART is the only scenario driving post_file + describe_image + the attachment trusted-fetch path together. F-QA-REPO drives post_file and describe_image on a workspace screenshot (the { path } arms).",
  },
  {
    area: "browser-qa",
    globs: [
      "packages/core/agent/access/browser-toolkit.ts",
      "packages/core/agent/access/browser-hosts.ts",
      "packages/core/agent/tools/browser_tools.ts",
      "packages/adapters/agent/browser/**",
      "agent/access/browser-hosts.ts",
    ],
    scenarios: ["F-ART", "F-QA-REPO"],
    why: "F-ART leg 4 and F-QA-REPO are the only legs that drive the agent-browser tools; F-QA-REPO is the only one that browses a dev server a worker booted from a checked-out repo.",
  },
  {
    area: "input-request-bridge",
    globs: [
      "packages/core/agent/channels/question-bridge.ts",
      "packages/core/agent/channels/unified.ts",
      "packages/core/agent/channels/post-arms.ts",
      "packages/core/agent/channels/unified-reply.ts",
    ],
    scenarios: ["S-EVE-CARD", "S-SUSPENDED-slack", "S-DM-NOTION", "J-UNI-X", "J-SUP"],
    why:
      "S-EVE-CARD and S-SUSPENDED-slack drive a DM connector write to its OE `op.connector` card through these files, and they click it two ways: S-EVE-CARD replays the card's own rendered button whole, S-SUSPENDED-slack builds the click from the pending id. Both assert in the same leg that no eve-native approval was raised: since OPE-2340 (ruling Q4) no shipped tool prompts through eve, so a change here that revives a native request on the unified path is caught as a red, not as a parked turn. The typed-answer road (OPE-1721) and the unified approval card (OPE-1720) are deleted (OPE-2389): the unified `input.requested` handler drops every request with a `turn.question_dropped` row, which S-EVE-CARD gates on as a native request. S-DM-NOTION and J-SUP/J-UNI-X pay a delegated round trip through the same handler. A change here that drops the card post or the click route leaves a write denied with nobody able to approve it, and the failure is SILENCE, so no other leg would notice.",
  },
  {
    area: "wake-envelope",
    globs: ["packages/core/agent/channels/wake-envelope.ts", "packages/core/agent/channels/normalized-wake.ts"],
    scenarios: ["F-EDIT", "J1"],
    why: "F-EDIT is the live primary-model probe for the edit-aware wake envelope; J1 is the plain wake+continuity baseline the envelope also carries.",
  },
  {
    area: "delegation-and-subagents",
    globs: ["packages/core/agent/tools/spawn_thread_session.ts", "packages/core/agent/subagents/**"],
    scenarios: ["J-SUP", "S-DM-NOTION", "S-MEM-READ", "J-UNI-X", "S-DELEGATED-slack", "S-DELEGATED-discord", "S-DELEGATED-teams", "S-DELEGATED-linear", "S-DELEGATED-github", "S-DELEGATED-notion"],
    why: "Each of these pays a delegation round-trip as part of its own proof (S-MEM-READ/S-DM-NOTION need the control-read creds reached only via delegation; J-SUP/J-UNI-X route through a spawned worker). (S-DM-DISCORD retired at OPE-725 — see scenarios.ts.)",
  },
  {
    area: "delegation-identity",
    globs: [
      "packages/core/agent/channels/task-wake.ts",
      "packages/core/agent/access/dispatch-origin-signal.ts",
      "packages/core/agent/hooks/settlement-flush.ts",
    ],
    scenarios: ["J-SUP", "S-DM-NOTION", "S-MEM-READ", "J-UNI-X", "S-DELEGATED-slack", "S-DELEGATED-discord", "S-DELEGATED-teams", "S-DELEGATED-linear", "S-DELEGATED-github", "S-DELEGATED-notion"],
    why: "All three files fire on every real worker dispatch and settlement, through the same hooks/spawn-taint.ts wiring that calls openTaskWake/installTaskWake (task-wake.ts), addressedWakeThisTurn/noteTaskDispatchedThisTurn (dispatch-origin-signal.ts), and flushDirtyTreeAtTurnEnd/flushSettledMemory/noteTaskDispatched/noteTaskSettled/noteTaskViews (settlement-flush.ts). J-SUP/S-DM-NOTION/S-MEM-READ/J-UNI-X pay a real delegation round-trip through that exact wiring (the delegation-and-subagents area above), and each S-DELEGATED-<surface> leg drives a delegated worker on its own surface. A regression in any of these three files breaks the delegated round-trip every one of these scenarios requires to pass.",
  },
  {
    area: "connector-op-gating",
    globs: ["packages/core/agent/access/connector-op-gating.ts", "packages/core/agent/access/connector-scope.ts", "packages/core/agent/access/connector-disclosure.ts"],
    scenarios: ["S-CONNECTOR-TIER", "S-NOTION-WRITE"],
    why: "S-CONNECTOR-TIER is the direct live proof that classifyConnectorOp's read/write split gates at runtime; S-NOTION-WRITE is the write leg it splits against.",
  },
  {
    area: "pr-write-tool",
    globs: ["packages/core/agent/tools/open_pull_request.ts", "packages/core/agent/approvals/pr-open.ts"],
    scenarios: ["J-PR", "S-PR-SESSION", "S-PR-BOUNDARY", "J-WORKFLOW", "J-UNI-X"],
    why: "These are every scenario that calls open_pull_request — the one consequential-write door with its own approval shape (card vs. armed-judge vs. session-grant vs. ungranted-repo refusal).",
  },
  {
    area: "repo-checkout",
    globs: ["packages/core/agent/tools/checkout_repo.ts", "packages/core/agent/scm/broker.ts", "packages/core/agent/scm/broker-audit.ts", "packages/core/agent/scm/git.ts"],
    scenarios: ["J-PR", "F-QA-REPO", "S-GH-TOKEN"],
    why: "J-PR clones the fixture repo before it opens a PR; F-QA-REPO clones it to boot the repo's own dev server, and its checkout gate reads the scm.broker egress.policy row that broker-audit.ts writes. S-GH-TOKEN clones with a personal access token stamped at the firewall (OPE-2530).",
  },
  {
    area: "github-credential",
    globs: ["packages/core/agent/scm/credential.ts", "packages/core/agent/scm/provider.ts", "packages/core/agent/scm/write-token.ts", "packages/core/agent/scm/pr-status.ts"],
    scenarios: ["J-PR", "S-PR-SESSION", "J-GH", "S-GH-TOKEN"],
    why: "credential.ts decides whether a GitHub call presents an App token or the personal access token. J-PR and S-PR-SESSION drive the PR write and read through it in app mode, J-GH drives the conversation surface it gates, and S-GH-TOKEN drives the token mode.",
  },
  {
    area: "engagement-seam",
    globs: [
      "packages/core/agent/channels/engagement.ts",
      "packages/core/agent/tools/stand_down.ts",
    ],
    scenarios: ["J-ENGAGED-slack", "J-ENGAGED-discord", "J-ENGAGED-teams", "J-ENGAGED-github", "J-ENGAGED-linear", "J-ENGAGED-notion", "J1", "J-DISC", "S-AMBIENT-discord", "S-AMBIENT-linear", "S-AMBIENT-teams", "S-SIBLING-discord", "S-SIBLING-teams", "S-SIBLING-notion"],
    why: "The J-ENGAGED journeys drive the addressed-only posture, where the engagement registry is the ONLY thing that can deliver a plain follow-up — so they are the only scenarios that fail when it breaks. J-ENGAGED-teams (OPE-1500) belongs here for the sharpest reason of the six: its seam ships today and its journey is core, as are the GitHub, Linear and Notion three since OPE-1501 — so all six turn a regression in these two files RED. J1 and J-DISC ride along because both call `stand_down` on a windowed room and gate on its audit row, which is a second, weaker read of the same verb.",
  },
  {
    area: "seat-catch-up",
    globs: [
      "packages/core/agent/channels/seat-catch-up.ts",
      "packages/core/agent/channels/backscroll-window.ts",
    ],
    scenarios: ["J-ENGAGED-teams", "J-ENGAGED-github", "J-ENGAGED-linear", "J-ENGAGED-discord", "J-ENGAGED-notion", "J-ENGAGED-slack"],
    why: "Each of the five drives its own surface's catch-up end to end (OPE-1748, extended to Discord and Notion by OPE-1754): the stand-down makes an idle window, a plain message in it wakes nothing, and the seat's NEXT wake must carry that message and re-show nothing from before its last one. They are the only scenarios that can fail when the bound or the fetch regresses — every other e2e room is ambient or windowed, where a message said between wakes woke the seat anyway. FIVE, NOT SIX: J-ENGAGED-slack is out because Slack's catch-up shipped with OPE-1695 (b) and its journey drives the second name-drop instead. J-ENGAGED-discord and J-ENGAGED-notion drive the read as a BOT and as an INTEGRATION, which a seat's default `wide` admission drops before the envelope — and `wake.e2eDrivers` in `agent/settings/settings.ts` names both driver principals, so a red on either catch-up gate is a PRODUCT DEFECT in the catch-up read rather than a missing declaration. Delete either entry and that leg reds again. Each journey states the same rule at the point its leg sits, and AUDIT.md carries it too. The evidence is the seat's replayed transcript rather than a row, so `scripts/e2e-driver-test.ts` pins the reader (`seatCatchUpWake`) and these five legs prove it against a live deployment.",
  },
  {
    area: "spend-disclosure",
    globs: [
      "packages/core/agent/spend/dm-mask.ts",
      "packages/core/agent/spend/reporting.ts",
      "packages/core/agent/spend/ingress-gate.ts",
      "packages/core/agent/spend/store.ts",
      "packages/core/agent/hooks/spend.ts",
      "packages/core/agent/tools/spend_report.ts",
      "packages/core/agent/tools/usage_report.ts",
      "packages/core/agent/analytics/execute.ts",
      "packages/core/agent/analytics/compile.ts",
      "packages/core/agent/analytics/registry.ts",
      "packages/core/agent/operational/store.ts",
      "packages/core/agent/operational/sqlite.ts",
      "packages/core/agent/operational/postgres.ts",
    ],
    scenarios: ["S-SPEND-DM-MASK", "S-SPEND-REFUSAL-KEYS"],
    why:
      "OPE-1862/OPE-1860. S-SPEND-DM-MASK spends in a REAL DM and then has an ORG ADMIN read the org-scope spend report in a SHARED room. It proves two things of different widths, and neither is reachable offline: the DM surface the raw admin read has just named in the report's own window is absent from the report (the anti-doxxing exclusion, specific to that row), and the workspace-wide 30-day `(dms)` aggregate renders at all, so a stamped DM row reaches the report anonymously rather than being dropped or published. The stamp itself is written by the spend hook from a turn's own binding (`surface_mode`), and an unstamped row lands in `(unclassified)` instead — safe but wrong-looking, and invisible to every unit test. S-SPEND-REFUSAL-KEYS reads a live refusal's bytes against the cap layer its own reason names: the copy is a pure function, but it is only as right as the `layer`/`scopeKey` the gate hands it, and a gate that dropped either would render a refusal naming a cap that did not bite. Changing any file here changes one of those two answers.",
  },
  {
    area: "break-glass-halt",
    globs: [
      "packages/core/agent/access/halt.ts",
      "packages/core/agent/tools/halt.ts",
      "packages/core/agent/control/writes.ts",
      "packages/core/agent/operational/store.ts",
      "packages/core/agent/operational/sqlite.ts",
      "packages/core/agent/operational/postgres.ts",
    ],
    scenarios: ["S-HALT"],
    why: "S-HALT is the only live leg that asks for a surface halt through chat, joins it to the originating wake/session and exact stored address, then atomically clears only that observed halt through the local control plane. It exercises both doors and both operational adapters' shared conditional-clear contract.",
  },
  {
    area: "attention-states",
    globs: [
      "packages/core/agent/status/attention.ts",
      "packages/core/agent/tools/update_status.ts",
      "packages/core/agent/channels/proactive-dm-manifest.ts",
    ],
    scenarios: ["S-BLOCKED-PING"],
    why: "S-BLOCKED-PING is the only live leg that drives a seat into the blocked state and reads the attention.blocked outcome rows the proactive-DM road writes: one ping per blocked episode, for the asking person only.",
  },
  {
    area: "reply-provenance",
    globs: [
      "packages/core/agent/channels/reply-provenance.ts",
      "packages/core/agent/hooks/connector-audit.ts",
      "packages/core/agent/channels/read-reach.ts",
      "packages/core/agent/channels/delegated-provenance.ts",
      "packages/core/agent/hooks/spawn-taint.ts",
    ],
    scenarios: ["S-PROVENANCE-DM"],
    why: "S-PROVENANCE-DM (OPE-1717) is the ONLY live leg that joins a deployment's own `reply.provenance` row to the bytes the room received, so it is the only scenario that reds when the two halves disagree. `reply-provenance.ts` holds the ledger, the sources line the row records, and the forged-line strip. THREE doors fill that ledger, and each one calls `noteConnectorRead`: `hooks/connector-audit.ts` for a connector op, `channels/read-reach.ts` for an authored read tool, and `channels/delegated-provenance.ts` at the delegation settle, which `hooks/spawn-taint.ts` drives. An unwired call at ANY of the three leaves the row empty while every offline assertion stays green — the defect class OPE-1713 found on the bridge route. The WITHHELD arm of the same rule needs one turn holding two conversations, which no connector on this deployment can reach, so it is proven offline in `packages/core/scripts/reply-provenance-test.ts` and by no live leg.",
  },
  {
    area: "oe-budget-guest",
    globs: ["packages/core/agent/commands/core.ts", "packages/providers/slack/agent/channels/slack-commands.ts", "packages/core/agent/identity/binding.ts"],
    scenarios: ["S-OE-BUDGET-GUEST"],
    why: "S-OE-BUDGET-GUEST (OPE-2611) is the only live leg that reads what `/oe budget` answers per invoker: a member reads dollar figures, and a person `users.info` cannot check and a real Slack guest both get the members-only line in an internal room. `commands/core.ts` holds `budgetWithheldFrom` and the refusal line, `slack-commands.ts` reads the room verdict and the invoker probe into two trust values, and `identity/binding.ts` carries `roomTrust`. S6 drives the same command and cannot stand in: the refusal is a 200 with a body too.",
  },
  {
    area: "discord-dm-decision-wake",
    globs: ["packages/core/agent/approvals/flow.ts", "packages/providers/discord/agent/channels/discord-front.ts", "packages/core/agent/channels/dm-seat.ts"],
    scenarios: ["S-EVE-CARD-discord"],
    why: "S-EVE-CARD-discord (OPE-2385) is the only live leg on a Discord DM card's decision wake. `approvals/flow.ts` builds the DM target (`discordDecisionWakeTarget`) and checks the authority frozen at proposal, `discord-front.ts` takes the tap, and `dm-seat.ts` mints the DM seat on its `oe-dm/discord/…` domain. A person drives the ask and the tap, so the leg ends as a missing fixture until one did in the last day.",
  },
  {
    area: "deploy-sanity-facts",
    globs: ["packages/core/agent/commands/core.ts", "packages/core/agent/tools/agent_version.ts", "agent/agent.ts", "agent/model/stacks.ts"],
    scenarios: ["S-OE-STATUS"],
    why: "S-OE-STATUS (OPE-1818) is the only live leg that asserts what `/oe status` actually reports — the deployment sha, the eve pin and the context window with its compaction threshold. All FOUR globs are load-bearing, and the last two were the cold review's finding: `commands/core.ts` holds `renderStatus`, `tools/agent_version.ts` returns the SAME bag to the model (OPE-1634 is the measured case of those two disagreeing — the tool dropped two fields the command printed), `agent/agent.ts` is where `registerAppInfo` puts the window and the threshold INTO the bag, and `agent/model/stacks.ts` is the arithmetic behind the threshold. Without the last two, a pull request that repoints `models.stack` changes the window, changes the threshold, and selects no scenario — so the leg's pinned 525,000 would red the NEXT ship instead of that pull request. `agent/agent.ts` is deliberately shared with `core-agent-loop`: `relevantScenarios` unions every matching area, so a change there selects both sets. S6 drives the same command and cannot stand in for this leg — it gates only on a 200 with a non-empty body, which the renderer produces whatever the bag holds.",
  },
  {
    area: "core-agent-loop",
    globs: ["agent/agent.ts", "packages/core/agent/control/**"],
    scenarios: ["J1", "J2", "J3", "J4", "J-DISC", "J-GH", "J-LIN", "J-NOT"],
    why: "The core turn loop and eve-facing agent definition underlie every journey scenario; the J-prefixed set is the cheapest per-surface baseline that would catch a loop-level regression without re-running the whole roster.",
  },
];

export const SMOKE_FLOOR: readonly string[] = ["J1", "J-TEAMS"];

export const LAUNCH_SURFACE_FLOOR: readonly string[] = ["J-GH", "J-ENGAGED-github", "J-NOT", "J-ENGAGED-notion"];

export const SPEND_CAP_FLOOR: readonly string[] = ["S10"];

export const ALWAYS_RELEVANT: readonly string[] = [...SMOKE_FLOOR, ...LAUNCH_SURFACE_FLOOR, ...SPEND_CAP_FLOOR];

export const UNMAPPED_BY_DESIGN: readonly { id: string; why: string }[] = [];

export function changedAreaScenarios(changedPaths: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const path of changedPaths) {
    for (const area of CHANGED_RELEVANT_MAP) {
      if (area.globs.some((g) => pathMatchesGlob(path, g))) {
        for (const id of area.scenarios) ids.add(id);
      }
    }
  }
  return [...ids];
}

export function relevantScenarios(changedPaths: readonly string[]): string[] {
  return [...new Set<string>([...ALWAYS_RELEVANT, ...changedAreaScenarios(changedPaths)])];
}
