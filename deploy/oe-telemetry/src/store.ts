import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { ExtractedRecord, FlatAttrValue } from "./validate.js";

export interface EventRow {
  readonly instanceId: string;
  readonly resource: Readonly<Record<string, FlatAttrValue>>;
  readonly record: ExtractedRecord;
}

export async function insertEvents(sqlFn: NeonQueryFunction<false, false>, rows: readonly EventRow[]): Promise<void> {
  for (const row of rows) {
    await sqlFn`
      INSERT INTO events (instance_id, event_name, event_time_unix_nano, attributes, resource)
      VALUES (
        ${row.instanceId},
        ${row.record.eventName},
        ${row.record.timeUnixNano},
        ${JSON.stringify(row.record.attributes)}::jsonb,
        ${JSON.stringify(row.resource)}::jsonb
      )
    `;
  }
}
