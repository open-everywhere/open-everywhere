import { defineSandbox, type RuntimeSandboxSession, type SandboxEnvironment, type SandboxSession } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { DockerSandbox } from "eve/sandbox/docker";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { sandboxPresetFor } from "@open-everywhere/core/agent/roles/role.js";
import { getConfig } from "@open-everywhere/core/agent/access/config.js";
import { onVercel } from "@open-everywhere/core/agent/access/platform.js";
import { agentBrowserSandboxHooks, type BakeableSandbox } from "@open-everywhere/adapters/agent/browser/sandbox.js";
import { registerSandboxFirewall } from "@open-everywhere/core/agent/sandbox/network-policy.js";
import { resolveSelfHostBackendKind, selfHostBackendBootLog } from "./backend-select.js";
import type { SelfHostBackendKind } from "@open-everywhere/core/agent/adapter-api.js";
import {
  resolveSandboxRegionPlan,
  vercelSandboxCreateOptions,
} from "@open-everywhere/core/agent/sandbox/vercel-create.js";
import { selfHostEgressBootLog } from "@open-everywhere/core/agent/access/self-host-egress.js";
import { startEgressDenialPoller } from "@open-everywhere/core/agent/access/egress-denial-poller.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import "../lib/register-config.js";

const SANDBOX_SETTINGS = getSettings().sandbox;
const TIMEOUT_MS = SANDBOX_SETTINGS.timeoutMs;
const SNAPSHOT_EXPIRATION_MS = SANDBOX_SETTINGS.snapshotExpirationMs;

const ON_VERCEL = onVercel();

const REGION_PLAN = resolveSandboxRegionPlan({ region: SANDBOX_SETTINGS.region, onVercel: ON_VERCEL });
if (REGION_PLAN.kind === "invalid" || REGION_PLAN.kind === "refused") throw new Error(REGION_PLAN.error);
if (REGION_PLAN.kind === "inert") console.warn(REGION_PLAN.warn);
if (REGION_PLAN.kind === "pinned") console.info(REGION_PLAN.info);

const VERCEL_CREATE_OPTIONS = vercelSandboxCreateOptions({
  timeoutMs: TIMEOUT_MS,
  snapshotExpirationMs: SNAPSHOT_EXPIRATION_MS,
  regionPlan: REGION_PLAN,
});

const AGENT_BROWSER_BAKE = agentBrowserSandboxHooks();

const AGENT_BROWSER_PREPARE =
  AGENT_BROWSER_BAKE.bootstrap === undefined
    ? {}
    : {
        prepare: async (sandbox: SandboxSession): Promise<void> => {
          const bootstrap = AGENT_BROWSER_BAKE.bootstrap;
          if (bootstrap === undefined) return;
          await bootstrap({ use: async () => sandbox satisfies BakeableSandbox });
        },
      };

const VERCEL_ENVIRONMENT = VercelSandbox.environment({ ...VERCEL_CREATE_OPTIONS, ...AGENT_BROWSER_PREPARE });

interface SelfHostSandbox {
  readonly kind: SelfHostBackendKind;
  readonly environment: SandboxEnvironment<object | undefined, SandboxSession>;
  readonly open: () => Promise<RuntimeSandboxSession>;
}

function selfHostEnvironment(): SelfHostSandbox {
  const kind = resolveSelfHostBackendKind();
  const bootLog = selfHostBackendBootLog(kind);
  if (bootLog.warn !== undefined) console.warn(bootLog.warn);
  console.info(bootLog.info);
  const egressLog = selfHostEgressBootLog();
  if (egressLog.warn !== undefined) console.warn(egressLog.warn);
  console.info(egressLog.info);
  startEgressDenialPoller();
  if (kind === "justbash") {
    const environment = JustBashSandbox.environment({});
    registerSandboxFirewall({ carries: "none", backend: "justbash" });
    return { kind, environment, open: async () => await environment.open() };
  }
  const image = getSettings().sandbox.image;
  const environment = image ? DockerSandbox.environment({ image }) : DockerSandbox.environment({});
  registerSandboxFirewall({ carries: "coarse", environment });
  return { kind, environment, open: async () => await environment.open() };
}

const SELF_HOST = ON_VERCEL ? undefined : selfHostEnvironment();
if (ON_VERCEL) registerSandboxFirewall({ carries: "full", environment: VERCEL_ENVIRONMENT });

export const environment: SandboxEnvironment<object | undefined, SandboxSession> =
  SELF_HOST === undefined ? (VERCEL_ENVIRONMENT as SandboxEnvironment<object | undefined, SandboxSession>) : SELF_HOST.environment;

export default defineSandbox(async (context) => {
  if (SELF_HOST !== undefined) return await SELF_HOST.open();
  let options: { resources: { vcpus: number } } | undefined;
  try {
    const bindable = context as unknown as BindableContext;
    const preset = sandboxPresetFor(bindFrom(bindable), resolvePartition(bindable), getConfig().loadDomains());
    const vcpus = preset?.vcpus;
    if (typeof vcpus === "number" && Number.isFinite(vcpus) && vcpus > 0) {
      options = { resources: { vcpus: Math.floor(vcpus) } };
    }
  } catch (err) {
    console.warn(`[open-everywhere:sandbox] vcpus preset resolution failed — using default size (${String(err)})`);
  }
  if (options === undefined) return await VERCEL_ENVIRONMENT.open();
  try {
    return await VERCEL_ENVIRONMENT.open(options);
  } catch (err) {
    console.warn(`[open-everywhere:sandbox] applying vcpus=${options.resources.vcpus} failed — retrying default size (${String(err)})`);
    return await VERCEL_ENVIRONMENT.open();
  }
});
