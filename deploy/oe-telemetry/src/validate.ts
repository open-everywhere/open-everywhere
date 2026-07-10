import { z } from "zod";
import { EVENT_SCHEMA, RESOURCE_ATTR_KEYS } from "./schema.js";

export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_RECORDS_PER_BATCH = 100;

export function isBodySizeOk(byteLength: number): boolean {
  return byteLength >= 0 && byteLength <= MAX_BODY_BYTES;
}

const AttributeValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ stringValue: z.string() }).strict(),
    z.object({ intValue: z.string().regex(/^-?\d+$/, "intValue must be a decimal-string int64") }).strict(),
    z.object({ doubleValue: z.number() }).strict(),
    z.object({ boolValue: z.boolean() }).strict(),
    z.object({ arrayValue: z.object({ values: z.array(AttributeValueSchema) }).strict() }).strict(),
  ]),
);

const KeyValueSchema = z
  .object({
    key: z.string().min(1),
    value: AttributeValueSchema,
  })
  .strict();

const LogRecordSchema = z
  .object({
    timeUnixNano: z.string().regex(/^\d+$/, "timeUnixNano must be a decimal-string int64"),
    eventName: z.string().min(1),
    attributes: z.array(KeyValueSchema).default([]),
  })
  .strict();

const ScopeLogsSchema = z
  .object({
    scope: z.object({ name: z.string() }).strict(),
    logRecords: z.array(LogRecordSchema).min(1),
  })
  .strict();

const ResourceLogsSchema = z
  .object({
    resource: z.object({ attributes: z.array(KeyValueSchema).default([]) }).strict(),
    scopeLogs: z.array(ScopeLogsSchema).min(1),
  })
  .strict();

const EnvelopeSchema = z
  .object({
    resourceLogs: z.array(ResourceLogsSchema).min(1),
  })
  .strict();

export type FlatAttrValue = string | number | boolean | string[];

function flattenAttrValue(v: unknown): FlatAttrValue {
  const value = v as Record<string, unknown>;
  if ("stringValue" in value) return value.stringValue as string;
  if ("intValue" in value) return Number(value.intValue as string);
  if ("doubleValue" in value) return value.doubleValue as number;
  if ("boolValue" in value) return value.boolValue as boolean;
  if ("arrayValue" in value) {
    const arr = (value.arrayValue as { values: unknown[] }).values;
    return arr.map((entry) => String(flattenAttrValue(entry)));
  }
  return "";
}

function flattenAttrs(pairs: { key: string; value: unknown }[]): Record<string, FlatAttrValue> {
  const out: Record<string, FlatAttrValue> = {};
  for (const { key, value } of pairs) out[key] = flattenAttrValue(value);
  return out;
}

export interface ExtractedRecord {
  readonly eventName: string;
  readonly attributes: Readonly<Record<string, FlatAttrValue>>;
  readonly timeUnixNano: string;
}

export interface ValidatedEnvelope {
  readonly instanceId: string;
  readonly resource: Readonly<Record<string, FlatAttrValue>>;
  readonly records: readonly ExtractedRecord[];
  readonly droppedRecords: number;
  readonly strippedKeys: number;
}

export type ValidationResult = { readonly ok: true; readonly envelope: ValidatedEnvelope } | { readonly ok: false; readonly reason: string };

export function validateOtlpLogsJson(json: unknown): ValidationResult {
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `schema validation failed: ${parsed.error.issues[0]?.message ?? "invalid shape"}` };

  let rawRecordCount = 0;
  for (const resourceLogs of parsed.data.resourceLogs) {
    for (const scopeLogs of resourceLogs.scopeLogs) rawRecordCount += scopeLogs.logRecords.length;
  }
  if (rawRecordCount > MAX_RECORDS_PER_BATCH) {
    return { ok: false, reason: `batch exceeds ${MAX_RECORDS_PER_BATCH} records (got ${rawRecordCount})` };
  }

  const records: ExtractedRecord[] = [];
  let resource: Record<string, FlatAttrValue> = {};
  let droppedRecords = 0;
  let strippedKeys = 0;

  for (const resourceLogs of parsed.data.resourceLogs) {
    const flatResource = flattenAttrs(resourceLogs.resource.attributes);
    for (const key of Object.keys(flatResource)) {
      if (!RESOURCE_ATTR_KEYS.includes(key)) {
        delete flatResource[key];
        strippedKeys++;
      }
    }
    resource = { ...resource, ...flatResource };

    for (const scopeLogs of resourceLogs.scopeLogs) {
      for (const logRecord of scopeLogs.logRecords) {
        const allowed = EVENT_SCHEMA[logRecord.eventName];
        if (!allowed) {
          droppedRecords++;
          continue;
        }

        const flatAttrs = flattenAttrs(logRecord.attributes);
        for (const key of Object.keys(flatAttrs)) {
          if (!allowed.includes(key)) {
            delete flatAttrs[key];
            strippedKeys++;
          }
        }

        records.push({ eventName: logRecord.eventName, attributes: flatAttrs, timeUnixNano: logRecord.timeUnixNano });
      }
    }
  }

  const instanceId = typeof resource["service.instance.id"] === "string" ? (resource["service.instance.id"] as string) : "unknown";
  return { ok: true, envelope: { instanceId, resource, records, droppedRecords, strippedKeys } };
}
