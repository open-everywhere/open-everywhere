import type { ProviderEventDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const SLACK_PROVIDER_EVENTS: ProviderEventDeclaration = {
  doc: "https://docs.slack.dev/reference/events",
  events: [
    {
      event: "message",
      routing: "none",
      match: [],
      scope: [],
      note: "a message was posted in a channel; the ambient supervisor already judges these, so a routine on it would wake a seat twice",
    },
    {
      event: "app_mention",
      routing: "none",
      match: [],
      scope: [],
      note: "the app was @mentioned; the mention leg owns it and wakes a full turn already",
    },
    {
      event: "reaction_added",
      routing: "none",
      match: [],
      scope: [],
      note: "somebody reacted to a message; the reaction-feedback plane reads it, and a routine could not tell its own ack glyphs from a person's",
    },
    {
      event: "reaction_removed",
      routing: "none",
      match: [],
      scope: [],
      note: "a reaction was taken off a message; unwired for the same reason as `reaction_added`",
    },
    {
      event: "channel_created",
      routing: "none",
      match: [],
      scope: [],
      note: "a channel was created — the clearest candidate for a routine trigger here, and nothing routes it today",
    },
    {
      event: "member_joined_channel",
      routing: "none",
      match: [],
      scope: [],
      note: "somebody joined a channel; unwired — an onboarding routine would want this one",
    },
    {
      event: "team_join",
      routing: "none",
      match: [],
      scope: [],
      note: "a new member joined the workspace; unwired",
    },
    {
      event: "file_shared",
      routing: "none",
      match: [],
      scope: [],
      note: "a file was shared; unwired — the attachment plane reads files on a turn it was already woken for",
    },
    {
      event: "app_home_opened",
      routing: "none",
      match: [],
      scope: [],
      note: "a user opened the app's home tab; unwired, and a poor routine trigger — it fires on a view, not on work",
    },
  ],
};
