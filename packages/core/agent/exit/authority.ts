import { getOperationalStore } from "../operational/provider.js";
import { purgeLinkSetCredentials, revokeLinkSet } from "../identity/link-store.js";
import { endPersonHoldings } from "../identity/person-holdings.js";
import { purgeSubjectsCredentials, unrevokedDisplayName, unrevokedSentences } from "../credentials/purge.js";
import { rawVaultSubject } from "../identity/oauth-vault-share.js";
import { tryLinkTenantOf } from "../identity/link-tenant.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { registeredLongLivedBoxBackend } from "../sandbox/long-lived-box.js";
import { personIds } from "./erase.js";

export type AuthorityLinkSetOutcome =
  | "revoked"
  | "already-revoked"
  | "suggested-only"
  | "none"
  | "not-started";

export interface AuthorityEnded {
  readonly linkSet: AuthorityLinkSetOutcome;
  readonly started: boolean;
  readonly accountsRevoked: number;
  readonly credentialsPurged: number;
  readonly grantsRevoked: number;
  readonly browsersForgotten: number;
  readonly revocationsFailed: readonly string[];
  readonly failures: readonly string[];
  readonly notices?: readonly string[];
}

export interface EndPersonAuthorityOptions {
  readonly org: string;
  readonly person: string;
  readonly actor: string;
}

export async function endPersonAuthority(opts: EndPersonAuthorityOptions): Promise<AuthorityEnded> {
  const ids = personIds(opts.person);
  const parts = ids.key.split("/");
  const named = parts.length === 3 ? parts[1] : undefined;
  const nothing = { accountsRevoked: 0, credentialsPurged: 0, grantsRevoked: 0, browsersForgotten: 0, revocationsFailed: [] };
  const tenant = tryLinkTenantOf(ids.platform, named);
  const key = tryPrincipalKey(ids.platform, named, ids.nativeId);
  if (tenant === undefined || key === undefined) {
    return {
      linkSet: "none",
      started: false,
      ...nothing,
      failures: [`cannot name the ${ids.platform} workspace of "${ids.key}" — write the key as ${ids.platform}/<workspace>/${ids.nativeId}, so its links, credentials and holdings can be found`],
    };
  }
  const account = { platform: ids.platform, tenant, nativeId: ids.nativeId };
  const store = getOperationalStore();
  const found = (await store.getLinkedId(opts.org, account.platform, account.tenant, account.nativeId)) ?? undefined;
  const set = found === undefined ? undefined : ((await store.getLinkSet(opts.org, found.linkSetId)) ?? undefined);
  const row = set === undefined ? undefined : found;
  const revoking = row !== undefined && row.status === "confirmed" && set !== undefined && set.status !== "revoked";

  if (registeredLongLivedBoxBackend() === undefined) {
    const reach = revoking ? (await store.listLinkedIds(opts.org, row.linkSetId)).filter((r) => r.status === "confirmed") : [account];
    const held: string[] = [];
    for (const a of reach) {
      const k = tryPrincipalKey(a.platform, a.tenant, a.nativeId);
      if (k !== undefined && (await store.getPersonalBrowser(opts.org, k)) != null) held.push(k);
    }
    if (held.length > 0) {
      return {
        linkSet: "not-started",
        started: false,
        ...nothing,
        failures: [`${held.join(", ")} ${held.length === 1 ? "has" : "have"} a saved browser profile, and no box backend is named, so nothing was revoked, purged or erased — run again with --box-backend vercel|docker`],
      };
    }
  }

  const failures: string[] = [];
  if (revoking) {
    const res = await revokeLinkSet({ org: opts.org, linkSetId: row.linkSetId, actor: opts.actor });
    if (res.ok) {
      if (res.purge?.failed) failures.push(`the credential purge for link-set ${row.linkSetId} failed — run \`oe erase\` again, or purge_link_set_credentials`);
      failures.push(...unrevokedSentences(res.purge?.unrevoked ?? []));
      failures.push(...(res.holdings?.holdingFailures ?? []));
      return {
        linkSet: "revoked",
        started: true,
        accountsRevoked: res.tombstoned ?? 0,
        credentialsPurged: res.purge?.purged ?? 0,
        grantsRevoked: res.holdings?.grantsRevoked ?? 0,
        browsersForgotten: res.holdings?.browsersForgotten ?? 0,
        revocationsFailed: (res.purge?.unrevoked ?? []).map(unrevokedDisplayName),
        failures,
      };
    }
  }

  if (row !== undefined && row.status !== "suggested") {
    const notices: string[] = [];
    const purge = await purgeLinkSetCredentials({ org: opts.org, linkSetId: row.linkSetId, actor: opts.actor });
    if (!purge.ok) failures.push(purge.reason);
    const setUnrevoked = purge.ok ? (purge.unrevoked ?? []) : [];
    failures.push(...unrevokedSentences(setUnrevoked));
    const holdings = await endPersonHoldings(opts.org, [account], opts.actor);
    failures.push(...(holdings.holdingFailures ?? []));
    const nowIso = new Date().toISOString();
    try {
      const confirmedOnSet = new Set<string>();
      for (const r of await store.readAudit({ org: opts.org, action: "identity.link.confirmed", detailEquals: { linkSetId: row.linkSetId } })) {
        if (r.detail?.["linkSetId"] !== row.linkSetId) continue;
        const linked = r.detail?.["linked"];
        if (Array.isArray(linked)) for (const l of linked) if (typeof l === "string") confirmedOnSet.add(l);
      }
      for (const other of await store.listLinkedIds(opts.org, row.linkSetId)) {
        const k = tryPrincipalKey(other.platform, other.tenant, other.nativeId);
        if (k === undefined || k === key) continue;
        const browser = (await store.getPersonalBrowser(opts.org, k)) != null;
        const grants = (await store.liveCredentialGrantsForOwner(opts.org, k, nowIso)).length;
        if (!browser && grants === 0) continue;
        const holds = [browser ? "a saved browser profile" : "", grants > 0 ? `${grants} live lent grant(s)` : ""].filter(Boolean).join(" and ");
        if (confirmedOnSet.has(k)) failures.push(`${k}, a confirmed account on link-set ${row.linkSetId}, still holds ${holds} — end it with \`oe erase --person ${k}\``);
        else notices.push(`${k} was only suggested onto link-set ${row.linkSetId} (no confirmation is on record) and still holds ${holds}. It may be another person, so it was left alone — run \`oe erase --person ${k}\` only once you have established it is the same person`);
      }
    } catch (err) {
      failures.push(`could not check the other accounts of link-set ${row.linkSetId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      linkSet: "already-revoked",
      started: true,
      notices,
      accountsRevoked: 0,
      credentialsPurged: purge.ok ? (purge.purged ?? 0) : 0,
      grantsRevoked: holdings.grantsRevoked,
      browsersForgotten: holdings.browsersForgotten,
      revocationsFailed: setUnrevoked.map(unrevokedDisplayName),
      failures,
    };
  }

  const purge = await purgeSubjectsCredentials([rawVaultSubject(opts.org, account.platform, named, account.nativeId)]);
  if (purge.failed) failures.push(`the credential purge for ${key} failed — run \`oe erase\` again`);
  failures.push(...unrevokedSentences(purge.unrevoked));
  const holdings = await endPersonHoldings(opts.org, [account], opts.actor);
  failures.push(...(holdings.holdingFailures ?? []));
  return {
    linkSet: row === undefined ? "none" : "suggested-only",
    started: true,
    accountsRevoked: 0,
    credentialsPurged: purge.purged,
    grantsRevoked: holdings.grantsRevoked,
    browsersForgotten: holdings.browsersForgotten,
    revocationsFailed: purge.unrevoked.map(unrevokedDisplayName),
    failures,
  };
}
