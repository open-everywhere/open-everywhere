import assert from "node:assert/strict";
import {
  NOTION_HANDSHAKE_REF_NAMESPACE,
  RESERVED_REF_NAMESPACES,
  SELF_SECRET_REF_NAMESPACE,
  SLACK_APP_REF_NAMESPACE,
  reservedRefNamespace,
  reservedRefRefusal,
} from "../agent/credentials/reserved-refs.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

console.log("reserved refs:");

for (const ns of ["hook:", "oe-oauth:", NOTION_HANDSHAKE_REF_NAMESPACE, SELF_SECRET_REF_NAMESPACE, SLACK_APP_REF_NAMESPACE]) {
  ok(RESERVED_REF_NAMESPACES.includes(ns), `"${ns}" is a reserved namespace`);
}

for (const [ref, ns] of [
  ["hook:abc", "hook:"],
  ["oe-oauth:notion:sub", "oe-oauth:"],
  [`${NOTION_HANDSHAKE_REF_NAMESPACE}sub-1`, NOTION_HANDSHAKE_REF_NAMESPACE],
  [`${SELF_SECRET_REF_NAMESPACE}OE_INTAKE_PAGE_SIGNING_KEY`, SELF_SECRET_REF_NAMESPACE],
  [`${SLACK_APP_REF_NAMESPACE}bot_token`, SLACK_APP_REF_NAMESPACE],
  [`${SLACK_APP_REF_NAMESPACE}client_secret`, SLACK_APP_REF_NAMESPACE],
  [`${SLACK_APP_REF_NAMESPACE}signing_secret`, SLACK_APP_REF_NAMESPACE],
  [`${SLACK_APP_REF_NAMESPACE}cookie_key`, SLACK_APP_REF_NAMESPACE],
  [`${SLACK_APP_REF_NAMESPACE}setup_code`, SLACK_APP_REF_NAMESPACE],
] as const) {
  ok(reservedRefNamespace(ref) === ns, `${ref} resolves to the "${ns}" namespace`);
}

for (const ref of ["db:stripe", "stripe", "slack-app", "slack_app:token", "my-hook:thing", "SLACK-APP:token"]) {
  ok(reservedRefNamespace(ref) === undefined, `"${ref}" is NOT caught by the fence`);
}

ok(reservedRefNamespace("Hook:abc") === undefined, "the match is case-sensitive");
ok(reservedRefNamespace("Slack-App:bot_token") === undefined, "…for the Slack namespace too");

{
  const message = reservedRefRefusal(`${SLACK_APP_REF_NAMESPACE}bot_token`, SLACK_APP_REF_NAMESPACE);
  ok(message.includes("slack-app:bot_token"), "the refusal names the ref an operator would look up");
  ok(message.includes("reserved"), "…and says the namespace is reserved");
  ok(message.includes("fail closed"), "…and that it failed closed");
}

ok(RESERVED_REF_NAMESPACES.length === 5, `five reserved namespaces (found ${RESERVED_REF_NAMESPACES.length}) — a DELETION here re-opens a class to the egress plane`);

console.log(`✓ reserved refs: ${n} assertions`);
