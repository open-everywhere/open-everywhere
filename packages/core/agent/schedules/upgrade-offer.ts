import { defineSchedule } from "eve/schedules";
import { getConfig } from "../access/config.js";
import { appendAudit } from "../audit/audit.js";
import { auditErrorDetail } from "../audit/tool-action.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { corePackageVersion } from "../ops/package-info.js";
import { postOnce, outboundKey } from "../operational/post-once.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { compareReleaseVersions, readLatestPublishedVersion, upgradeOfferText, type LatestVersionReader } from "../status/self-upgrade.js";
import { tidyOrgs } from "./tidy.js";

export const UPGRADE_OFFERED = "upgrade.offered";
export const UPGRADE_OFFER_TICK = "upgrade.offer_tick";

const UPGRADE_OFFER_ACTOR = "system:upgrade-offer";

const WHERE = { platform: "system", workspace: "upgrade-offer" } as const;

function log(msg: string): void {
  console.log(`[open-everywhere:upgrade-offer] ${msg}`);
}

export type OfferStore = Pick<OperationalStore, "getMeta" | "setMeta">;

export type UpgradeOfferPoster = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export interface UpgradeOfferTickReport {
  readonly outcome: string;
  readonly installed: string;
  readonly latest?: string;
  readonly posted: boolean;
}

function offerTarget(): { readonly channel?: string; readonly repo?: string } {
  try {
    const cfg = getConfig().loadAccessRequests?.();
    return { ...(cfg?.adminChannel ? { channel: cfg.adminChannel } : {}), ...(cfg?.configRepo ? { repo: cfg.configRepo } : {}) };
  } catch {
    return {};
  }
}

export function upgradeOfferMetaKey(version: string): string {
  return `upgrade.offer.v1:${version}`;
}

async function alreadyOffered(store: OfferStore, version: string): Promise<boolean> {
  try {
    return (await store.getMeta(upgradeOfferMetaKey(version))) !== null;
  } catch (err) {
    log(`meta read failed, so no offer this week: ${String(err)}`);
    return true;
  }
}

async function decideAndPost(input: {
  readonly orgs: readonly string[];
  readonly installed: string;
  readonly latest: string | undefined;
  readonly channel: string | undefined;
  readonly repo: string | undefined;
  readonly post: UpgradeOfferPoster;
  readonly store: OfferStore;
}): Promise<{ readonly outcome: string; readonly posted: boolean }> {
  const { orgs, installed, latest, channel, repo, post, store } = input;
  if (latest === undefined) return { outcome: "no-op: registry unreadable", posted: false };
  const order = compareReleaseVersions(latest, installed);
  if (order === undefined) return { outcome: "no-op: a version is not a release version", posted: false };
  if (order <= 0) return { outcome: "no-op: current", posted: false };
  if (!channel) return { outcome: "skipped: no admin channel configured", posted: false };
  if (!repo) return { outcome: "skipped: no config repo configured", posted: false };
  if (await alreadyOffered(store, latest)) return { outcome: "no-op: already offered", posted: false };

  const text = upgradeOfferText({ installed, latest, repo });
  try {
    const res = await postOnce({
      org: orgs[0],
      key: outboundKey({ surface: "system", channel, action: "upgrade.offer", payload: latest }),
      skipped: () => ({ ok: true }),
      run: async () => {
        const body = new URLSearchParams();
        body.set("channel", channel);
        body.set("text", text);
        return await post("chat.postMessage", body.toString());
      },
    });
    if (res?.ok !== true) return { outcome: "failed: post did not confirm ok", posted: false };
  } catch (err) {
    return { outcome: `failed: post — ${auditErrorDetail(String(err instanceof Error ? err.message : err).split("\n")[0]).error}`, posted: false };
  }
  for (const org of orgs) {
    await appendAudit({ org, ...WHERE, principalId: UPGRADE_OFFER_ACTOR, action: UPGRADE_OFFERED, detail: { version: latest, installed, channel } });
  }
  try {
    await store.setMeta(upgradeOfferMetaKey(latest), new Date().toISOString());
  } catch (err) {
    log(`posted, but the meta write failed, so next week may offer ${latest} again: ${String(err)}`);
  }
  return { outcome: "offered", posted: true };
}

export async function upgradeOfferTick(
  opts: {
    readonly orgs?: readonly string[];
    readonly installed?: string;
    readonly latest?: LatestVersionReader;
    readonly post?: UpgradeOfferPoster;
    readonly target?: { readonly channel?: string; readonly repo?: string };
    readonly store?: OfferStore;
  } = {},
): Promise<UpgradeOfferTickReport> {
  const orgs = opts.orgs ?? tidyOrgs();
  const installed = opts.installed ?? corePackageVersion();
  const latest = await (opts.latest ?? (() => readLatestPublishedVersion()))();
  const target = opts.target ?? offerTarget();
  const { outcome, posted } = await decideAndPost({ orgs, installed, latest, channel: target.channel, repo: target.repo, post: opts.post ?? bridgeSlackForm, store: opts.store ?? getOperationalStore() });
  for (const org of orgs) {
    await appendAudit({
      org,
      ...WHERE,
      principalId: UPGRADE_OFFER_ACTOR,
      action: UPGRADE_OFFER_TICK,
      detail: { outcome, installed, ...(latest !== undefined ? { latest } : {}) },
    });
  }
  log(`tick: ${outcome} (installed ${installed}, latest ${latest ?? "unknown"})`);
  return { outcome, installed, ...(latest !== undefined ? { latest } : {}), posted };
}

export default defineSchedule({
  cron: "0 6 * * 1",
  async run() {
    await upgradeOfferTick();
  },
});
