import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { assertConnectorCredentialsValid, type ConnectorCredentials } from "../access/connector-credentials.js";
import {
  applyBindingOverride,
  applyOverridesToConnectorCredentials,
  emptyCredentialBindingsFile,
  parseCredentialBindingsModule,
  emitCredentialBindingsModule,
  type ApplyBindingOverrideResult,
  type CredentialBindingsFile,
  type CredentialBindingOverride,
} from "../access/credential-bindings-codemod.js";
import { isSafeBranchName } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { DB_BROKER } from "./db-broker.js";
import { getConfigPrProvider, type ConfigPrProvider } from "./config-pr.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export interface BindingAuditWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
}

export interface StageCredentialBindingPrArgs {
  readonly connector: string;
  readonly credential: string;
  readonly storedRef: string;
  readonly credentialAuditId: string;
  readonly requestedBy: string;
  readonly where: BindingAuditWhere;
}

export interface CredentialBindingPrDeps {
  readonly config?: AccessRequestsConfig | null;
  readonly baseConnectorCredentials?: () => readonly ConnectorCredentials[];
  readonly bindingsPath?: string;
  readonly dryRun?: boolean;
  readonly provider?: ConfigPrProvider;
}

export interface StageCredentialBindingPrResult {
  readonly staged: boolean;
  readonly dryRun: boolean;
  readonly url?: string;
  readonly skipped?: string;
}

function bindingPrBody(args: StageCredentialBindingPrArgs, home: string): string {
  return [
    `Re-stamp credential **${args.connector} / ${args.credential}** custody to ${home}, resolving via ref \`${args.storedRef}\`.`,
    "",
    `This binds the value pasted through the "Set API key" intake (audit \`credential.stored\` id \`${args.credentialAuditId}\`), so`,
    "egress and host paths resolve it from the new custody home instead of an env var. **The pasted secret is NOT in this diff** —",
    `only the custody reference. Requested by \`${args.requestedBy}\`.`,
    "",
    "> ⚠️ The previous env var may still have OTHER consumers (e.g. a channel-plumbing path reading the same key). Merging",
    "> re-points THIS credential only; remove the env var upstream only once nothing else reads it.",
    "",
    "---",
    "This diff was produced by the deterministic credential-bindings codemod from the stored-credential ref — no model",
    "authored any part of it. Merging this PR IS the approval (CODEOWNERS + branch protection on the overlay path): the",
    "custody flip goes live on the next deploy of the merged config. Closing it unmerged declines the migration; the pasted",
    "ciphertext stays inert until it merges (nothing resolves the ref).",
  ].join("\n");
}

export async function stageCredentialBindingPr(
  args: StageCredentialBindingPrArgs,
  deps: CredentialBindingPrDeps = {},
): Promise<StageCredentialBindingPrResult> {
  let cfg: AccessRequestsConfig | null;
  try {
    cfg = deps.config ?? getConfig().loadAccessRequests?.() ?? null;
  } catch {
    cfg = null;
  }
  if (!cfg?.configRepo) {
    return { staged: false, dryRun: true, skipped: "config repo not configured (loadAccessRequests / OE_ACCESS_CONFIG_REPO) — credential-binding PR skipped" };
  }
  const baseCataloguesFn = deps.baseConnectorCredentials ?? cfg.baseConnectorCredentials;
  if (!baseCataloguesFn) {
    return { staged: false, dryRun: true, skipped: "base catalogues not registered (AccessRequestsConfig.baseConnectorCredentials) — credential-binding PR skipped" };
  }

  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const bindingsPath = deps.bindingsPath ?? process.env.OE_CREDENTIAL_BINDINGS_PATH ?? "agent/access/credential-bindings.generated.ts";
  const liveArmed = cfg.credentialBindingLive === true && cfg.dryRun !== true;
  const dryRun = deps.dryRun ?? !liveArmed;

  const override: CredentialBindingOverride = { connector: args.connector, credential: args.credential, broker: DB_BROKER, secretRef: args.storedRef };
  const home = DB_BROKER;
  const homePrBody = `\`broker: "${DB_BROKER}"\``;
  const branch = `credential-binding/${args.connector}-${args.credential}`;
  if (!isSafeBranchName(branch)) {
    throw new Error(`unsafe credential-binding branch name "${branch}"`);
  }

  const validateMerged = (file: CredentialBindingsFile): ApplyBindingOverrideResult => {
    const applied = applyBindingOverride(file, override);
    assertConnectorCredentialsValid(applyOverridesToConnectorCredentials(baseCataloguesFn(), applied.file.overrides));
    return applied;
  };

  const proposedDetail = (extra: AuditDetail) => ({
    credentialAuditId: args.credentialAuditId,
    connector: args.connector,
    credential: args.credential,
    storedRef: args.storedRef,
    broker: home,
    repo,
    branch,
    ...extra,
  });

  if (dryRun) {
    const applied = validateMerged(emptyCredentialBindingsFile());
    await appendAudit({
      ...args.where,
      principalId: args.requestedBy,
      action: "credential.binding_proposed",
      detail: proposedDetail({ dryRun: true, changed: applied.changed }),
    });
    return { staged: true, dryRun: true };
  }

  const provider = deps.provider ?? getConfigPrProvider();
  const token = await provider.resolveWriteToken(repo);

  let branchSha = await provider.getBranchSha({ repo, branch, token });
  if (branchSha === null) {
    const baseSha = await provider.getBranchSha({ repo, branch: base, token });
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase.`);
    await provider.ensureBranch({ repo, branch, sha: baseSha, token });
    branchSha = baseSha;
  }

  const existing = await provider.getFile({ repo, path: bindingsPath, branch, token });
  const file = existing?.content ? parseCredentialBindingsModule(existing.content) : emptyCredentialBindingsFile();
  const applied = validateMerged(file);

  await appendAudit({
    ...args.where,
    principalId: args.requestedBy,
    action: "credential.binding_proposed",
    detail: proposedDetail({ dryRun: false, changed: applied.changed }),
  });

  if (applied.changed) {
    await provider.putFile({
      repo,
      path: bindingsPath,
      content: emitCredentialBindingsModule(applied.file),
      message: `credential binding: ${args.connector}/${args.credential} → ${home}`,
      branch,
      token,
      committer: provider.committer(),
      sha: existing?.sha,
    });
  }

  const pr = await provider.openOrReopenPr({
    repo,
    head: branch,
    base,
    title: `Bind credential: ${args.connector}/${args.credential} → ${home}`,
    body: bindingPrBody(args, homePrBody),
    token,
  });

  await appendAudit({
    ...args.where,
    principalId: args.requestedBy,
    action: "credential.binding_opened",
    detail: proposedDetail({ pr: pr.number, url: pr.url, updated: pr.updated, reopened: pr.reopened }),
  });

  return { staged: true, dryRun: false, url: pr.url };
}
