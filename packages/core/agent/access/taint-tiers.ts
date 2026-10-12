export type IngestionTier = "trusted" | "untrusted";

export type IngestionKind =
  | "chat-message"
  | "notion"
  | "linear"
  | "github"
  | "connector"
  | "web"
  | "webhook"
  | "a2a-inbound"
  | "routine-event"
  | "delegation-result"
  | "image-description"
  | "file-upload"
  | "aws"
  | "skill-declared"
  | "work-search";

export interface IngestionSource {
  readonly kind: IngestionKind;
  readonly repoPrivate?: boolean;
  readonly workspaceTrust?: "internal" | "public";
  readonly grantContentOrigin?: "internal" | "external";
  readonly authoredByNonMember?: boolean;
  readonly carriesUntrustedPost?: boolean;
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
      if (src.carriesUntrustedPost === true) {
        return untrusted("a chat message OE itself posted from untrusted content (a meeting recap written from a meeting transcript), or the thread it went into — the host recorded the post's provenance when it posted it");
      }
      if (src.authoredByNonMember === true) {
        return untrusted(
          "a chat message written by an author POSITIVELY REFUTED as a non-member — the surface's own identity probe or the operator's author-trust register said guest/stranger/unlisted, so a person outside the org authored bytes this turn read",
        );
      }
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
      if (src.grantContentOrigin === "internal") return trusted("the connection's grant declares `contentOrigin: internal` for this tool in reviewed bundle config — org members author what it returns");
      if (src.grantContentOrigin === "external") return untrusted("the connection's grant declares `contentOrigin: external` for this tool — the bytes it returns are authored outside the org");
      return untrusted("the connection's grant declares no content origin — the ruled DEFAULT is external/untrusted, because silence in config must never read as an assurance", true);

    case "web":
      return untrusted("the open web — no bound instance, no membership, no configuration that could make it internal");

    case "webhook":
      return untrusted("a webhook delivery payload — authored by whoever can reach the endpoint");

    case "a2a-inbound":
      return untrusted("an inbound A2A caller's message — another organisation's agent wrote it; an authenticated caller is still an external author");

    case "routine-event":
      return untrusted("a routine's event body — the hydrated entity an outside party's action produced");

    case "delegation-result":
      return untrusted("a delegated worker's result — untrusted by provenance: a worker's prose distils whatever wide-hands reads it made");

    case "image-description":
      return untrusted("describe_image: a second model's transcription of pixels nobody proof-read — untrusted regardless of who posted it (ratified exception to the instance-binary rule, 2026-08-08)");

    case "file-upload":
      return untrusted("a file upload — always untrusted regardless of who uploaded it (ruled: authorship ≠ provenance; instructions inside a file are data, never acted on)");

    case "aws":
      return untrusted("the `aws` CLI's own output — an AWS account is a SUBSTRATE, not an authoring surface: nothing gates who writes a log line, a table item or an object body, so org ownership of the account says nothing about who wrote the bytes");

    case "skill-declared":
      return untrusted("a skill script's self-declared external fetch — a sandbox script vouching for its own bytes may only ADD taint, never relax; unconditional, no metadata branch");

    case "work-search":
      return untrusted("the federated search tool's result — a single call can mix several connectors' hits, so no one instance's trust tier could stand for the whole row; titles are arbitrary workspace text either way");
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
  "a2a-inbound",
  "routine-event",
  "delegation-result",
  "image-description",
  "file-upload",
  "aws",
  "skill-declared",
  "work-search",
];
