import type { ProviderEventDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const LINEAR_PROVIDER_EVENTS: ProviderEventDeclaration = {
  source: "linear",
  doc: "https://linear.app/developers/webhooks",
  events: [
    {
      event: "Issue",
      routing: "mapped",
      match: ["team", "project", "issue"],
      scope: ["group", "container", "entity"],
      note: "an issue was created, updated or removed — the one routable Linear type; the container step is the issue's project and appears only when it has one",
    },
    {
      event: "Comment",
      routing: "none",
      match: [],
      scope: [],
      note: "a comment on an issue; declined by the normalizer on purpose — a comment is CONVERSATION and the ambient supervisor answers it, so routing it would wake a seat twice for one event",
    },
    {
      event: "Reaction",
      routing: "none",
      match: [],
      scope: [],
      note: "an emoji reaction on a comment; unrecognised by the normalizer — the reaction-feedback plane reads reactions, not a routine",
    },
    {
      event: "IssueLabel",
      routing: "none",
      match: [],
      scope: [],
      note: "a label was created, renamed or deleted in the workspace; unrecognised — a label CHANGE on an issue arrives as an `Issue` update, which is routable",
    },
    {
      event: "Project",
      routing: "none",
      match: [],
      scope: [],
      note: "a project was created, updated or removed; unrecognised — a routine that wants project movement watches the `Issue` events inside it today",
    },
    {
      event: "Cycle",
      routing: "none",
      match: [],
      scope: [],
      note: "a cycle was created, updated or removed; unrecognised — no normalizer arm reads it",
    },
    {
      event: "AgentSessionEvent",
      routing: "none",
      match: [],
      scope: [],
      note: "Linear's own agent-session protocol; classified `agent-session` and handled by the session leg, never by the routine plane",
    },
  ],
};
