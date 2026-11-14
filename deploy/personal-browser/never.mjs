export const BOX_CAPABILITIES = ["payment-submit-refusal"];

export const PAYMENT_AUTOCOMPLETE =["cc-name", "cc-given-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-amount", "transaction-currency"];

export const PAYMENT_HINT = /card.?(num|number|no\b|holder)|credit.?card|debit.?card|\bcc.?(num|number)\b|\bcvv\d?\b|\bcvc\d?\b|\bcsc\b|security.?code|expir(y|ation)|\biban\b|sort.?code|routing.?(num|number)|account.?(num|number|no\b)|\bswift\b|\bbic\b/i;

export const PAY_LABEL = /\b(pay|pay now|place (your )?order|complete (your )?(order|purchase|payment)|confirm (and pay|order|payment|purchase)|buy( now)?|purchase|check ?out|subscribe|donate|send money|transfer( money| funds)?|submit (order|payment))\b/i;

export const PAYMENT_FRAME_HOSTS = ["js.stripe.com", "checkout.stripe.com", "pay.google.com", "paypal.com", "paypalobjects.com", "braintreegateway.com", "adyen.com", "checkoutshopper-live.adyen.com", "checkout.com", "squareup.com", "squarecdn.com", "klarna.com", "affirm.com", "worldpay.com"];

export function isPaymentField(f) {
  const ac = String(f.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (ac.some((a) => PAYMENT_AUTOCOMPLETE.includes(a))) return true;
  return PAYMENT_HINT.test(String(f.hint ?? ""));
}

function isPaymentFrameHost(host) {
  const h = String(host ?? "").toLowerCase();
  return PAYMENT_FRAME_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

export function paymentSubmitRefusal(facts) {
  const label = String(facts.control?.label ?? "");
  const payLabel = PAY_LABEL.test(label);
  let sends = false;
  if (facts.op === "click") sends = facts.control != null && (payLabel || (facts.scope === "form" && facts.control.submitControl === true));
  else if (facts.op === "type") sends = facts.submit === true;
  else if (facts.op === "key") sends = facts.key === "Enter" || (facts.key === "Space" && facts.control != null && (payLabel || facts.control.submitControl === true));
  if (!sends) return undefined;
  if (facts.scope === "page" && facts.op === "click" && !payLabel) return undefined;
  const holdsPayment =
    (facts.fields ?? []).some(isPaymentField) ||
    (facts.frames ?? []).some(isPaymentFrameHost) ||
    (payLabel && (facts.pageFrames ?? []).some(isPaymentFrameHost));
  if (!holdsPayment) return undefined;
  return "that would submit a payment form (it holds card or bank details), and the agent never submits a payment, whoever approved acting on this site — the person presses it themselves after they take the controls";
}
