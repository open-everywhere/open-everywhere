import { personalBrowserPolicy, type PersonalBrowserPolicy } from "./policy.js";

export type BrowserNeverCategory = "payments" | "trading" | "banking";

interface NeverDomain {
  readonly domain: string;
  readonly category: BrowserNeverCategory;
}

const d = (category: BrowserNeverCategory, ...domains: string[]): NeverDomain[] => domains.map((domain) => ({ domain, category }));

export const BROWSER_NEVER_DOMAINS: readonly NeverDomain[] = [
  ...d(
    "payments",
    "paypal.com", "paypal.me", "stripe.com", "squareup.com", "wise.com", "transferwise.com", "venmo.com", "cash.app",
    "zellepay.com", "klarna.com", "afterpay.com", "affirm.com", "adyen.com", "braintreegateway.com", "checkout.com",
    "worldpay.com", "skrill.com", "payoneer.com", "westernunion.com", "moneygram.com", "remitly.com", "xoom.com",
    "alipay.com", "gocardless.com",
  ),
  ...d(
    "trading",
    "robinhood.com", "etrade.com", "schwab.com", "fidelity.com", "vanguard.com", "interactivebrokers.com",
    "interactivebrokers.co.uk", "tdameritrade.com", "webull.com", "trading212.com", "etoro.com", "hl.co.uk",
    "ajbell.co.uk", "freetrade.io", "degiro.com", "plus500.com", "ig.com", "tastytrade.com", "merrilledge.com",
    "coinbase.com", "binance.com", "kraken.com", "gemini.com", "crypto.com", "bitstamp.net", "okx.com", "bybit.com",
    "kucoin.com", "bitfinex.com", "uphold.com",
  ),
  ...d(
    "banking",
    "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com", "capitalone.com",
    "pnc.com", "hsbc.com", "hsbc.co.uk", "barclays.co.uk", "barclays.com", "lloydsbank.com", "natwest.com",
    "santander.co.uk", "halifax.co.uk", "nationwide.co.uk", "rbs.co.uk", "tsb.co.uk", "americanexpress.com",
    "discover.com", "ally.com", "chime.com", "n26.com", "revolut.com", "monzo.com", "starlingbank.com",
  ),
];

const NEVER_LABEL_WORDS: Readonly<Record<string, BrowserNeverCategory>> = {
  pay: "payments",
  payment: "payments",
  payments: "payments",
  checkout: "payments",
  wallet: "payments",
  trade: "trading",
  trading: "trading",
  broker: "trading",
  brokerage: "trading",
  invest: "trading",
  investing: "trading",
  crypto: "trading",
};

const BANK_FRAGMENT = "bank";

export type BrowserNeverMatch =
  | { readonly source: "default"; readonly category: BrowserNeverCategory; readonly rule: string }
  | { readonly source: "policy"; readonly rule: string };

function underDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function browserNeverHostMatch(host: string, policy: PersonalBrowserPolicy = personalBrowserPolicy()): BrowserNeverMatch | undefined {
  const h = host.trim().toLowerCase().replace(/\.$/u, "");
  if (h === "") return undefined;
  const shipped = BROWSER_NEVER_DOMAINS.find((n) => underDomain(h, n.domain));
  if (shipped !== undefined) return { source: "default", category: shipped.category, rule: shipped.domain };
  const labels = h.split(".");
  for (const label of labels.slice(0, -1)) {
    if (label.includes(BANK_FRAGMENT)) return { source: "default", category: "banking", rule: `label:${BANK_FRAGMENT}` };
    for (const part of [label, ...label.split("-")]) {
      const category = NEVER_LABEL_WORDS[part];
      if (category !== undefined) return { source: "default", category, rule: `label:${part}` };
    }
  }
  const added = (policy.neverHosts ?? []).find((n) => underDomain(h, n));
  return added === undefined ? undefined : { source: "policy", rule: added };
}

export const BOX_PAYMENT_SUBMIT_CAPABILITY = "payment-submit-refusal";

export function boxRefusesPaymentSubmit(health: Record<string, unknown> | undefined): boolean {
  const caps = health?.["capabilities"];
  return Array.isArray(caps) && caps.includes(BOX_PAYMENT_SUBMIT_CAPABILITY);
}

export const BOX_CAPABILITY_REFUSAL =
  "your browser runs an older build that cannot check for a payment form, so I did not take the step the approval judge allowed. Nothing was clicked or typed. " +
  "An admin rebuilds and publishes the browser image to fix this, or sets the browser policy's judge switch to off so that I ask you with a card instead. Until then, take the controls yourself (my_browser_handoff).";

export function browserNeverRefusalMessage(host: string, match: BrowserNeverMatch): string {
  const why =
    match.source === "default"
      ? `it is a ${match.category} site (never-tier rule "${match.rule}", a shipped default)`
      : `this deployment's personal browser policy lists it (neverHosts "${match.rule}")`;
  return (
    `I never click or type on ${host} in your browser: ${why}. Nothing was clicked or typed, and no approval, rule or setting can allow it. ` +
    `This is not waiting for approval, so do not offer to ask for one. I can still read the page. To act there, take the controls yourself (my_browser_handoff), or do it outside the agent.`
  );
}
