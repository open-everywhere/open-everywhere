function armed(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export const OE_CONNECTOR_USER_PRINCIPAL_ENV = "OE_CONNECTOR_USER_PRINCIPAL";

export function connectorUserPrincipalEnabled(): boolean {
  return armed(OE_CONNECTOR_USER_PRINCIPAL_ENV);
}

export const OE_CONNECTOR_LINKSET_VAULT_ENV = "OE_CONNECTOR_LINKSET_VAULT";

export function connectorLinkSetVaultEnabled(): boolean {
  return armed(OE_CONNECTOR_LINKSET_VAULT_ENV);
}

export const OE_CONNECTOR_OP_TIERING_ENV = "OE_CONNECTOR_OP_TIERING";

export function connectorOpTieringEnabled(): boolean {
  return armed(OE_CONNECTOR_OP_TIERING_ENV);
}
