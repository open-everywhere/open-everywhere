import { getConfig } from "../access/config.js";
import { humanActingSupport, isHumanActing, type ConnectorCredentials } from "../access/connector-credentials.js";
import { credentialGrantConnectors } from "../access/credential-grant.js";
import type { OwnAccountVendor } from "./own-account-ask.js";

export const OWN_ACCOUNT_VENDOR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  github: ["github.com"],
  notion: ["notion.so"],
};

const OWN_ACCOUNT_VENDOR_MIN_ALIAS_CHARS = 4;

export function ownAccountVendorAliasProblems(table: Readonly<Record<string, readonly string[]>> = OWN_ACCOUNT_VENDOR_ALIASES): string[] {
  const problems: string[] = [];
  for (const [connector, aliases] of Object.entries(table)) {
    const seen = new Set<string>([connector]);
    for (const alias of aliases) {
      if (alias !== alias.toLowerCase()) problems.push(`${connector}: alias "${alias}" is not lower-case — the grammar lower-cases the sentence, never the alias`);
      if (alias.length < OWN_ACCOUNT_VENDOR_MIN_ALIAS_CHARS) {
        problems.push(
          `${connector}: alias "${alias}" is shorter than ${OWN_ACCOUNT_VENDOR_MIN_ALIAS_CHARS} characters — a vendor word is ` +
            `matched with no word boundary, so a short alias binds ordinary words to ${connector} and refuses reads nobody ` +
            `asked to personalise`,
        );
      }
      if (seen.has(alias)) problems.push(`${connector}: alias "${alias}" is a duplicate — the connector id is already a vendor word`);
      seen.add(alias);
    }
  }
  return problems;
}

export function ownAccountVendorFor(connector: string): OwnAccountVendor {
  const aliases = OWN_ACCOUNT_VENDOR_ALIASES[connector];
  return aliases === undefined || aliases.length === 0 ? { connector } : { aliases, connector };
}

export function humanActingConnectors(catalogues?: readonly ConnectorCredentials[]): readonly string[] {
  if (catalogues !== undefined) return declaredHumanActing(catalogues);
  let list: readonly ConnectorCredentials[];
  try {
    list = getConfig().loadConnectorCredentials?.() ?? [];
  } catch (err) {
    if (lastGoodHumanActing !== undefined) return lastGoodHumanActing;
    throw new OwnAccountVendorsUnavailableError(err);
  }
  lastGoodHumanActing = declaredHumanActing(list);
  return lastGoodHumanActing;
}

let lastGoodHumanActing: readonly string[] | undefined;

export function _resetHumanActingCacheForTest(): void {
  lastGoodHumanActing = undefined;
}

function declaredHumanActing(catalogues: readonly ConnectorCredentials[]): readonly string[] {
  return catalogues.filter((c) => humanActingSupport(c) === "supported" && c.credentials.some((cred) => isHumanActing(cred))).map((c) => c.connector);
}

export class OwnAccountVendorsUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `own-account vendors are unavailable: the connector-credential catalogue could not be read, so which vendors declare a ` +
        `human-acting credential family is unknown. Resolving this as "none" would silently drop a vendor from the own-account ` +
        `stamp and answer a delegated worker's read with the deployment's own credential (OPE-1641). Cause: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "OwnAccountVendorsUnavailableError";
  }
}

export function ownAccountAskVendors(): readonly OwnAccountVendor[] {
  const connectors = new Set<string>([...credentialGrantConnectors(), ...humanActingConnectors()]);
  return [...connectors].sort().map((connector) => ownAccountVendorFor(connector));
}

export function credentialGrantVendors(): readonly OwnAccountVendor[] {
  return [...credentialGrantConnectors()].sort().map((connector) => ownAccountVendorFor(connector));
}
