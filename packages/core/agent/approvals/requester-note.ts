import { armingApproval } from "./arming-context.js";
import { getOperationalStore } from "../operational/provider.js";

export async function cardSitsWhereAsked(org: string, channelId: string, threadTs: string | null | undefined): Promise<boolean> {
  const arming = armingApproval();
  if (arming === undefined) return false;
  const row = await getOperationalStore()
    .getPendingAction(org, arming.id)
    .catch(() => null);
  if (row === null) return false;
  return row.channelId === channelId && (row.threadTs ?? null) === (threadTs ?? null);
}
