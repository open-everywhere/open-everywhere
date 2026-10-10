import { defineSchedule } from "eve/schedules";
import { getConfig } from "../access/config.js";
import { readAudit, appendAudit } from "../audit/audit.js";
import { DREAM_ACTOR } from "../memory/dream/proposal.js";
import { buildMode3Report, formatMode3Report, isFailureAction, type Mode3Report } from "../memory/dream/mode3.js";
import { clusterFailures } from "../memory/dream/mode3-cluster.js";
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

function errBrief(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split("\n")[0].slice(0, 160);
}

interface OrgDigestOutcome {
  readonly outcome: string;
  readonly totalFailures?: number;
  readonly reported: boolean;
  readonly posted: boolean;
}

async function runOrgDigest(input: {
  readonly org: string;
  readonly now: Date;
  readonly windowStart: Date;
  readonly post: Mode3Poster;
  readonly channel: string | undefined;
}): Promise<OrgDigestOutcome> {
  const { org, now, windowStart, post, channel } = input;

  let rows;
  try {
    rows = await readAudit({ org, since: windowStart.toISOString(), limit: 2000 });
  } catch (err) {
    log(`skip ${org} — audit read failed: ${String(err)}`);
    return { outcome: `failed: audit read — ${errBrief(err)}`, reported: false, posted: false };
  }

  let report: Mode3Report | null;
  try {
    const names = channel ? await slackSurfaceNames(rows, post) : new Map<string, string>();
    report = await buildMode3Report(org, rows, windowStart.toISOString(), now.toISOString(), {
      cluster: clusterFailures,
      surfaceName: (r) => (r.platform === "slack" && r.surface ? names.get(r.surface) : undefined),
    });
  } catch (err) {
    log(`skip ${org} — report build failed: ${String(err)}`);
    return { outcome: `failed: report build — ${errBrief(err)}`, reported: false, posted: false };
  }
  if (!report) return { outcome: "no-op: empty week", reported: false, posted: false };

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
    return { outcome: "reported: no admin channel configured — skipped post", totalFailures: report.totalFailures, reported: true, posted: false };
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
    if (res?.ok === true) return { outcome: "reported: posted", totalFailures: report.totalFailures, reported: true, posted: true };
    log(`org ${org}: admin-channel post did not confirm ok (${JSON.stringify(res)})`);
    return { outcome: "reported: post did not confirm ok", totalFailures: report.totalFailures, reported: true, posted: false };
  } catch (err) {
    log(`org ${org}: admin-channel post failed — ${String(err)}`);
    return { outcome: `reported: post failed — ${errBrief(err)}`, totalFailures: report.totalFailures, reported: true, posted: false };
  }
}

export async function mode3Tick(
  opts: {
    readonly now?: Date;
    readonly orgs?: readonly string[];
    readonly post?: Mode3Poster;
  } = {},
): Promise<Mode3TickReport> {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - WEEK_MS);
  const orgs = opts.orgs ?? tidyOrgs();
  const post = opts.post ?? bridgeSlackForm;
  const channel = adminChannel();

  let reports = 0;
  let posted = 0;

  for (const org of orgs) {
    const result = await runOrgDigest({ org, now, windowStart, post, channel });
    if (result.reported) reports++;
    if (result.posted) posted++;

    await appendAudit({
      org,
      platform: "dream",
      workspace: "mode3",
      principalId: DREAM_ACTOR,
      action: "dream.mode3_tick",
      detail: { outcome: result.outcome, ...(result.totalFailures !== undefined ? { totalFailures: result.totalFailures } : {}) },
    });
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
