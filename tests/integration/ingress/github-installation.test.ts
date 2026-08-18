import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { bootAgent, githubInstallationPost, readAuditRows, waitFor } from "../harness";

test("a signed GitHub App installation delivery is accepted (200) and writes surface.app_installed with the delivery's own facts", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const owner = `it-gh-owner-${nonce}`;
  const installationId = Date.now() % 1_000_000_000;
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const res = await githubInstallationPost({ action: "created", owner, installationId, accountType: "Organization" });
  expect(res.status, `the GitHub front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);

  const row = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["surface.app_installed"], sinceIso });
    return rows.find((r) => r.workspace === owner);
  }, "the surface.app_installed row for this delivery's owner");

  expect(row.platform).toBe("github");
  expect(row.detail?.installationId).toBe(String(installationId));
  expect(row.detail?.accountType).toBe("Organization");
  expect(row.detail?.action).toBe("created");
});

test("an unsigned GitHub App installation delivery is refused (401) and writes NO surface.app_installed row", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const owner = `it-gh-unsigned-${nonce}`;
  const installationId = Date.now() % 1_000_000_000;
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const res = await githubInstallationPost({ action: "created", owner, installationId, signed: false });
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await readAuditRows({ actions: ["surface.app_installed"], sinceIso });
  expect(rows.find((r) => r.workspace === owner)).toBeUndefined();
});

test("a TAMPERED GitHub App installation delivery (a wrong-but-well-formed signature) is refused (401) and writes NO row", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const owner = `it-gh-tampered-${nonce}`;
  const installationId = Date.now() % 1_000_000_000;
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const res = await githubInstallationPost({
    action: "created",
    owner,
    installationId,
    signature: "sha256=" + "0".repeat(64),
  });
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await readAuditRows({ actions: ["surface.app_installed"], sinceIso });
  expect(rows.find((r) => r.workspace === owner)).toBeUndefined();
});
