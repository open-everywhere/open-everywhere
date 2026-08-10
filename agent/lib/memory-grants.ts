import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";
import type { DomainMemoryGrants } from "@open-everywhere/core/agent/adapter-api.js";
import { resolveAccess } from "@open-everywhere/core/agent/access/resolver.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { loadProviders } from "../access/providers.js";
import { PLUGIN_REGISTRY } from "../plugins/registry.js";

function splitSurfaceKey(key: string): { platform: string; workspace: string; channel: string } | null {
  const parts = key.split("/");
  if (parts.length < 3) return null;
  const [platform, workspace, ...rest] = parts;
  if (!platform || !workspace || rest.length === 0) return null;
  return { platform, workspace, channel: rest.join("/") };
}

export function domainMemoryGrants(domain: Domain): DomainMemoryGrants | null {
  const first = (domain.channels ?? []).find((c) => typeof c === "string" && c.length > 0);
  if (!first) return null;
  const coords = splitSurfaceKey(first);
  if (!coords) return null;
  const access = resolveAccess(
    { mode: "channel", platform: coords.platform, workspace: coords.workspace, channel: coords.channel, domains: [domain.name] },
    loadBundles(),
    loadBindings(),
    PLUGIN_REGISTRY,
    loadProviders(),
  );
  return { connectors: access.connectors, repos: access.repos };
}
