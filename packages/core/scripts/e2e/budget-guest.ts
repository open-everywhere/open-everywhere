import { failedRead, type SlackRawCall } from "./memory-canvas.js";

type FailedRead = ReturnType<typeof failedRead>;

const USERS_LIST_MAX_PAGES = 10;

export type WorkspaceGuest =
  | { readonly kind: "guest"; readonly userId: string; readonly why: "is_restricted" | "is_ultra_restricted" }
  | { readonly kind: "none"; readonly checked: number }
  | FailedRead;

export async function findWorkspaceGuest(call: SlackRawCall): Promise<WorkspaceGuest> {
  let cursor = "";
  let checked = 0;
  for (let page = 0; page < USERS_LIST_MAX_PAGES; page += 1) {
    const json = await call("users.list", { limit: "200", ...(cursor ? { cursor } : {}) });
    if (json.ok !== true) return failedRead("users.list", json);
    for (const m of Array.isArray(json.members) ? json.members : []) {
      const user = (m ?? {}) as Record<string, unknown>;
      if (typeof user.id !== "string") continue;
      checked += 1;
      if (user.deleted === true || user.is_bot === true) continue;
      if (user.is_restricted === true) return { kind: "guest", userId: user.id, why: "is_restricted" };
      if (user.is_ultra_restricted === true) return { kind: "guest", userId: user.id, why: "is_ultra_restricted" };
    }
    const next = (json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (typeof next !== "string" || next.length === 0) break;
    cursor = next;
  }
  return { kind: "none", checked };
}

const SHARED_FLAGS = ["is_ext_shared", "is_shared", "is_org_shared", "is_pending_ext_shared"] as const;

export type RoomSharing = { readonly kind: "internal" } | { readonly kind: "shared"; readonly flag: string } | FailedRead;

export async function roomSharing(call: SlackRawCall, channelId: string): Promise<RoomSharing> {
  const info = await call("conversations.info", { channel: channelId });
  if (info.ok !== true) return failedRead("conversations.info", info);
  const ch = (info.channel ?? {}) as Record<string, unknown>;
  for (const flag of SHARED_FLAGS) if (ch[flag] === true) return { kind: "shared", flag };
  return { kind: "internal" };
}

export const UNKNOWN_SLACK_USER_ID = "U0OENOBODY0E2E";

export function showsDollarFigure(text: string): boolean {
  return /\$\s?\d/u.test(text);
}
