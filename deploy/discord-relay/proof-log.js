export const PROOF_CONTENT_REDACTED = "(content redacted — OE_LOG_SHIP_URL is set)";

export const PROOF_CONTENT_EMPTY = "(empty — is Message Content Intent enabled?)";

export function proofContent(content, logShipping) {
  if (!content?.length) return PROOF_CONTENT_EMPTY;
  return logShipping ? PROOF_CONTENT_REDACTED : content;
}
