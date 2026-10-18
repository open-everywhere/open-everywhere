import { join } from "node:path";
import { onVercel } from "../access/platform.js";
import type { ExitTableAccess } from "../operational/store.js";
import { EXIT_TABLES } from "./catalogue.js";
import { isRunId, LOCAL_WORKFLOW_DATA_DIR } from "./workflow-world.js";

export type TranscriptStore = { readonly kind: "local"; readonly dataDir: string } | { readonly kind: "hosted" };

export function resolveTranscriptStore(cwd: string, hosted: boolean = onVercel()): TranscriptStore {
  if (hosted) return { kind: "hosted" };
  return { kind: "local", dataDir: join(cwd, ...LOCAL_WORKFLOW_DATA_DIR.split("/")) };
}

export const HOSTED_TRANSCRIPTS_NOTE =
  "Session transcripts live in Vercel's hosted workflow store, which offers no delete call, so the exit kit cannot delete them and Vercel's own retention applies. This process cannot read them either. `oe export` can copy the sessions the org's rows name through the deployment's transcript route, given OE_DEPLOY_CONTROL_TOKEN and the deployment's URL, and the control MCP's session_transcript tool reads one.";

export const UNREACHED_TRANSCRIPTS_NOTE =
  "transcripts: not reached — this host has no workflow directory. On Vercel they are in the hosted workflow store, which offers no delete call; off Vercel, run on the host that serves the agent or pass --transcripts-dir";

const SESSION_PAGE = 1000;

export async function orgSessionIds(tables: ExitTableAccess, org: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const spec of EXIT_TABLES) {
    if (spec.sessionColumn === undefined || spec.orgColumn === null) continue;
    for (let after: string | undefined; ; ) {
      const page = await tables.selectDistinct(spec.table, org, spec.sessionColumn, {}, { ...(after !== undefined ? { after } : {}), limit: SESSION_PAGE });
      for (const s of page) if (isRunId(s)) ids.add(s);
      if (page.length < SESSION_PAGE || page.at(-1) === after) break;
      after = page.at(-1);
    }
  }
  return [...ids].sort();
}
