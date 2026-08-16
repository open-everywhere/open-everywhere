import { appendAudit, type AuditInput } from "../audit/audit.js";
import { checkClickerFloor, type ClickerFloorRefusal } from "./clicker-floor.js";

export const INPUT_RESPONSE_DENIED_AUDIT_ACTION = "input_response.denied";

export type InputResponseRefusal = ClickerFloorRefusal | "guest-answerer";

export type InputResponseAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: InputResponseRefusal; readonly notice: string };

export interface InputResponseScope {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly surfaceKey: string;
  readonly principalId: string;
  readonly responses?: number;
  readonly answererIsGuest?: boolean;
}

export interface InputResponseDeps {
  readonly floor?: typeof checkClickerFloor;
  readonly audit?: (entry: AuditInput) => Promise<void>;
}

export function inputResponseRefusalNotice(reason: InputResponseRefusal): string {
  switch (reason) {
    case "audience-floor":
      return (
        "I didn't take that answer: this channel's audience floor resolved to \"guest\" — it's externally shared, " +
        "or carries an observed guest/external member — so an answer given here can't stand in for one given inside " +
        "the org. The question is still open; answer it from an internal channel and I'll carry on."
      );
    case "guest-answerer":
      return (
        "I didn't take that answer: this conversation's membership list reports you as a guest, and a guest can't " +
        "answer on the org's behalf. The question is still open; anyone in the org can answer it and I'll carry on."
      );
    case "unattested-room":
      return (
        "I didn't take that answer: I couldn't verify who is in this conversation. The question is still open; " +
        "answer it from a room whose membership I can read and I'll carry on."
      );
    case "foreign-room":
      return "I didn't take that answer: it didn't come from the room I asked in. The question is still open.";
    case "guest-clicker":
      return (
        "I didn't take that answer: this workspace's membership list reports you as a guest, and a guest can't " +
        "answer on the org's behalf. The question is still open; anyone in the org can answer it and I'll carry on."
      );
  }
}

export async function admitInputResponse(
  scope: InputResponseScope,
  deps: InputResponseDeps = {},
): Promise<InputResponseAdmission> {
  const refuse = async (reason: InputResponseRefusal, floor: string): Promise<InputResponseAdmission> => {
    await (deps.audit ?? appendAudit)({
      org: scope.org,
      platform: scope.platform,
      workspace: scope.workspace,
      ...(scope.surface === undefined ? {} : { surface: scope.surface }),
      principalId: scope.principalId,
      action: INPUT_RESPONSE_DENIED_AUDIT_ACTION,
      detail: { reason, floor, ...(scope.responses === undefined ? {} : { responses: scope.responses }) },
    }).catch(() => undefined);
    return { ok: false, reason, notice: inputResponseRefusalNotice(reason) };
  };

  if (scope.answererIsGuest === true) return refuse("guest-answerer", "guest");

  const verdict = await (deps.floor ?? checkClickerFloor)(scope.surfaceKey, { beneficiaryClicker: false });
  if (!verdict.ok) return refuse(verdict.reason, verdict.floor);
  return { ok: true };
}
