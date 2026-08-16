import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";

export type BotDisplayNameArm = () => Promise<string | undefined>;

const ARMS = processRegistryMap<BotDisplayNameArm>("bot-display-name.v1");

export function registerBotDisplayName(platform: string, arm: BotDisplayNameArm): void {
  if (!admitProviderRegistration(platform, "bot-display-name")) return;
  ARMS.set(platform, arm);
}

export function _resetBotDisplayNamesForTest(): void {
  ARMS.clear();
}

export async function botDisplayNameFor(platform: string | undefined): Promise<string | undefined> {
  if (platform === undefined || platform.length === 0) return undefined;
  const arm = ARMS.get(platform);
  if (!arm) return undefined;
  try {
    const name = await arm();
    if (typeof name !== "string") return undefined;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
