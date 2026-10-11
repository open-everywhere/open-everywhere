import { getConfig } from "../access/config.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { criteriaDomain, type Domain } from "../memory/domain.js";
import { roleScopeDomain } from "../roles/role.js";
import { getSettings } from "../settings/settings.js";

export function resolveOutputLanguage(scope: Domain | undefined, domains: readonly Domain[], orgDefault: string): string {
  const own = scope?.language;
  if (own !== undefined && own !== "") return own;
  if (scope !== undefined && scope.match === undefined) {
    const org = criteriaDomain("org", domains)?.language;
    if (org !== undefined && org !== "") return org;
  }
  return orgDefault;
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(Intl.getCanonicalLocales(tag)[0] ?? tag) ?? tag;
  } catch {
    return tag;
  }
}

export function renderLanguageSection(tag: string): string {
  if (tag === "") return "";
  const name = languageName(tag);
  return [
    "## Output language",
    `Write every message and every report in ${name} (\`${tag}\`).`,
    `When the person you answer writes in another language, answer in their language. When a person asks for another language, use that one. Keep code, commands, identifiers, file paths and quoted text exactly as they are.`,
  ].join("\n");
}

export function renderLanguageSlotForDomain(scope: Domain | undefined): string {
  const orgDefault = getSettings().language.output;
  try {
    return renderLanguageSection(resolveOutputLanguage(scope, getConfig().loadDomains(), orgDefault));
  } catch {
    return renderLanguageSection(orgDefault);
  }
}

export function renderLanguageSlot(ctx: BindableContext): string {
  let scope: Domain | undefined;
  try {
    scope = roleScopeDomain(bindFrom(ctx), resolvePartition(ctx), getConfig().loadDomains());
  } catch {
    scope = undefined;
  }
  return renderLanguageSlotForDomain(scope);
}
