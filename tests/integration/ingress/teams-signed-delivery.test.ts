import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { auditCursor, bootAgent, installTeamsJwksStub, rowsSinceCursor, signTeamsJwt, TEAMS_FIXTURE_SERVICE_URL, teamsActivityPost, waitFor } from "../harness";

afterAll(async () => {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
  const authorTrust = await import("@open-everywhere/core/agent/identity/author-trust.js");
  authorTrust._resetAuthorTrustForTest();
});

function dmActivity(input: { readonly tenantId: string; readonly authorId: string; readonly conversationId: string; readonly text?: string }): Record<string, unknown> {
  return {
    type: "message",
    channelId: "msteams",
    id: `it-teams-act-${randomBytes(4).toString("hex")}`,
    serviceUrl: TEAMS_FIXTURE_SERVICE_URL,
    from: { id: input.authorId, name: "IT Fixture User" },
    recipient: { id: "28:it-teams-bot", name: "OE Bot" },
    conversation: { id: input.conversationId, conversationType: "personal", tenantId: input.tenantId },
    channelData: { tenant: { id: input.tenantId } },
    text: input.text ?? "hello from a refuted author",
  };
}

async function armSeams(tenantId: string, internalMemberId: string): Promise<{ uninstall(): void }> {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ externalPolicy: { authorGrain: "withhold" } });
  expect(settings.getSettings().externalPolicy.authorGrain).toBe("withhold");

  const authorTrust = await import("@open-everywhere/core/agent/identity/author-trust.js");
  authorTrust.registerAuthorTrust([{ tenant: `teams/${tenantId}`, internal: [`teams/${internalMemberId}`] }]);
  expect(authorTrust.armedAuthorTrustTenants()).toContain(`teams/${tenantId}`);

  return installTeamsJwksStub();
}

test("a signed Teams Activity is accepted (200) and a register-refuted author's DM is withheld with its OWN teams.external_policy_suppressed row", async () => {
  const nonce = randomBytes(6).toString("hex");
  const tenantId = `it-teams-tenant-${nonce}`;
  const authorId = `it-teams-refuted-${nonce}`;
  const jwks = await armSeams(tenantId, `it-teams-internal-${nonce}`);
  try {
    const cursor = await auditCursor();
    const res = await teamsActivityPost({ activity: dmActivity({ tenantId, authorId, conversationId: `it-teams-conv-${nonce}` }) });
    expect(res.status, `the Teams front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);

    const row = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["teams.external_policy_suppressed"]);
      return rows.find((r) => r.principalId === authorId);
    }, "the teams.external_policy_suppressed row for this refuted author");

    expect(row.platform).toBe("teams");
    expect(row.detail?.verdict).toBe("withheld-addressed");

    const dispatched = await rowsSinceCursor(cursor, ["teams.dispatched"]);
    expect(dispatched.find((r) => r.principalId === authorId)).toBeUndefined();
  } finally {
    jwks.uninstall();
  }
});

test("an UNSIGNED Teams Activity (no bearer token at all) is refused (401) and writes NO teams.external_policy_suppressed row", async () => {
  const nonce = randomBytes(6).toString("hex");
  const tenantId = `it-teams-tenant-${nonce}`;
  const authorId = `it-teams-unsigned-${nonce}`;
  const jwks = await armSeams(tenantId, `it-teams-internal-${nonce}`);
  try {
    const cursor = await auditCursor();
    const res = await teamsActivityPost({ activity: dmActivity({ tenantId, authorId, conversationId: `it-teams-conv-${nonce}` }), bearer: null });
    expect(res.status).toBe(401);

    await new Promise((r) => setTimeout(r, 500));
    const rows = await rowsSinceCursor(cursor, ["teams.external_policy_suppressed"]);
    expect(rows.find((r) => r.principalId === authorId)).toBeUndefined();
  } finally {
    jwks.uninstall();
  }
});

test("a TAMPERED Teams Activity JWT (well-formed, wrong signature) is refused (401) and writes NO row", async () => {
  const nonce = randomBytes(6).toString("hex");
  const tenantId = `it-teams-tenant-${nonce}`;
  const authorId = `it-teams-tampered-${nonce}`;
  const jwks = await armSeams(tenantId, `it-teams-internal-${nonce}`);
  try {
    const cursor = await auditCursor();
    const good = signTeamsJwt();
    const parts = good.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -4)}${parts[2]!.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    const res = await teamsActivityPost({ activity: dmActivity({ tenantId, authorId, conversationId: `it-teams-conv-${nonce}` }), bearer: tampered });
    expect(res.status).toBe(401);

    await new Promise((r) => setTimeout(r, 500));
    const rows = await rowsSinceCursor(cursor, ["teams.external_policy_suppressed"]);
    expect(rows.find((r) => r.principalId === authorId)).toBeUndefined();
  } finally {
    jwks.uninstall();
  }
});

test("a WRONG-AUDIENCE Teams Activity JWT (correctly signed, wrong `aud`) is refused (401) and writes NO row", async () => {
  const nonce = randomBytes(6).toString("hex");
  const tenantId = `it-teams-tenant-${nonce}`;
  const authorId = `it-teams-wrongaud-${nonce}`;
  const jwks = await armSeams(tenantId, `it-teams-internal-${nonce}`);
  try {
    const cursor = await auditCursor();
    const wrongAud = signTeamsJwt({ aud: "some-other-app-id" });
    const res = await teamsActivityPost({ activity: dmActivity({ tenantId, authorId, conversationId: `it-teams-conv-${nonce}` }), bearer: wrongAud });
    expect(res.status).toBe(401);

    await new Promise((r) => setTimeout(r, 500));
    const rows = await rowsSinceCursor(cursor, ["teams.external_policy_suppressed"]);
    expect(rows.find((r) => r.principalId === authorId)).toBeUndefined();
  } finally {
    jwks.uninstall();
  }
});

async function expectRefusedWithNoRow(label: string, bearer: (activity: Record<string, unknown>) => string): Promise<void> {
  const nonce = randomBytes(6).toString("hex");
  const tenantId = `it-teams-tenant-${nonce}`;
  const authorId = `it-teams-${label}-${nonce}`;
  const jwks = await armSeams(tenantId, `it-teams-internal-${nonce}`);
  try {
    const cursor = await auditCursor();
    const activity = dmActivity({ tenantId, authorId, conversationId: `it-teams-conv-${nonce}` });
    const res = await teamsActivityPost({ activity, bearer: bearer(activity) });
    expect(res.status).toBe(401);

    await new Promise((r) => setTimeout(r, 500));
    const rows = await rowsSinceCursor(cursor, ["teams.external_policy_suppressed"]);
    expect(rows.find((r) => r.principalId === authorId)).toBeUndefined();
  } finally {
    jwks.uninstall();
  }
}

test("a Teams Activity JWT with NO `serviceurl` claim (correctly signed otherwise) is refused (401) and writes NO row", async () => {
  await expectRefusedWithNoRow("noserviceurl", () => signTeamsJwt({ serviceUrl: null }));
});

test("a Teams Activity whose `serviceUrl` differs from the token's `serviceurl` claim is refused (401) and writes NO row", async () => {
  await expectRefusedWithNoRow("otherserviceurl", (activity) => {
    expect(activity.serviceUrl).toBe(TEAMS_FIXTURE_SERVICE_URL);
    return signTeamsJwt({ serviceUrl: "https://smba.trafficmanager.net/emea/" });
  });
});

// A replay inside the token lifetime gets no 401: the verifier keeps no record of seen tokens. The front
// dedupes a repeated activity id on its dispatch paths. This pin covers a token used after it expires.
test("an EXPIRED Teams Activity JWT (correctly signed, `exp` past the clock skew) is refused (401) and writes NO row", async () => {
  await expectRefusedWithNoRow("expired", () => signTeamsJwt({ expiresInSec: -600 }));
});

test("a WRONG-ISSUER Teams Activity JWT (correctly signed, wrong `iss`) is refused (401) and writes NO row", async () => {
  await expectRefusedWithNoRow("wrongiss", () => signTeamsJwt({ iss: "https://sts.windows.net/it-fixture-tenant/" }));
});
