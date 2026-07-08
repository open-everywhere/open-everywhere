import { defineSchedule } from "eve/schedules";
import { getConfig } from "../access/config.js";
import { readAudit, appendAudit } from "../audit/audit.js";
import { DREAM_ACTOR } from "../memory/dream/proposal.js";
import { buildMode3Report, formatMode3Report, type Mode3Report } from "../memory/dream/mode3.js";
import { slackForm } from "../channels/slack-events.js";
import { tidyOrgs } from "./tidy.js";

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

export async function mode3Tick(
  opts: { readonly now?: Date; readonly orgs?: readonly string[]; readonly post?: Mode3Poster } = {},
): Promise<Mode3TickReport> {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - WEEK_MS);
  const orgs = opts.orgs ?? tidyOrgs();
  const post = opts.post ?? slackForm;
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
      report = await buildMode3Report(org, rows, windowStart.toISOString(), now.toISOString());
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
      const body = new URLSearchParams();
      body.set("channel", channel);
      body.set("text", formatMode3Report(report));
      const res = await post("chat.postMessage", body.toString());
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
