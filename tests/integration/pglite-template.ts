import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

import { PGLITE_TEMPLATE_DIR_ENV } from "./global-setup-contract.js";

export const PGLITE_TEMPLATE_DIR_NAME = "pglite-template";

export async function mintPgliteTemplate(parent: string): Promise<string> {
  const dir = join(parent, PGLITE_TEMPLATE_DIR_NAME);
  const { openOperationalPglite } = await import("@open-everywhere/core/agent/operational/pglite-client.js");
  const { initOperationalSchema } = await import("@open-everywhere/core/agent/operational/postgres.js");
  const open = await openOperationalPglite(dir);
  try {
    await initOperationalSchema(open.client);
  } finally {
    await open.close();
  }
  return dir;
}

export function copyPgliteTemplateInto(dest: string): boolean {
  const template = process.env[PGLITE_TEMPLATE_DIR_ENV];
  if (template === undefined || template.length === 0 || !existsSync(template)) return false;
  cpSync(template, dest, { recursive: true });
  return true;
}
