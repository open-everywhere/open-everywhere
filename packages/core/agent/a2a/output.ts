import { ingestUntrustedModelOutput } from "../access/untrusted.js";

export interface A2aToolOutput {
  readonly status: "card-posted" | "delegated" | "failed";
  readonly agent: string;
  readonly pendingId?: string;
  readonly message: string;
  readonly remote?: string;
  readonly autoApproved?: boolean;
}

export async function a2aToolModelOutput(output: A2aToolOutput): Promise<{ type: "text"; value: string }> {
  if (output.remote === undefined) return { type: "text", value: output.message };
  const fenced = await ingestUntrustedModelOutput(output.remote, {
    source: `a2a:${output.agent}`,
    ingestion: { kind: "connector", grantContentOrigin: "external", label: "a2a-agent" },
  });
  return { type: "text", value: `${output.message}\n\n${fenced.value}` };
}
