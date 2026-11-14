export const BOX_CAPABILITIES: readonly string[];
export const PAYMENT_AUTOCOMPLETE: readonly string[];
export const PAYMENT_HINT: RegExp;
export const PAY_LABEL: RegExp;
export const PAYMENT_FRAME_HOSTS: readonly string[];

export interface PaymentField {
  readonly autocomplete?: string;
  readonly hint?: string;
}

export interface PaymentStepFacts {
  readonly op: string;
  readonly key?: string;
  readonly submit?: boolean;
  readonly control?: { readonly submitControl: boolean; readonly label: string } | null;
  readonly scope: "form" | "page";
  readonly fields: readonly PaymentField[];
  readonly frames: readonly string[];
  readonly pageFrames?: readonly string[];
}

export function isPaymentField(f: PaymentField): boolean;
export function paymentSubmitRefusal(facts: PaymentStepFacts): string | undefined;
