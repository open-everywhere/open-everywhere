export type IngestionTier = "trusted" | "untrusted";

export type IngestionKind =
  | "chat-message"
  | "notion"
  | "linear"
  | "github"
  | "connector"
  | "web"
  | "webhook"
  | "routine-event"
  | "delegation-result"
  | "image-description"
  | "file-upload";

export interface IngestionSource {
  readonly kind: IngestionKind;
  readonly repoPrivate?: boolean;
  readonly workspaceTrust?: "internal" | "public";
  readonly grantTrust?: "internal" | "public";
  readonly uploader?: "member" | "external" | "unknown";
  readonly label?: string;
}

export interface IngestionVerdict {
  readonly tier: IngestionTier;
  readonly reason: string;
  readonly assumed: boolean;
}

const untrusted = (reason: string, assumed = false): IngestionVerdict => ({ tier: "untrusted", reason, assumed });
const trusted = (reason: string): IngestionVerdict => ({ tier: "trusted", reason, assumed: false });

function unknownInstance(what: string): IngestionVerdict {
  return untrusted(`${what} could not be read at ingestion time, so the source instance is unproven — fail-closed to untrusted`, true);
}

export function classifyIngestion(src: IngestionSource): IngestionVerdict {
  switch (src.kind) {
    case "chat-message":
      return trusted("a chat message body on a member-authored surface; external surfaces are classified by surface trust one layer up, not here");

    case "notion":
    case "linear":
      if (src.workspaceTrust === "internal") return trusted(`the bound ${src.kind} workspace is declared internal — org-member-authored, same basis as a private channel`);
      if (src.workspaceTrust === "public") return untrusted(`the bound ${src.kind} workspace is declared public — anyone can author into it`);
      return unknownInstance(`the bound ${src.kind} workspace's declared tier`);

    case "github":
      if (src.repoPrivate === true) return trusted("a private org repository — its issues, reviews and diffs are org-authored");
      if (src.repoPrivate === false) return untrusted("a PUBLIC repository — a PR body, review comment or diff can be authored by anyone with a fork");
      return unknownInstance("the repository's `private` flag");

    case "connector":
      if (src.grantTrust === "internal") return trusted("the connection's grant declares `trust: internal` in reviewed bundle config");
      if (src.grantTrust === "public") return untrusted("the connection's grant declares `trust: public`");
      return untrusted("the connection's grant declares no trust tier — the ruled DEFAULT is public/untrusted, because silence in config must never read as an assurance", true);

    case "web":
      return untrusted("the open web — no bound instance, no membership, no configuration that could make it internal");

    case "webhook":
      return untrusted("a webhook delivery payload — authored by whoever can reach the endpoint");

    case "routine-event":
      return untrusted("a routine's event body — the hydrated entity an outside party's action produced");

    case "delegation-result":
      return untrusted("a delegated worker's result — but the AUTHORITATIVE answer is the worker's own OPE-298 return stamp, not this row; the table defers to it");

    case "image-description":
      return untrusted("describe_image: a second model's transcription of pixels nobody proof-read — untrusted regardless of who posted it (⚠ FLAGGED 2026-08-07, pending review: this breaks the instance-binary rule the rest of the table follows)");

    case "file-upload":
      if (src.uploader === "member") return trusted("uploaded by a workspace member (⚠ FLAGGED 2026-08-07, pending review: an AUTHOR rule, and a member forwarding an outside file passes it)");
      if (src.uploader === "external") return untrusted("uploaded by a non-member");
      return unknownInstance("the uploader's membership");
  }
}

export const INGESTION_KINDS: readonly IngestionKind[] = [
  "chat-message",
  "notion",
  "linear",
  "github",
  "connector",
  "web",
  "webhook",
  "routine-event",
  "delegation-result",
  "image-description",
  "file-upload",
];
