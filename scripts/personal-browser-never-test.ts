import assert from "node:assert/strict";
import { BOX_CAPABILITIES, isPaymentField, paymentSubmitRefusal, type PaymentStepFacts } from "../deploy/personal-browser/never.mjs";
import { BOX_PAYMENT_SUBMIT_CAPABILITY } from "../packages/core/agent/personal-browser/never-tier.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const CARD = [{ autocomplete: "cc-number", hint: "cardnumber" }, { autocomplete: "", hint: "email" }];
const PLAIN = [{ autocomplete: "email", hint: "email Email" }, { autocomplete: "", hint: "coupon Coupon code" }];
const base = (extra: Partial<PaymentStepFacts>): PaymentStepFacts => ({ op: "click", control: { submitControl: true, label: "Continue" }, scope: "form", fields: CARD, frames: [], ...extra });

ok(isPaymentField({ autocomplete: "cc-number" }) && isPaymentField({ autocomplete: "billing cc-csc" }), "an autocomplete card token is a payment field, also after a section token");
ok(isPaymentField({ hint: "card_number" }) && isPaymentField({ hint: "CVV" }) && isPaymentField({ hint: "IBAN" }) && isPaymentField({ hint: "sort-code" }) && isPaymentField({ hint: "Expiry date" }), "a card or bank hint is a payment field");
ok(!isPaymentField({ autocomplete: "email", hint: "email" }) && !isPaymentField({ hint: "postcode" }) && !isPaymentField({ hint: "discount card" }), "an ordinary field is not a payment field (negative control)");

ok(paymentSubmitRefusal(base({})) !== undefined, "🔴 a click on a submit control in a form with a card field is refused");
ok(/never submits a payment/.test(paymentSubmitRefusal(base({})) ?? ""), "…and the refusal says the agent never submits a payment");
ok(paymentSubmitRefusal(base({ fields: PLAIN })) === undefined, "the same click in a form with no payment field runs (negative control)");
ok(paymentSubmitRefusal(base({ fields: PLAIN, frames: ["js.stripe.com"] })) !== undefined, "🔴 a provider's card frame inside the form counts as a payment field");
ok(paymentSubmitRefusal(base({ fields: PLAIN, frames: ["www.youtube.com"] })) === undefined, "an unrelated frame does not count (negative control)");
ok(paymentSubmitRefusal(base({ fields: PLAIN, frames: [], pageFrames: ["js.stripe.com"], control: { submitControl: false, label: "Pay now" } })) !== undefined, "🔴 a paying label reads the PAGE's frames: a card frame outside the form counts");
ok(paymentSubmitRefusal(base({ fields: PLAIN, frames: [], pageFrames: ["js.stripe.com"] })) === undefined, "a non-paying label does not read the page's frames (negative control)");
ok(paymentSubmitRefusal(base({ control: { submitControl: false, label: "Show more" } })) === undefined, "a click on a type=button control with no paying label sends nothing");
ok(paymentSubmitRefusal(base({ control: { submitControl: false, label: "Place order" } })) !== undefined, "🔴 a script-driven button whose label reads as paying is refused");
ok(paymentSubmitRefusal(base({ scope: "page", control: { submitControl: true, label: "Search" } })) === undefined, "with no form, an ordinary button on a page that shows a card field runs");
ok(paymentSubmitRefusal(base({ scope: "page", control: { submitControl: false, label: "Buy now" } })) !== undefined, "🔴 with no form, a paying label on a page that holds a card field is refused");
ok(paymentSubmitRefusal(base({ control: null })) === undefined, "a click with no control found sends nothing");

ok(paymentSubmitRefusal(base({ op: "type", submit: true })) !== undefined, "🔴 typing and pressing Enter in a payment form is refused");
ok(paymentSubmitRefusal(base({ op: "type" })) === undefined, "typing without Enter sends nothing");
ok(paymentSubmitRefusal(base({ op: "key", key: "Enter" })) !== undefined, "🔴 the Enter key in a payment form is refused");
ok(paymentSubmitRefusal(base({ op: "key", key: "Tab" })) === undefined, "a Tab sends nothing");
ok(paymentSubmitRefusal(base({ op: "key", key: "Space" })) !== undefined, "Space on a focused submit control in a payment form is refused");
ok(paymentSubmitRefusal(base({ op: "key", key: "Space", control: { submitControl: false, label: "Show more" } })) === undefined, "Space on an ordinary focused control sends nothing");
ok(paymentSubmitRefusal(base({ op: "select" })) === undefined, "a select sends nothing");

ok(BOX_CAPABILITIES.includes(BOX_PAYMENT_SUBMIT_CAPABILITY), "the box reports the exact capability word OE reads before a judged step");

console.log(`✓ personal-browser-never: ${n} assertions passed`);
