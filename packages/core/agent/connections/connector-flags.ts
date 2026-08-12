import { getSettings } from "../settings/settings.js";

export function connectorUserPrincipalEnabled(): boolean {
  return getSettings().connectors.userPrincipal;
}

export function connectorLinkSetVaultEnabled(): boolean {
  return getSettings().connectors.linkSetVault;
}

export function directoryLinkSetVaultArmed(): boolean {
  try {
    return connectorLinkSetVaultEnabled();
  } catch {
    return true;
  }
}

export function connectorOpTieringEnabled(): boolean {
  return getSettings().connectors.opTiering;
}
