import type { RouteHandlerArgs } from "eve/channels";
import { getConfig } from "../access/config.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import type { Domain } from "../memory/domain.js";
import { grainUsesUnifiedWindow, supervisorGrainFor } from "../channels/unified-supervisor.js";
import { mintWakeId, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { fireSeatRowToken, forwardFireToWork, liveFireWorkDeps, planFireWork, type FireWorkDeps } from "./fire-work.js";

export interface FireWindowDeps {
  readonly loadDomains?: () => readonly Domain[];
  readonly org?: string;
  readonly armed?: boolean;
  readonly registryStore?: Pick<OperationalStore, "getChannelSession">;
  readonly work?: FireWorkDeps;
}

function liveDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export async function divertTriggeredFire(
  to: RouteHandlerArgs["to"],
  input: {
    readonly message: string;
    readonly surfaceKey: string;
    readonly origin: UnifiedWakeOrigin;
    readonly auth: { readonly authenticator?: string; readonly principalId?: string; readonly attributes?: Record<string, unknown> };
    readonly wakeId?: string;
  },
  deps: FireWindowDeps = {},
): Promise<boolean> {
  const org = deps.org ?? deploymentOrg();
  const armed = deps.armed ?? oneshotAgentEnabled();
  if (!armed) return false;
  const domains = (deps.loadDomains ?? liveDomains)();
  const grain = supervisorGrainFor(input.surfaceKey, domains);
  if (!grain.unified || grain.domainName === undefined || !grainUsesUnifiedWindow(grain)) return false;
  const registryStore = deps.registryStore ?? getOperationalStore();
  const workPlan = planFireWork({
    surfaceKey: input.surfaceKey,
    origin: input.origin,
    domains,
    seatRowToken: await fireSeatRowToken(org, input.surfaceKey, domains, registryStore),
    armed,
  });
  if (workPlan === null) return false;
  return await forwardFireToWork(
    to,
    workPlan,
    { message: input.message, surfaceKey: input.surfaceKey, origin: input.origin, auth: input.auth, wakeId: input.wakeId ?? mintWakeId() },
    deps.work ?? liveFireWorkDeps(org),
  );
}
