import { join } from "node:path";
import { onVercel } from "../access/platform.js";
import { LOCAL_WORKFLOW_DATA_DIR } from "./workflow-world.js";

export type TranscriptStore = { readonly kind: "local"; readonly dataDir: string } | { readonly kind: "hosted" };

export function resolveTranscriptStore(cwd: string, hosted: boolean = onVercel()): TranscriptStore {
  if (hosted) return { kind: "hosted" };
  return { kind: "local", dataDir: join(cwd, ...LOCAL_WORKFLOW_DATA_DIR.split("/")) };
}

export const HOSTED_TRANSCRIPTS_NOTE =
  "Session transcripts live in Vercel's hosted workflow store, which this process cannot reach and which offers no delete call. Read one with the control MCP's session_transcript tool; Vercel's own retention applies to the rest.";
