# Security Policy

Open Everywhere is security-sensitive by nature — it runs an autonomous agent with access to your
chat tools, repositories, and connectors. We take vulnerabilities seriously and appreciate responsible
disclosure.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** A public report discloses the exploit
before there is a fix.

Instead, use **GitHub's private vulnerability reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, the impact, and a reproduction if you have one.

This opens a private advisory visible only to you and the maintainers. (Repository maintainers: enable
this under Settings → Code security and analysis → *Private vulnerability reporting*.)

We aim to acknowledge a report within **3 business days** and to provide a remediation timeline after
triage. Please give us a reasonable window to ship a fix before any public disclosure.

## Scope

In scope — issues that undermine the project's security guarantees, e.g.:

- **Sandbox / egress escape** — exfiltrating data past the default-deny egress firewall, or reading an
  injected credential from inside the sandbox (credentials are injected *at the firewall* and must never
  be visible to agent code).
- **Cross-tenant / cross-surface leakage** — one org, workspace, or surface reading or writing another's
  memory; bypassing `org_id` partitioning or Postgres RLS; a private surface's learnings reaching a shared
  tier.
- **Access-control bypass** — invoking a connector or capability a bundle did not grant; defeating the
  per-surface connector gate; privilege escalation in the admin MCP (RBAC bypass, the identity-linking
  guardrails).
- **Auth flaws** in the control plane (token validation, issuer trust, the verified-email requirement).
- **Untrusted-content injection** that escalates beyond the agent's granted scope.
- **Secret exposure** — installation tokens, signing secrets, or connector credentials leaking into logs,
  audit entries, model context, or the sandbox.

Out of scope: vulnerabilities in third-party dependencies (report upstream; tell us if we should pin or
patch), missing hardening that has no concrete exploit, and issues that require an already-compromised
host or admin credentials.

## Supported versions

Open Everywhere is pre-1.0; security fixes land on `main`. Run from a recent `main` (or a tagged release
once they exist) to stay current.

## Our side of the bargain

- **CI is fork-safe by design.** Workflows run on `pull_request` (not `pull_request_target`) and use no
  secrets, so a malicious fork PR has nothing to exfiltrate. We treat this as an invariant — see
  [CONTRIBUTING.md](./CONTRIBUTING.md).
- The deeper architecture (egress injection, connector scoping, memory isolation, audit) is documented in
  **[docs/security/security-model.md](./docs/security/security-model.md)**.
