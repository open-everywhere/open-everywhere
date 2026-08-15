import { defineSchedule } from "eve/schedules";
import { getConfig } from "../access/config.js";
import { readAudit, appendAudit } from "../audit/audit.js";
import { DREAM_ACTOR } from "../memory/dream/proposal.js";
import { buildMode3Report, formatMode3Report, isFailureAction, type Mode3Report } from "../memory/dream/mode3.js";
import type { AuditEntry } from "../operational/store.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { tidyOrgs } from "./tidy.js";
import { postOnce, outboundKey } from "../operational/post-once.js";

function log(msg: string): void {
  console.log(`[open-everywhere:dream/mode3] ${msg}`);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type Mode3Poster = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export interface Mode3TickReport {
  readonly orgs: number;
  readonly reports: number;
  readonly posted: number;
}

function adminChannel(): string | undefined {
  try {
    return getConfig().loadAccessRequests?.()?.adminChannel ?? undefined;
  } catch {
    return undefined;
  }
}

const MAX_NAME_LOOKUPS = 12;

async function slackSurfaceNames(rows: readonly AuditEntry[], post: Mode3Poster): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!isFailureAction(row.action)) continue;
    if (row.platform !== "slack" || !row.surface || !/^[CG]/.test(row.surface)) continue;
    ids.add(row.surface);
    if (ids.size >= MAX_NAME_LOOKUPS) break;
  }
  const names = new Map<string, string>();
  for (const id of ids) {
    try {
      const json = await post("conversations.info", new URLSearchParams({ channel: id }).toString());
      const channel = json?.ok === true ? (json.channel as Record<string, unknown> | undefined) : undefined;
      if (channel && typeof channel.name === "string" && channel.name.length > 0) names.set(id, `#${channel.name}`);
    } catch {
    }
  }
  return names;
}

export async function mode3Tick(
  opts: { readonly now?: Date; readonly orgs?: readonly string[]; readonly post?: Mode3Poster } = {},
): Promise<Mode3TickReport> {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - WEEK_MS);
  const orgs = opts.orgs ?? tidyOrgs();
  const post = opts.post ?? bridgeSlackForm;
  const channel = adminChannel();

  let reports = 0;
  let posted = 0;

  for (const org of orgs) {
    let rows;
    try {
      rows = await readAudit({ org, since: windowStart.toISOString(), limit: 2000 });
    } catch (err) {
      log(`skip ${org} — audit read failed: ${String(err)}`);
      continue;
    }

    let report: Mode3Report | null;
    try {
      const names = channel ? await slackSurfaceNames(rows, post) : new Map<string, string>();
      report = await buildMode3Report(org, rows, windowStart.toISOString(), now.toISOString(), {
        surfaceName: (r) => (r.platform === "slack" && r.surface ? names.get(r.surface) : undefined),
      });
    } catch (err) {
      log(`skip ${org} — report build failed: ${String(err)}`);
      continue;
    }
    if (!report) continue;

    reports++;
    await appendAudit({
      org,
      platform: "dream",
      workspace: "mode3",
      principalId: DREAM_ACTOR,
      action: "dream.mode3_report",
      detail: {
        totalFailures: report.totalFailures,
        clusters: report.clusters.map((c) => ({ action: c.action, count: c.count, label: c.label, judged: c.judged })),
      },
    });

    if (!channel) {
      log(`org ${org}: digest built (${report.totalFailures} failure event(s)) but no admin channel configured — skipped post`);
      continue;
    }
    try {
      const text = formatMode3Report(report);
      const res = await postOnce({
        org,
        key: outboundKey({ surface: "dream", channel, action: "dream.mode3-digest", payload: text }),
        run: async () => {
          const body = new URLSearchParams();
          body.set("channel", channel);
          body.set("text", text);
          return await post("chat.postMessage", body.toString());
        },
      });
      if (res?.ok === true) posted++;
      else log(`org ${org}: admin-channel post did not confirm ok (${JSON.stringify(res)})`);
    } catch (err) {
      log(`org ${org}: admin-channel post failed — ${String(err)}`);
    }
  }

  log(`tick: ${orgs.length} org(s) swept — ${reports} digest(s) built, ${posted} posted`);
  return { orgs: orgs.length, reports, posted };
}

export default defineSchedule({
  cron: "0 5 * * 1",
  async run() {
    await mode3Tick();
  },
});
