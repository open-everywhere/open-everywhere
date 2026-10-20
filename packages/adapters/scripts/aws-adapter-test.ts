import { makeAwsStsProvider } from "../agent/aws/sts.js";
import { makeAwsCliExecutor, type AwsExecInvocation } from "../agent/aws/cli.js";
import type { AwsCredentials, AwsIdentityRequest } from "@open-everywhere/core/agent/adapter-api.js";

delete process.env.AWS_REGION;
delete process.env.AWS_DEFAULT_REGION;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function xmlOk(expiration: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>ASIAFAKEACCESSKEY</AccessKeyId>
      <SecretAccessKey>fakeSecret/Key+Value</SecretAccessKey>
      <SessionToken>FakeSessionToken==</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::123456789012:assumed-role/oe-domain/oe-acme</Arn>
    </AssumedRoleUser>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;
}

const xmlErr = `<?xml version="1.0" encoding="UTF-8"?>
<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error>
  <RequestId>req-1</RequestId>
</ErrorResponse>`;

const domainReq: AwsIdentityRequest = {
  kind: "domain-role",
  roleArn: "arn:aws:iam::123456789012:role/oe-acme-domain",
  region: "eu-west-1",
  roleSessionName: "oe-acme",
};

{
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/oidc-token";
  delete process.env.OE_AWS_WEB_IDENTITY_TOKEN;

  const captured: { url: string; body: string }[] = [];
  let tokenReads = 0;
  const expiration = new Date(Date.now() + 3600_000).toISOString();
  const provider = makeAwsStsProvider({
    fetch: (async (url: string, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(xmlOk(expiration), { status: 200, headers: { "content-type": "text/xml" } });
    }) as typeof fetch,
    readTokenFile: (path: string) => {
      ok(path === "/var/run/secrets/oidc-token", "token reader is handed the AWS_WEB_IDENTITY_TOKEN_FILE path");
      tokenReads++;
      return "  fake-oidc-jwt-token\n";
    },
  });

  const creds: AwsCredentials = await provider.mint(domainReq);
  ok(creds.accessKeyId === "ASIAFAKEACCESSKEY", "parsed AccessKeyId");
  ok(creds.secretAccessKey === "fakeSecret/Key+Value", "parsed SecretAccessKey");
  ok(creds.sessionToken === "FakeSessionToken==", "parsed SessionToken");
  ok(creds.expiresAtMs === Date.parse(expiration), "Expiration mapped to expiresAtMs (ms)");

  ok(captured.length === 1, "exactly one STS POST for the first mint");
  ok(captured[0].url === "https://sts.eu-west-1.amazonaws.com/", "POST hits sts.<region>.amazonaws.com for the grant region");
  const form = new URLSearchParams(captured[0].body);
  ok(form.get("Action") === "AssumeRoleWithWebIdentity", "body Action=AssumeRoleWithWebIdentity");
  ok(form.get("Version") === "2011-06-15", "body carries the STS API Version");
  ok(form.get("RoleArn") === domainReq.roleArn, "body carries the RoleArn");
  ok(form.get("RoleSessionName") === "oe-acme", "body carries the RoleSessionName");
  ok(form.get("WebIdentityToken") === "fake-oidc-jwt-token", "body carries the (trimmed) WebIdentityToken from the file");
  ok(form.get("DurationSeconds") === "3600", "body requests DurationSeconds=3600");

  const creds2 = await provider.mint(domainReq);
  ok(creds2.accessKeyId === creds.accessKeyId, "second mint returns the same creds");
  ok(captured.length === 1, "warm cache: second mint inside TTL does NOT re-POST to STS");
  ok(tokenReads === 1, "warm cache: second mint does NOT re-read the token file");
}

{
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/oidc-token";
  const captured: { url: string; body: string }[] = [];
  const expiration = new Date(Date.now() + 3600_000).toISOString();
  const provider = makeAwsStsProvider({
    fetch: (async (url: string, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(xmlOk(expiration), { status: 200, headers: { "content-type": "text/xml" } });
    }) as typeof fetch,
    readTokenFile: () => "fake-oidc-jwt-token",
  });

  const reqA: AwsIdentityRequest = {
    kind: "domain-role",
    roleArn: "arn:aws:iam::123456789012:role/oe-shared-domain",
    region: "eu-west-1",
    roleSessionName: "oe-domain-a",
  };
  const reqB: AwsIdentityRequest = { ...reqA, roleSessionName: "oe-domain-b" };

  await provider.mint(reqA);
  await provider.mint(reqB);
  ok(captured.length === 2, "two requests differing ONLY in roleSessionName do NOT share a cache entry (both re-federate)");
  const formA = new URLSearchParams(captured[0].body);
  const formB = new URLSearchParams(captured[1].body);
  ok(formA.get("RoleSessionName") === "oe-domain-a", "first mint federates under its own RoleSessionName");
  ok(formB.get("RoleSessionName") === "oe-domain-b", "second mint federates under ITS OWN RoleSessionName, not the first's");

  await provider.mint(reqA);
  ok(captured.length === 2, "re-minting the FIRST identity again reuses its own warm cache entry (no third POST)");
}

{
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/oidc-token";
  const captured: { body: string }[] = [];
  const expiration = new Date(Date.now() + 3600_000).toISOString();
  const provider = makeAwsStsProvider({
    fetch: (async (_url: string, init?: RequestInit) => {
      captured.push({ body: String(init?.body ?? "") });
      return new Response(xmlOk(expiration), { status: 200, headers: { "content-type": "text/xml" } });
    }) as typeof fetch,
    readTokenFile: () => "fake-oidc-jwt-token",
  });

  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:*"], Resource: "*" }] });
  const withPolicy: AwsIdentityRequest = {
    kind: "domain-role",
    roleArn: "arn:aws:iam::123456789012:role/oe-policied",
    region: "eu-west-1",
    roleSessionName: "oe-policied",
    sessionPolicy: policy,
  };
  await provider.mint(withPolicy);
  ok(new URLSearchParams(captured[0].body).get("Policy") === policy, "session policy: a domain-role mint carries `Policy` on AssumeRoleWithWebIdentity (AWS-enforced intersection)");

  const withoutPolicy: AwsIdentityRequest = { ...withPolicy, sessionPolicy: undefined };
  await provider.mint(withoutPolicy);
  ok(captured.length === 2, "session policy: the cache key is policy-sensitive — same role+sessionName with a different policy re-federates");
  ok(new URLSearchParams(captured[1].body).get("Policy") === null, "session policy: an unrestricted grant sends NO Policy parameter");

  await provider.mint(withPolicy);
  ok(captured.length === 2, "session policy: re-minting the policied identity reuses ITS OWN cache entry");
}

{
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/no/such/token";
  delete process.env.OE_AWS_WEB_IDENTITY_TOKEN;
  let fetched = false;
  const provider = makeAwsStsProvider({
    fetch: (async () => {
      fetched = true;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    readTokenFile: () => {
      throw new Error("ENOENT: no such file");
    },
  });
  let threw = "";
  try {
    await provider.mint(domainReq);
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("unreadable"), "missing/unreadable token file fails LOUD");
  ok(!fetched, "no STS call is made when the token cannot be read");
}

{
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/oidc-token";
  const provider = makeAwsStsProvider({
    fetch: (async () => new Response(xmlErr, { status: 403, headers: { "content-type": "text/xml" } })) as typeof fetch,
    readTokenFile: () => "fake-oidc-jwt-token",
  });
  let threw = "";
  try {
    await provider.mint(domainReq);
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("STS AssumeRoleWithWebIdentity failed"), "an STS error response fails LOUD");
  ok(threw.includes("AccessDenied"), "the STS error Code is surfaced in the thrown message");
}

{
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/oidc-token";
  let ssoFetched = false;
  const provider = makeAwsStsProvider({
    fetch: (async () => {
      ssoFetched = true;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    readTokenFile: () => "fake-oidc-jwt-token",
  });
  let threw = "";
  try {
    await provider.mint({
      kind: "user-sso",
      roleArn: "arn:aws:iam::123456789012:role/oe-user",
      roleSessionName: "oe-alice",
      principalSubject: "p:acme/slack/alice",
    });
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("not configured") && threw.includes("Phase 1"), "user-sso throws the Phase-1 not-configured error");
  ok(!ssoFetched, "user-sso attempts no STS/SSO network flow");
}

{
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/oidc-token";
  let delegated: AwsIdentityRequest | undefined;
  let stsFetched = false;
  const provider = makeAwsStsProvider({
    fetch: (async () => {
      stsFetched = true;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    readTokenFile: () => "fake-oidc-jwt-token",
    mintUserSso: async (req) => {
      delegated = req;
      return { accessKeyId: "ASIASSOUSER", secretAccessKey: "s", sessionToken: "t" };
    },
  });
  const creds = await provider.mint({
    kind: "user-sso",
    roleArn: "arn:aws:iam::123456789012:role/oe-user",
    roleSessionName: "oe-alice",
    principalSubject: "p:acme/slack/alice",
  });
  ok(creds.accessKeyId === "ASIASSOUSER", "user-sso delegates to the Identity Center minter when wired");
  ok(delegated !== undefined && delegated.sessionPolicy === undefined, "🔴 the user-sso mint request carries NO session policy — the per-user path structurally cannot enforce one");
  ok(!stsFetched, "user-sso never touches the STS federation path (no Policy parameter could ride it)");
}

{
  const creds: AwsCredentials = {
    accessKeyId: "ASIACHILD",
    secretAccessKey: "childSecret",
    sessionToken: "childSession==",
    expiresAtMs: Date.now() + 3600_000,
  };
  const args = ["logs", "start-query", "--log-group-name", "/oe/app", "--query-string", "fields @message"];

  {
    process.env.DATABASE_URL = "postgres://user:SECRET@db.internal/oe";
    process.env.OE_SPAWN_DISPATCH_SECRET = "spawn-secret";
    process.env.AWS_PROFILE = "ambient-prod";
    let seen: AwsExecInvocation | undefined;
    const executor = makeAwsCliExecutor({
      run: async (inv) => {
        seen = inv;
        return { exitCode: 0, stdout: '{"queryId":"q-1"}', stderr: "" };
      },
    });
    const res = await executor.run({ credentials: creds, region: "us-west-2", args });
    delete process.env.DATABASE_URL;
    delete process.env.OE_SPAWN_DISPATCH_SECRET;
    delete process.env.AWS_PROFILE;
    ok(res.exitCode === 0 && res.stdout.includes("q-1"), "executor returns the runner's stdout + exit 0");
    ok(seen !== undefined && seen.file === "aws", "the launched binary is `aws`");
    ok(JSON.stringify(seen!.args) === JSON.stringify(args), "argv is exactly the args after `aws`");
    ok(seen!.env.AWS_ACCESS_KEY_ID === "ASIACHILD", "child env carries AWS_ACCESS_KEY_ID");
    ok(seen!.env.AWS_SECRET_ACCESS_KEY === "childSecret", "child env carries AWS_SECRET_ACCESS_KEY");
    ok(seen!.env.AWS_SESSION_TOKEN === "childSession==", "child env carries AWS_SESSION_TOKEN");
    ok(seen!.env.AWS_REGION === "us-west-2" && seen!.env.AWS_DEFAULT_REGION === "us-west-2", "child env carries the region");
    const argvBlob = seen!.args.join(" ");
    ok(!argvBlob.includes("ASIACHILD") && !argvBlob.includes("childSecret") && !argvBlob.includes("childSession"), "creds are NEVER on argv");
    ok(seen!.env.AWS_PROFILE === undefined, "ambient AWS_PROFILE never reaches the child (deny-by-default)");
    ok(seen!.env.DATABASE_URL === undefined, "🔴 the deployment's DATABASE_URL never reaches the child — deny-by-default, not strip-a-list");
    ok(seen!.env.OE_SPAWN_DISPATCH_SECRET === undefined, "🔴 OE's own dispatch secret never reaches the child");
    ok(seen!.env.PATH === process.env.PATH, "the enumerated pass-through (PATH) survives so the binary can be found");
    ok(seen!.env.AWS_CONFIG_FILE === "/dev/null" && seen!.env.AWS_SHARED_CREDENTIALS_FILE === "/dev/null", "config/credential files are pinned to /dev/null — no on-host profile is ever readable");
    ok(seen!.env.AWS_EC2_METADATA_DISABLED === "true", "IMDS lookup is disabled — the injected creds are the ONLY identity the CLI can resolve");
  }

  {
    let seen: AwsExecInvocation | undefined;
    const executor = makeAwsCliExecutor({
      run: async (inv) => {
        seen = inv;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await executor.run({ credentials: creds, args: ["sts", "get-caller-identity"] });
    ok(seen!.env.AWS_REGION === undefined && seen!.env.AWS_DEFAULT_REGION === undefined, "no region ⇒ no AWS_REGION/AWS_DEFAULT_REGION set");
  }

  {
    const executor = makeAwsCliExecutor({
      run: async () => ({ exitCode: 254, stdout: "", stderr: "An error occurred (AccessDenied)" }),
    });
    const res = await executor.run({ credentials: creds, args });
    ok(res.exitCode === 254 && res.stderr.includes("AccessDenied"), "a non-zero exit is RETURNED (not thrown) with the CLI's stderr");
  }

  {
    const executor = makeAwsCliExecutor({
      run: async () => {
        throw Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" });
      },
    });
    let threw = "";
    try {
      await executor.run({ credentials: creds, args });
    } catch (e) {
      threw = String(e);
    }
    ok(threw.includes("failed to launch the AWS CLI"), "a launch failure THROWS a clear message");
  }
}

console.log(`✓ aws-adapter: ${passed} assertions passed (STS domain-role mint + warm cache + fail-loud + user-sso refusal + CLI env/argv)`);
