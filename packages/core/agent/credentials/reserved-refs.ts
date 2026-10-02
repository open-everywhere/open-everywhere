export const NOTION_HANDSHAKE_REF_NAMESPACE = "notion-handshake:";

export const SELF_SECRET_REF_NAMESPACE = "self:";

export const SLACK_APP_REF_NAMESPACE = "slack-app:";

export const RESERVED_REF_NAMESPACES: readonly string[] = ["hook:", "oe-oauth:", NOTION_HANDSHAKE_REF_NAMESPACE, SELF_SECRET_REF_NAMESPACE, SLACK_APP_REF_NAMESPACE] as const;

export function reservedRefNamespace(ref: string): string | undefined {
  return RESERVED_REF_NAMESPACES.find((ns) => ref.startsWith(ns));
}

export function reservedRefRefusal(ref: string, ns: string): string {
  return (
    `credential ref ${JSON.stringify(ref)} is in the reserved "${ns}" namespace — refusing to resolve it as an ` +
    `outbound credential (fail closed). Refs in that namespace hold secret material this deployment minted for ` +
    `ITSELF (an inbound webhook signing secret, an OAuth token the adapter rotates); they are read internally by ` +
    `the encrypted KV vault, never handed to an outbound call. Pick a different ref.`
  );
}
