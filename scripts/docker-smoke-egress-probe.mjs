import { generateText } from "ai";
import { Bash } from "just-bash";
import { ProxyAgent } from "undici";

import { gatewayHost, gatewayModelBackend } from "@open-everywhere/adapters/agent/model/gateway.js";
import { hostPlaneFetch } from "@open-everywhere/core/agent/access/host-plane-egress.js";
import { pushEgressPolicy } from "@open-everywhere/core/agent/access/self-host-egress.js";

const SESSION_HOST = process.env.OE_SMOKE_SESSION_HOST || "example.com";
const UNDECLARED_HOST = process.env.OE_SMOKE_UNDECLARED_HOST || "example.org";
const CREDENTIAL_UNDECLARED_HOST = process.env.OE_SMOKE_CREDENTIAL_UNDECLARED_HOST || "example.net";
const MODEL = process.env.OE_SMOKE_MODEL || "openai/gpt-6-luna";
const GW = gatewayHost(process.env.OE_AI_GATEWAY_URL?.trim() || undefined);

const line = (id, pass, detail) => console.log(`PROBE ${id} ${pass ? "ok" : "fail"} ${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);
const errText = (err) => `${err?.message ?? err}${err?.cause ? ` (cause: ${err.cause.message ?? err.cause})` : ""}`;

const shell = new Bash({ network: { dangerouslyAllowFullInternetAccess: true, denyPrivateRanges: false } });
const shippedShell = new Bash({ network: { dangerouslyAllowFullInternetAccess: true } });
async function sessionCurl(url) {
  const r = await shell.exec(`curl -s -o /dev/null -w "%{http_code}" --max-time 20 ${url}`);
  const code = r.stdout.trim();
  return code === "" ? "000" : code;
}

try {
  await pushEgressPolicy({ allow: [SESSION_HOST] }, { sessionId: "docker-smoke" });
  line("session-policy-pushed", true, `allow [${SESSION_HOST}]`);
} catch (err) {
  line("session-policy-pushed", false, errText(err));
}

const appFetch = hostPlaneFetch([GW]);
line("host-plane-wired", appFetch !== undefined, appFetch ? `host plane = [${GW}]` : "hostPlaneFetch returned undefined: no proxy tier?");
if (process.env.AI_GATEWAY_API_KEY) {
  try {
    const r = await generateText({ model: gatewayModelBackend().model(MODEL), prompt: "Reply with the single word PIGEON.", maxOutputTokens: 64 });
    line("model-call", r.text.trim().length > 0, `${MODEL} answered ${JSON.stringify(r.text.trim().slice(0, 40))}`);
  } catch (err) {
    line("model-call", false, errText(err));
  }
} else {
  try {
    const res = await appFetch(`https://${GW}/v1/models`);
    line("model-call", res.status === 200, `no AI_GATEWAY_API_KEY: host-plane GET /v1/models → HTTP ${res.status} (transport only)`);
  } catch (err) {
    line("model-call", false, errText(err));
  }
}

const sGw = await sessionCurl(`https://${GW}/v1/models`);
line("session-gateway-refused", sGw === "000", `session curl https://${GW} → ${sGw}`);

const sUnd = await sessionCurl(`https://${UNDECLARED_HOST}/`);
line("session-undeclared-refused", sUnd === "000", `session curl https://${UNDECLARED_HOST} → ${sUnd}`);

const sOwn = await sessionCurl(`https://${SESSION_HOST}/`);
line("session-declared-allowed", sOwn === "200", `session curl https://${SESSION_HOST} → ${sOwn}`);

const shipped = await shippedShell.exec(`curl -sS -o /dev/null -w "%{http_code}" --max-time 20 https://${SESSION_HOST}/`);
console.log(`NOTE session-shell-as-shipped ${SESSION_HOST} → ${shipped.stdout.trim() || "000"} ${shipped.stderr.trim().slice(0, 160)}`);

try {
  const proxyUrl = process.env.HTTPS_PROXY;
  const res = await fetch(`https://${CREDENTIAL_UNDECLARED_HOST}/`, {
    dispatcher: new ProxyAgent({ uri: proxyUrl, token: `Bearer ${process.env.OE_EGRESS_PROXY_TOKEN}` }),
  });
  line("host-plane-undeclared-refused", false, `credentialed request to ${CREDENTIAL_UNDECLARED_HOST} → HTTP ${res.status} (the proxy let it through)`);
} catch (err) {
  line("host-plane-undeclared-refused", true, `credentialed request to ${CREDENTIAL_UNDECLARED_HOST} refused: ${errText(err)}`);
}

try {
  await appFetch?.(`https://${UNDECLARED_HOST}/`);
  line("host-plane-guard", false, `host-plane fetch to ${UNDECLARED_HOST} was sent`);
} catch (err) {
  line("host-plane-guard", /not a declared host-plane host/.test(errText(err)), errText(err));
}

process.exit(0);
