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
import { resolveSelfHostBackendKind, selfHostBackendBootLog } from "./backend-select.js";
import { selfHostEgressBootLog } from "@open-everywhere/core/agent/access/self-host-egress.js";
import { startEgressDenialPoller } from "@open-everywhere/core/agent/access/egress-denial-poller.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import "../lib/register-config.js";

const SANDBOX_SETTINGS = getSettings().sandbox;
const TIMEOUT_MS = SANDBOX_SETTINGS.timeoutMs;
const SNAPSHOT_EXPIRATION_MS = SANDBOX_SETTINGS.snapshotExpirationMs;

const ON_VERCEL = onVercel();

const AGENT_BROWSER_BAKE = agentBrowserSandboxHooks();

function selfHostBackend() {
  const kind = resolveSelfHostBackendKind();
  const bootLog = selfHostBackendBootLog(kind);
  if (bootLog.warn !== undefined) console.warn(bootLog.warn);
  console.info(bootLog.info);
  const egressLog = selfHostEgressBootLog();
  if (egressLog.warn !== undefined) console.warn(egressLog.warn);
  console.info(egressLog.info);
  startEgressDenialPoller();
  if (kind === "justbash") return justbash();
  const image = getSettings().sandbox.image;
  return docker(image ? { image } : {});
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
