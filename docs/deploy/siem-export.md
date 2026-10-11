# SIEM export: stream the audit log to your SIEM

Open Everywhere can stream every audit row to a SIEM (OPE-2437). You configure the export in Git,
the deployment sends the rows on a schedule, and each row carries the hash-chain fields, so your SIEM
can verify the chain without access to the deployment's database.

This page names the formats, the delivery contract and the chain recipe, and gives one worked example.
For what the audit log records, see [Audit & provenance](../security/audit-and-provenance.md).

## Configure it

The export is a setting, `auditExport.targets`, in your deployment's `agent/settings/settings.ts`. It
is config in Git, not an environment variable: where the audit trail goes is a reviewed decision, and
a change to it is a pull request.

```ts
// agent/settings/settings.ts
export const SETTINGS_OVERRIDES = defineSettings({
  auditExport: {
    targets: [
      {
        name: "splunk", // keys this target's delivery cursor — do not rename it casually
        format: "splunk-hec",
        url: "https://splunk.example.com:8088/services/collector/event",
        tokenSecret: "SPLUNK_HEC_TOKEN", // a secret NAME, never the value
      },
    ],
  },
});
```

Then store the token in the deployment's secret store. The export reads the token from that store
only: it never falls back to an environment variable of the same name, so a line in Git cannot send
an infrastructure secret such as `DATABASE_URL` to the SIEM.

```bash
oe secret set SPLUNK_HEC_TOKEN   # reads the value on stdin
```

| Field | Meaning |
|---|---|
| `name` | A stable id, `[a-z0-9-]`, unique across targets. It keys the target's delivery cursor, so a rename sends the whole log again from the start. |
| `format` | `"otlp"`, `"json"` or `"splunk-hec"` — see [Formats](#formats). |
| `url` | The full ingest URL. It must use `https:`. An `http:` URL is accepted only for a loopback collector (`localhost`, `127.0.0.1`, `[::1]`). A URL with a user name or password in it is refused. |
| `tokenSecret` | The NAME of the secret-store entry that holds the token, in env style (`A-Z`, `0-9`, `_`, for example `SPLUNK_HEC_TOKEN`). Absent: the POST carries no auth header. The grammar refuses the common token shapes (a UUID, lowercase hex, a `Bearer …` string), but it cannot recognise every token: write a name here, never a value. |
| `tokenHeader` | The header the token goes in. Default `authorization`. |
| `tokenScheme` | The word before the token. Default `Splunk` for `splunk-hec`, else `Bearer`. `""` sends the bare token (for example, `tokenHeader: "DD-API-KEY", tokenScheme: ""` for Datadog). |
| `orgs` | Send only these orgs' rows. Absent or empty: every org in the audit log. |

A bad entry fails the boot with a message that names the field. You can declare several targets; each
keeps its own cursor and its own failures.

## Delivery

The `audit-export` schedule runs every five minutes. For each target and each org, it reads the rows
after the target's cursor, oldest first, in pages of 200, and POSTs each page.

- **At least once.** The cursor moves only after the receiver answers 2xx. Any other answer, a timeout
  or a network error leaves the cursor where it was, and the next run sends the same rows again. So
  your SIEM can receive a row twice. Deduplicate on `(org, seq)`, or on `sha`.
- **The cursor** is the `seq` of the last row the receiver acknowledged. It lives in the deployment's
  `instance_meta` table, under `audit.export.cursor.v1:<target>:<org>`.
- **The settle window.** A row leaves only when it is at least 30 seconds old. On Postgres, two
  concurrent appends can commit out of `seq` order; the window lets every lower `seq` commit before
  the cursor passes it. The remaining risk is an append whose commit lags its own insert by more than
  30 seconds.
- **Lag.** With the five-minute tick and the 30-second window, a row reaches the SIEM about five and a
  half minutes after it is written in the steady state. A backlog drains at up to 2,000 rows per
  target and org per run.
- **Failure is visible, not fatal.** A failed POST logs one `[open-everywhere:audit-export]` line with
  the target, the org and the HTTP status. The line never carries a response body or the token
  value. It does name `tokenSecret`, which is one more reason that field must hold a name.

## What a record carries

Every format carries the same record, one per audit row:

```json
{
  "schema": "oe.audit.v1",
  "service": "open-everywhere",
  "seq": 4182,
  "org": "acme",
  "ts": "2026-02-07T03:40:00.000Z",
  "platform": "slack",
  "workspace": "T0AB1CD2E",
  "surface": "C0123ABCD",
  "surfaceMode": "channel",
  "principalId": "U0EXUSER002",
  "action": "connector.op",
  "detail": { "connection": "linear", "op": "create_issue", "tier": "gate:member", "opTier": "write" },
  "prevSha": "5f1c…e90a",
  "sha": "a37d…11c4"
}
```

`surface`, `surfaceMode`, `principalId` and `detail` are absent when the row has none. `detail` is sent
in full, so the SIEM holds what an org admin can read on the control plane. Treat the SIEM's access
control accordingly.

## Formats

| `format` | Body | Use it for |
|---|---|---|
| `json` | One JSON array of records per POST, `content-type: application/json`. | Datadog Logs intake, Microsoft Sentinel's Logs Ingestion API, any HTTPS intake that takes a JSON array. |
| `splunk-hec` | One HEC event envelope per record, separated by newlines: `{"time": <epoch seconds>, "host": <workspace>, "source": "open-everywhere", "sourcetype": "oe:audit", "event": <record>}`. | Splunk HTTP Event Collector (`/services/collector/event`). |
| `otlp` | An OTLP/HTTP JSON `ExportLogsServiceRequest`: one log record per row, `timeUnixNano` from `ts`, `severityText: "INFO"`, the whole record as the `body` string, and the common fields as attributes (`oe.audit.seq`, `oe.org`, `oe.audit.action`, `oe.platform`, `oe.workspace`, `oe.surface`, `oe.surface_mode`, `oe.principal_id`, `oe.audit.prev_sha`, `oe.audit.sha`, `oe.audit.detail`). The resource carries `service.name = open-everywhere`. | An OpenTelemetry Collector (`/v1/logs`), or any OTLP logs endpoint. |

## Verify the chain in the SIEM

Each record carries `prevSha` (the stored link to the previous row of the same org) and `sha` (this
row's own digest, recomputed at export). A receiver checks two things:

1. **The row is intact.** Recompute `sha` from the record:
   `sha256(JSON.stringify(fields))`, as lowercase hex, where `fields` is the array
   `[prevSha, org, ts, platform, workspace, surface ?? null, principalId ?? null, action, detailCanonical]`,
   with `surfaceMode` appended as a tenth element **only when the record has one**. `detailCanonical`
   is `null` when the record has no `detail`, and otherwise the JSON string of `detail` with object keys
   sorted at every level (arrays keep their order).
2. **The chain is unbroken.** For each org, in `seq` order, a record's `prevSha` equals the previous
   record's `sha`. Three kinds of row legitimately carry `prevSha: null` and start a new run of links:
   the org's first row, a row written before the chain existed, and an `audit.chain_epoch` marker row
   that seals the era before it (see [Audit & provenance](../security/audit-and-provenance.md)). A
   receiver reports a mid-chain `null` as a break unless it is one of these, and the third names itself
   by its `action`. One more `null` is a real break, and the deployment's own verifier reports it too:
   an `audit.integrity` row the store could not chain-link, which it writes unchained rather than lose.

A gap in `seq` between two records of one org is not by itself a break: `seq` is shared by every org in
the table. The `prevSha` link is the evidence.

🔴 What this proves, and what it does not. The chain is an unkeyed sha256, so it is evidence against an
accident or a careless edit, not against a determined one:

- A receiver detects an edit or a deletion in the MIDDLE of its copy — unless whoever made it also
  recomputed every later `sha` and `prevSha`, which anyone can do.
- Deleting the NEWEST rows breaks no link at all.
- A change on either side AFTER export shows only when you compare the SIEM's copy with the
  deployment's own log (for example, the `sha` of the same `(org, seq)` in both).
- The chain does not authenticate the deployment that sent the rows, and it says nothing about a row
  that was changed before it was exported.

## Worked example: an OpenTelemetry Collector into any backend

1. Run a collector with an OTLP/HTTP receiver, and send its logs pipeline to your backend:

   ```yaml
   # otel-collector.yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318
           auth: { authenticator: bearertokenauth }
   extensions:
     bearertokenauth:
       token: ${env:OE_AUDIT_INGEST_TOKEN}
   exporters:
     debug: {}
   service:
     extensions: [bearertokenauth]
     pipelines:
       logs: { receivers: [otlp], exporters: [debug] }
   ```

2. Add the target in `agent/settings/settings.ts` and open a pull request:

   ```ts
   auditExport: {
     targets: [{ name: "otel", format: "otlp", url: "https://otel.example.com/v1/logs", tokenSecret: "OTEL_AUDIT_TOKEN" }],
   },
   ```

3. Store the token the collector expects: `oe secret set OTEL_AUDIT_TOKEN`.
4. Deploy. Within about five minutes the collector logs one record per audit row, each with
   `oe.audit.seq` and `oe.audit.sha` attributes. The deployment logs a
   `[open-everywhere:audit-export] target "otel" org "<org>": sent <n>, cursor <seq>` line for each run
   that sends rows.

## How this compares

OpenBot exports each audit row over OTLP. Open Everywhere exports the same rows over OTLP, as a JSON
array or as Splunk HEC events, at least once with a durable cursor, and each row carries the hash-chain
link and its digest, so the SIEM can check the chain on its own copy within the limits above.
