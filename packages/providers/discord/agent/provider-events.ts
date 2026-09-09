import type { ProviderEventDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

export const DISCORD_PROVIDER_EVENTS: ProviderEventDeclaration = {
  doc: "https://discord.com/developers/docs/events/gateway-events",
  events: [
    {
      event: "MESSAGE_CREATE",
      routing: "none",
      match: [],
      scope: [],
      note: "a message was sent in a channel; the bundle's own gateway transport reads it for the mention and ambient legs, never the routine plane",
    },
    {
      event: "MESSAGE_UPDATE",
      routing: "none",
      match: [],
      scope: [],
      note: "a message was edited; unwired",
    },
    {
      event: "MESSAGE_DELETE",
      routing: "none",
      match: [],
      scope: [],
      note: "a message was deleted; unwired",
    },
    {
      event: "MESSAGE_REACTION_ADD",
      routing: "none",
      match: [],
      scope: [],
      note: "somebody reacted to a message; the reaction-feedback plane reads it, and a routine could not tell its own ack glyphs from a person's",
    },
    {
      event: "MESSAGE_REACTION_REMOVE",
      routing: "none",
      match: [],
      scope: [],
      note: "a reaction was taken off a message; unwired for the same reason as `MESSAGE_REACTION_ADD`",
    },
    {
      event: "THREAD_CREATE",
      routing: "none",
      match: [],
      scope: [],
      note: "a thread was started; unwired — a candidate trigger, since a new thread is work appearing rather than chatter",
    },
    {
      event: "GUILD_MEMBER_ADD",
      routing: "none",
      match: [],
      scope: [],
      note: "somebody joined the guild; unwired — an onboarding routine would want this one",
    },
    {
      event: "INTERACTION_CREATE",
      routing: "none",
      match: [],
      scope: [],
      note: "a slash command or component interaction; unwired, and a poor routine trigger — an interaction owes Discord a reply within three seconds, which a fired seat cannot promise",
    },
  ],
};
