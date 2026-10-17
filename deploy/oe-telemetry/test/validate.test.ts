import assert from "node:assert/strict";
import { isBodySizeOk, validateOtlpLogsJson, MAX_BODY_BYTES, MAX_RECORDS_PER_BATCH } from "../src/validate.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function kv(key: string, value: unknown): { key: string; value: unknown } {
  return { key, value };
}

function makeEnvelope(logRecords: unknown[], resourceAttrs: { key: string; value: unknown }[] = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs.length > 0 ? resourceAttrs : [kv("service.name", { stringValue: "open-everywhere" })] },
        scopeLogs: [{ scope: { name: "open-everywhere-telemetry" }, logRecords }],
      },
    ],
  };
}

{
  const envelope = makeEnvelope(
    [
      {
        timeUnixNano: "1783430400000000000",
        eventName: "oe.turn.completed",
        attributes: [
          kv("oe.surface", { stringValue: "slack" }),
          kv("oe.kind", { stringValue: "channel" }),
          kv("gen_ai.request.model", { stringValue: "openai/gpt-6-luna" }),
          kv("oe.tokens.bucket", { stringValue: "10-100k" }),
          kv("oe.steps.bucket", { stringValue: "2-5" }),
          kv("oe.latency.bucket", { stringValue: "5-15s" }),
        ],
      },
    ],
    [
      kv("service.name", { stringValue: "open-everywhere" }),
      kv("service.version", { stringValue: "0.4.0" }),
      kv("service.instance.id", { stringValue: "b3f1c2a0-6e9d-4a7a-8b2e-1e9f9a2d4c11" }),
      kv("deployment.environment.name", { stringValue: "production" }),
      kv("oe.host", { stringValue: "vercel" }),
      kv("oe.node.major", { intValue: "24" }),
    ],
  );
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "valid envelope (the exact docs/deploy/telemetry.md example) is accepted");
  if (result.ok) {
    ok(result.envelope.instanceId === "b3f1c2a0-6e9d-4a7a-8b2e-1e9f9a2d4c11", "instance id extracted from resource attrs");
    ok(result.envelope.records.length === 1, "one record extracted");
    ok(result.envelope.records[0].attributes["oe.surface"] === "slack", "attribute flattened to a plain scalar");
  }
}

{
  const envelope = makeEnvelope([
    {
      timeUnixNano: "1783430400000000000",
      eventName: "oe.instance.heartbeat",
      attributes: [
        kv("oe.surfaces", { arrayValue: { values: [{ stringValue: "slack" }, { stringValue: "webhooks" }] } }),
        kv("oe.memory_provider", { stringValue: "sqlite" }),
        kv("oe.operational_provider", { stringValue: "sqlite" }),
        kv("oe.model.primary", { stringValue: "openai/gpt-6-luna" }),
        kv("oe.model.utility", { stringValue: "deepseek/deepseek-v4-flash" }),
        kv("oe.domains.bucket", { stringValue: "1" }),
        kv("oe.telemetry.dropped", { intValue: "0" }),
      ],
    },
  ]);
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "heartbeat with an array attribute is accepted");
  if (result.ok) {
    const surfaces = result.envelope.records[0].attributes["oe.surfaces"];
    ok(Array.isArray(surfaces) && surfaces.length === 2, "arrayValue flattened to a string[]");
  }
}

{
  const envelope = makeEnvelope([{ timeUnixNano: "1", eventName: "oe.instance.first_boot", attributes: [] }]);
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "first_boot with zero attributes (its allow-list) is accepted");
}

{
  const envelope = makeEnvelope([{ timeUnixNano: "1", eventName: "oe.totally.made_up", attributes: [] }]);
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "an all-unknown-event batch is accepted at transport level (not a 400)");
  if (result.ok) {
    ok(result.envelope.records.length === 0, "the unknown-event record is filtered out, so nothing is stored");
    ok(result.envelope.droppedRecords === 1, "the dropped-record count reflects the one unknown event");
  }
}

{
  const envelope = makeEnvelope([
    {
      timeUnixNano: "1",
      eventName: "oe.turn.completed",
      attributes: [kv("oe.surface", { stringValue: "slack" }), kv("oe.kind", { stringValue: "channel" })],
    },
    { timeUnixNano: "2", eventName: "oe.some.future.event", attributes: [kv("oe.new", { stringValue: "x" })] },
  ]);
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "a batch mixing a known and an unknown event is accepted");
  if (result.ok) {
    ok(result.envelope.records.length === 1, "the good (known) record survives");
    ok(result.envelope.records[0].eventName === "oe.turn.completed", "the surviving record is the known turn event");
    ok(result.envelope.droppedRecords === 1, "the unknown co-batched event was dropped, not stored");
  }
}

{
  const envelope = makeEnvelope([
    {
      timeUnixNano: "1",
      eventName: "oe.reaction.added",
      attributes: [kv("oe.surface", { stringValue: "slack" }), kv("oe.on_bot_reply", { boolValue: true }), kv("oe.emoji_class", { stringValue: "positive" })],
    },
    {
      timeUnixNano: "2",
      eventName: "wizard.completed",
      attributes: [
        kv("oe.wizard.version", { stringValue: "1" }),
        kv("oe.wizard.platform", { stringValue: "slack" }),
        kv("oe.wizard.steps_completed", { stringValue: "6+" }),
      ],
    },
  ]);
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "reaction + wizard events (previously 400-rejected) are now accepted");
  if (result.ok) {
    ok(result.envelope.records.length === 2, "both newly-mirrored events are stored");
    ok(result.envelope.droppedRecords === 0 && result.envelope.strippedKeys === 0, "nothing filtered — they are in the contract now");
  }
}

{
  const envelope = makeEnvelope([
    {
      timeUnixNano: "1",
      eventName: "oe.turn.failed",
      attributes: [kv("oe.surface", { stringValue: "slack" }), kv("oe.error.message", { stringValue: "leaked secret detail" })],
    },
  ]);
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "a record with an out-of-vocabulary attribute is still accepted (batch not poisoned)");
  if (result.ok) {
    ok(result.envelope.records.length === 1, "the record is kept");
    const attrs = result.envelope.records[0].attributes;
    ok(!("oe.error.message" in attrs), "the out-of-contract attribute (a potential leak) is stripped, never stored");
    ok(attrs["oe.surface"] === "slack", "the in-contract attribute is preserved");
    ok(result.envelope.strippedKeys === 1, "the stripped-key count reflects the one dropped attribute");
  }
}

{
  const envelope = makeEnvelope(
    [{ timeUnixNano: "1", eventName: "oe.instance.first_boot", attributes: [] }],
    [kv("service.name", { stringValue: "open-everywhere" }), kv("host.ip", { stringValue: "10.0.0.1" })],
  );
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, "an unknown (identifying) resource attribute does not reject the batch");
  if (result.ok) {
    ok(!("host.ip" in result.envelope.resource), "the identifying host.ip resource attribute is stripped, never stored");
    ok(result.envelope.resource["service.name"] === "open-everywhere", "in-contract resource attributes are preserved");
    ok(result.envelope.records.length === 1, "the record still stores");
    ok(result.envelope.strippedKeys === 1, "the stripped-key count reflects the dropped resource attribute");
  }
}

{
  const badShape = { resource_logs: [] };
  const result = validateOtlpLogsJson(badShape);
  ok(!result.ok, "malformed/mismatched envelope shape is rejected by the strict zod parse");
}

{
  const logRecords = Array.from({ length: MAX_RECORDS_PER_BATCH + 1 }, () => ({
    timeUnixNano: "1",
    eventName: "oe.instance.first_boot",
    attributes: [],
  }));
  const envelope = makeEnvelope(logRecords);
  const result = validateOtlpLogsJson(envelope);
  ok(!result.ok, `a batch of ${MAX_RECORDS_PER_BATCH + 1} records (over the ${MAX_RECORDS_PER_BATCH} cap) is rejected`);
}

{
  const logRecords = Array.from({ length: MAX_RECORDS_PER_BATCH }, () => ({
    timeUnixNano: "1",
    eventName: "oe.instance.first_boot",
    attributes: [],
  }));
  const envelope = makeEnvelope(logRecords);
  const result = validateOtlpLogsJson(envelope);
  ok(result.ok, `a batch of exactly ${MAX_RECORDS_PER_BATCH} records is accepted (boundary)`);
}

{
  ok(isBodySizeOk(0), "an empty body is within the size cap");
  ok(isBodySizeOk(MAX_BODY_BYTES), "exactly the cap is within the size cap (boundary)");
  ok(!isBodySizeOk(MAX_BODY_BYTES + 1), "one byte over the 32KB cap is rejected");
}

console.log(`validate.test.ts: ${n} assertions passed`);
