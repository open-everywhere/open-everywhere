export const EVENT_SCHEMA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "oe.instance.first_boot": Object.freeze([]),
  "oe.instance.heartbeat": Object.freeze([
    "oe.surfaces",
    "oe.memory_provider",
    "oe.operational_provider",
    "oe.model.primary",
    "oe.model.utility",
    "oe.domains.bucket",
    "oe.telemetry.dropped",
  ]),
  "oe.turn.completed": Object.freeze([
    "oe.surface",
    "oe.kind",
    "gen_ai.request.model",
    "oe.tokens.bucket",
    "oe.steps.bucket",
    "oe.latency.bucket",
  ]),
  "oe.turn.failed": Object.freeze(["oe.surface", "oe.error.code"]),
  "oe.error.uncaught": Object.freeze(["oe.component", "oe.error.name"]),
  "oe.feature.used": Object.freeze(["oe.feature", "oe.outcome"]),
  "oe.reaction.added": Object.freeze(["oe.surface", "oe.on_bot_reply", "oe.emoji_class"]),
  "oe.reaction.removed": Object.freeze(["oe.surface", "oe.on_bot_reply", "oe.emoji_class"]),
  "wizard.started": Object.freeze(["oe.wizard.version", "oe.wizard.platform"]),
  "wizard.completed": Object.freeze(["oe.wizard.version", "oe.wizard.platform", "oe.wizard.steps_completed"]),
});

export const RESOURCE_ATTR_KEYS: readonly string[] = Object.freeze([
  "service.name",
  "service.version",
  "service.instance.id",
  "deployment.environment.name",
  "oe.host",
  "oe.node.major",
  "oe.instance.ephemeral",
]);

export const HEARTBEAT_EVENT_NAME = "oe.instance.heartbeat";
