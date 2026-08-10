import { SETTINGS, getSettings } from "../settings/settings.js";

export const OE_CONNECTOR_USER_PRINCIPAL_ENV: string = SETTINGS.connectors.userPrincipal.env;

export function connectorUserPrincipalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getSettings(env).connectors.userPrincipal;
}

export const OE_CONNECTOR_LINKSET_VAULT_ENV: string = SETTINGS.connectors.linkSetVault.env;

export function connectorLinkSetVaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getSettings(env).connectors.linkSetVault;
}

export function directoryLinkSetVaultArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return connectorLinkSetVaultEnabled(env);
  } catch {
    return true;
  }
}

export const OE_CONNECTOR_OP_TIERING_ENV: string = SETTINGS.connectors.opTiering.env;

export function connectorOpTieringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getSettings(env).connectors.opTiering;
}
