import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import "../agent/lib/register-config.js";
import { loadBindings, loadBundles } from "../agent/access/bundles.js";
import { loadProviders } from "../agent/access/providers.js";
import { PLUGIN_REGISTRY } from "../agent/plugins/registry.js";
import { loadDomains, loadSilos, domainsForSurface } from "../agent/memory/domains.js";
import { loadRoles } from "../agent/roles/roles.js";
import { loadWebhooks } from "../agent/webhooks/hooks.js";
import { loadPrincipals } from "../agent/identity/principals.js";
import { resolveDomainForChannel } from "@open-everywhere/core/agent/memory/domain.js";
import { classifyPrimitiveSource } from "@open-everywhere/core/agent/scaffold/tool-roster.js";
import { resolveAccess, type ResolveRequest } from "@open-everywhere/core/agent/access/resolver.js";
import {
  SNAPSHOT_FORMAT_VERSION,
  describeEffectiveAccess,
  encodeSet,
  flattenEntity,
  type ConfigSnapshot,
  type SnapshotRow,
} from "./config-snapshot-diff.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const SNAPSHOT_SECTIONS = [
  "access",
  "bindings",
  "bundles",
  "domains",
  "mounted",
  "plugins",
  "principals",
  "providers",
  "roles",
  "silos",
  "webhooks",
] as const;

export const ACCESS_KEY_SEP = " · ";

function splitSurfaceKey(key: string): { platform: string; workspace: string; channel: string } | undefined {
  const [platform, workspace, ...rest] = key.split("/");
  if (!platform || !workspace || rest.length === 0 || !rest.join("/")) return undefined;
  return { platform, workspace, channel: rest.join("/") };
}

export interface BoundScope {
  readonly platform: string;
  readonly workspace: string;
  readonly channel: string;
  readonly via: string;
}

export function boundScopes(): BoundScope[] {
  const domains = loadDomains();
  const out = new Map<string, BoundScope>();
  const add = (platform: string, workspace: string, channel: string, via: string) =>
    out.set(`${platform}/${workspace}/${channel}`, { platform, workspace, channel, via });

  for (const b of loadBindings()) {
    const s = b.scope;
    if (s.level === "surface") {
      const parts = splitSurfaceKey(s.surface!);
      if (parts) add(parts.platform, parts.workspace, parts.channel, `surface binding "${b.bundle}"`);
    }
    if (s.level === "tenant") {
      const [platform, workspace] = s.tenant!.split("/");
      if (platform && workspace) add(platform, workspace, "C__PROBE__", `tenant binding "${b.bundle}" (probe channel)`);
    }
    if (s.level === "domain") {
      const domain = domains.find((d) => d.name === s.domain);
      for (const key of domain?.channels ?? []) {
        const parts = splitSurfaceKey(key);
        if (parts) add(parts.platform, parts.workspace, parts.channel, `domain binding "${b.bundle}" via ${s.domain}`);
      }
      for (const key of domain?.containers ?? []) {
        const [platform, workspace] = key.split("/");
        if (platform && workspace) {
          add(platform, workspace, "C__PROBE__", `domain binding "${b.bundle}" via ${s.domain} (containers claim "${key}", probe channel)`);
        }
      }
    }
    if (s.level === "org") add("slack", "T__PROBE__", "C__PROBE__", `org binding "${b.bundle}" (probe scope)`);
  }
  return [...out.values()].sort((a, b) =>
    `${a.platform}/${a.workspace}/${a.channel}`.localeCompare(`${b.platform}/${b.workspace}/${b.channel}`),
  );
}

const MOUNTED_DIRS = ["tools", "connections", "subagents", "skills", "schedules", "hooks"] as const;

function classifyPrimitive(path: string): string {
  try {
    return classifyPrimitiveSource(readFileSync(path, "utf8"));
  } catch {
    return "unreadable";
  }
}

function mountedRows(agentDir: string): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const dir of MOUNTED_DIRS) {
    const full = join(agentDir, dir);
    let entries: string[];
    try {
      entries = readdirSync(full).sort((a, b) => a.localeCompare(b));
    } catch {
      rows.push({ section: "mounted", key: `${dir}/`, value: "<directory absent>" });
      continue;
    }
    rows.push({ section: "mounted", key: `${dir}/`, value: `${entries.length} entr(y|ies)` });
    for (const e of entries) {
      const p = join(full, e);
      const isDir = (() => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })();
      if (isDir) {
        let inner: string[] = [];
        try {
          inner = readdirSync(p, { recursive: true }).map(String).sort((a, b) => a.localeCompare(b));
        } catch {
        }
        rows.push({ section: "mounted", key: `${dir}/${e}/`, value: encodeSet(inner) });
        for (const f of inner) {
          if (!f.endsWith(".ts")) continue;
          rows.push({ section: "mounted", key: `${dir}/${e}/${f}`, value: classifyPrimitive(join(p, f)) });
        }
        continue;
      }
      if (!e.endsWith(".ts")) continue;
      rows.push({ section: "mounted", key: `${dir}/${e}`, value: classifyPrimitive(p) });
    }
  }
  return rows;
}

function entityRows(section: string, entities: readonly unknown[], nameOf: (e: never) => string): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const e of entities) {
    const name = nameOf(e as never);
    for (const { key, value } of flattenEntity(name, e, sha256)) rows.push({ section, key, value });
  }
  return rows;
}

function accessRows(): SnapshotRow[] {
  const domains = loadDomains();
  const bundles = loadBundles();
  const bindings = loadBindings();
  const providers = loadProviders();
  const rows: SnapshotRow[] = [];

  for (const scope of boundScopes()) {
    const scopeKey = `${scope.platform}/${scope.workspace}/${scope.channel}`;
    const req: ResolveRequest = {
      mode: "channel",
      platform: scope.platform,
      workspace: scope.workspace,
      channel: scope.channel,
      domains: domainsForSurface({ workspaceKey: `${scope.platform}/${scope.workspace}`, surface: scope.channel }),
    };
    const access = resolveAccess(req, bundles, bindings, PLUGIN_REGISTRY, providers);

    for (const [facet, items] of Object.entries(describeEffectiveAccess(access))) {
      rows.push({ section: "access", key: `${scopeKey}${ACCESS_KEY_SEP}${facet}`, value: encodeSet(items) });
    }
    for (const facet of ["plugins", "skills", "subagents", "warnings"] as const) {
      rows.push({ section: "access", key: `${scopeKey}${ACCESS_KEY_SEP}${facet}`, value: encodeSet([...access[facet]]) });
    }
    for (const { key, value } of flattenEntity(`${scopeKey}${ACCESS_KEY_SEP}connectorCredentials`, access.connectorCredentials, sha256)) {
      rows.push({ section: "access", key, value });
    }
    for (const { key, value } of flattenEntity(`${scopeKey}${ACCESS_KEY_SEP}instructionStack`, access.instructionStack, sha256)) {
      rows.push({ section: "access", key, value });
    }
    const routing = resolveDomainForChannel(scopeKey, domains);
    rows.push({
      section: "access",
      key: `${scopeKey}${ACCESS_KEY_SEP}routing`,
      value: `domain=${routing.domain?.name ?? "none"} via=${routing.via}`,
    });
    rows.push({ section: "access", key: `${scopeKey}${ACCESS_KEY_SEP}boundVia`, value: scope.via });
  }
  return rows;
}

export function buildConfigSnapshot(agentDir = "agent"): ConfigSnapshot {
  const rows: SnapshotRow[] = [
    ...accessRows(),
    ...entityRows("bindings", loadBindings(), (b: { bundle: string; scope: Record<string, unknown> }) =>
      `${b.scope.level}:${b.scope.org ?? b.scope.tenant ?? b.scope.domain ?? b.scope.surface ?? b.scope.group ?? b.scope.principal ?? "-"}→${b.bundle}`,
    ),
    ...entityRows("bundles", loadBundles(), (b: { name: string }) => b.name),
    ...entityRows("domains", loadDomains(), (d: { name: string }) => d.name),
    ...flattenEntity("", PLUGIN_REGISTRY, sha256).map(({ key, value }) => ({
      section: "plugins",
      key: key.replace(/^\./, ""),
      value,
    })),
    ...entityRows("principals", loadPrincipals(), (p: { name: string }) => p.name),
    ...entityRows("providers", loadProviders(), (p: { name: string }) => p.name),
    ...entityRows("roles", loadRoles(), (r: { name: string }) => r.name),
    ...entityRows("silos", loadSilos(), (s: { name: string }) => s.name),
    ...entityRows("webhooks", loadWebhooks(), (w: { id: string }) => w.id),
    ...mountedRows(agentDir),
  ];
  rows.sort((a, b) => a.section.localeCompare(b.section) || a.key.localeCompare(b.key));
  return { formatVersion: SNAPSHOT_FORMAT_VERSION, sections: [...SNAPSHOT_SECTIONS], rows };
}
