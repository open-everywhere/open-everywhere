export interface HeldQuestionStore {
  putTaskResult(org: string, key: string, resultJson: string, at: string, ttlMs: number): Promise<void>;
  getTaskResult(org: string, key: string): Promise<string | null>;
}

export const QUESTION_REQUEST_KIND = "question";

const NONMEMBER_PREFIX = "oe-held-question-nonmember:";

export const HELD_QUESTION_NONMEMBER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function heldQuestionNonMemberKey(requestId: string): string {
  return `${NONMEMBER_PREFIX}${requestId}`;
}

export async function rememberNonMemberAnswer(store: HeldQuestionStore, org: string, requestId: string, at: string = new Date().toISOString()): Promise<boolean> {
  try {
    if (requestId.length === 0) return false;
    await store.putTaskResult(org, heldQuestionNonMemberKey(requestId), JSON.stringify({ nonMember: true, at }), at, HELD_QUESTION_NONMEMBER_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

export async function nonMemberAnsweredIds(store: HeldQuestionStore, org: string, requestIds: readonly string[]): Promise<readonly string[]> {
  const out: string[] = [];
  for (const requestId of requestIds) {
    if (requestId.length === 0) continue;
    try {
      const raw = await store.getTaskResult(org, heldQuestionNonMemberKey(requestId));
      if (raw === null) continue;
      const row = JSON.parse(raw) as { nonMember?: unknown } | null;
      if (row?.nonMember === false) continue;
      out.push(requestId);
    } catch {
      out.push(requestId);
    }
  }
  return out;
}
