function armed(name: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export const OE_CONNECTOR_USER_PRINCIPAL_ENV = "OE_CONNECTOR_USER_PRINCIPAL";

export function connectorUserPrincipalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return armed(OE_CONNECTOR_USER_PRINCIPAL_ENV, env);
}

export const OE_CONNECTOR_LINKSET_VAULT_ENV = "OE_CONNECTOR_LINKSET_VAULT";

export function connectorLinkSetVaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return armed(OE_CONNECTOR_LINKSET_VAULT_ENV, env);
}

export const OE_CONNECTOR_OP_TIERING_ENV = "OE_CONNECTOR_OP_TIERING";

export function connectorOpTieringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return armed(OE_CONNECTOR_OP_TIERING_ENV, env);
}
