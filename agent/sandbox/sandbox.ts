import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import { justbash } from "eve/sandbox/just-bash";
import { docker } from "eve/sandbox/docker";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { sandboxPresetFor } from "@open-everywhere/core/agent/roles/role.js";
import { getConfig } from "@open-everywhere/core/agent/access/config.js";
import { onVercel } from "@open-everywhere/core/agent/access/platform.js";
import { agentBrowserSandboxHooks } from "@open-everywhere/adapters/agent/browser/sandbox.js";
import "../lib/register-config.js";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const TIMEOUT_MS = intFromEnv("OE_SANDBOX_TIMEOUT_MS", 30 * 60 * 1000);
const SNAPSHOT_EXPIRATION_MS = intFromEnv("OE_SANDBOX_SNAPSHOT_EXPIRATION_MS", 7 * 24 * 60 * 60 * 1000);

const ON_VERCEL = onVercel();

const AGENT_BROWSER_BAKE = agentBrowserSandboxHooks();

function selfHostBackend() {
  const kind = (process.env.OE_SANDBOX_BACKEND ?? "justbash").trim().toLowerCase();
  if (kind === "docker") {
    const image = process.env.OE_SANDBOX_IMAGE?.trim();
    return docker(image ? { image } : {});
  }
  return justbash();
}

export default defineSandbox({
  backend: ON_VERCEL
    ? vercel({
        timeout: TIMEOUT_MS,
        snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
        keepLastSnapshots: { count: 1, deleteEvicted: true },
      })
    : selfHostBackend(),
  ...AGENT_BROWSER_BAKE,
  onSession: async ({ ctx, use }) => {
    if (!ON_VERCEL) {
      await use();
      return;
    }
    const useSized = use as unknown as (options?: { resources: { vcpus: number } }) => Promise<unknown>;
    let options: { resources: { vcpus: number } } | undefined;
    try {
      const bindable = ctx as BindableContext;
      const preset = sandboxPresetFor(bindFrom(bindable), resolvePartition(bindable), getConfig().loadDomains());
      const vcpus = preset?.vcpus;
      if (typeof vcpus === "number" && Number.isFinite(vcpus) && vcpus > 0) {
        options = { resources: { vcpus: Math.floor(vcpus) } };
      }
    } catch (err) {
      console.warn(`[open-everywhere:sandbox] vcpus preset resolution failed — using default size (${String(err)})`);
    }
    try {
      await useSized(options);
    } catch (err) {
      if (options === undefined) throw err;
      console.warn(`[open-everywhere:sandbox] applying vcpus=${options.resources.vcpus} failed — retrying default size (${String(err)})`);
      await useSized();
    }
  },
});
