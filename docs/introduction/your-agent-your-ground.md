# Your agent, your ground

Open Everywhere is an AI teammate you run yourself. You choose where the memory, the logs, the
keys and the config live. You hold the gateway setting, and you choose where the models run.

Each claim on this page links to the page that backs it. That page names the file that makes the
claim true and the gate that proves it. The full map is
[Sovereignty: where your data lives](../security/sovereignty.md).

## What you hold

- **Memory, the audit log and the credentials** live in the Postgres database you choose, at your
  `DATABASE_URL`. The credentials are AES-256-GCM ciphertext. The key,
  `OE_CREDENTIAL_ENCRYPTION_KEY`, is in your deployment's own environment (on Vercel, the Vercel
  project environment).
  [The data map](../security/sovereignty.md#the-data-map)
- **Config lives in your own Git repository.** Behaviour is typed files under `agent/**`, and it
  changes by a pull request. The environment holds infrastructure only.
  [Config-as-code](../how-it-works/config-as-code.md)
- **No Open Everywhere vendor runs your deployment.** Open Everywhere is self-hosted software, not
  a hosted service, so no Open Everywhere vendor holds your data.
  [The claim, in layers](../security/sovereignty.md#the-claim-in-layers)

## What you choose

- **The model family is one settings line.** `models.stack` picks the model for all five roles.
  Three stacks ship: `american-closed` (the default), `chinese-open-weights` and
  `european-open-weights`. [The model is one config line](../security/sovereignty.md#the-model-is-one-config-line)
- **The model calls go to the targets you name.** Each call through the model adapter goes to a
  target in `models.targets`. A target's `url` points its calls at a gateway you run. A target's
  `providers.only` names the only providers that may serve a call through it. A transcription
  route can call its own host directly, and the report names it.
  [Models & the AI Gateway](../extending/models-and-gateway.md)
- **A data policy sets the terms of each model call through the adapter.** `models.dataPolicy` demands zero retention,
  no training, or an EU or US inference region, on every call through the model adapter. A call
  that no provider can serve under the policy fails. It never falls back.
  [The data policy](../security/sovereignty.md#the-data-policy-demands-terms-of-every-model-call-through-the-adapter)

## The three questions we hear

- **"What if our models are restricted?"** Change `models.stack` in one line. Or point a target's
  `url` at a gateway that serves the models you can still use. Every shipped stack runs through
  an AI Gateway-compatible endpoint. A direct transcription route does not move with the gateway.
  A backend that is not AI Gateway-compatible needs its own model adapter, which is a code change.
  [The three questions](../security/sovereignty.md#the-three-questions-buyers-ask)
- **"Will a vendor train on our data?"** No Open Everywhere vendor receives your data. The
  anonymous usage telemetry is on by default, carries no content, and `OE_TELEMETRY=off` turns it
  off. The model provider receives each prompt it serves. Your data policy states the terms that a
  provider must accept to serve a call. [Telemetry](../deploy/telemetry.md)
- **"Is it sovereign?"** It is as sovereign as where you host it and which providers you pick. Run
  `npx oe sovereignty`. For each piece of your data, it prints where the data lives, in which
  region, and which company could be compelled to hand it over.
  [The report for your deployment](../security/sovereignty.md#the-report-for-your-deployment)

## The controls behind the claim

- **A kill switch.** `/oe stop` stops a turn. The break-glass halt stops every consequential act.
  Monthly caps per channel and per workspace refuse a turn over budget. A cap is a cost guard, not
  a security boundary.
  [The kill switch](../security/sovereignty.md#the-kill-switch-stop-halt-and-spend-limits)
- **Default-deny egress** for the sandbox that the model drives. The policy denies every host
  that it does not allow. The enforcement depends on the host, the backend and your settings, and
  some settings run a session with no firewall. The linked section names each case. Credentials
  stay out of the sandbox, with two recorded exceptions.
  [Compliance by construction](../security/compliance-by-construction.md#egress-is-default-deny-and-credentials-stay-out-of-the-sandbox--with-two-recorded-exceptions)
- **A hash-chained audit log** that you can stream to your SIEM with `auditExport.targets`.
  [Audit & provenance](../security/audit-and-provenance.md)
- **Config in Git, with upgrades you opt into.** A release changes your deployment only when you
  upgrade and deploy.
  [Config lives in Git](../security/sovereignty.md#config-lives-in-git-and-upgrades-are-opt-in)
- **A mapping to the OWASP Top 10 for Agentic Applications**, with the gaps stated.
  [The OWASP mapping](../security/owasp-agentic-top-10.md)
- **A way out.** `oe export`, `oe erase` and `oe transcript delete` take your data out or delete
  it. [Exit and your data](../security/exit-and-your-data.md)

## The limits, stated plainly

- **The model provider sees each prompt it serves.** The data policy demands terms. It cannot
  verify that a provider keeps them.
- **The chat platform keeps the messages** that people send there.
- **On Vercel, Vercel runs your compute and holds your transcripts, your runtime logs and the
  credential key.** The project environment also holds `DATABASE_URL`, so Vercel alone can reach
  both the key and the ciphertext. Self-hosted, these stay on your own host.
- **A region pin moves where the data is processed, not who operates the service.** A company can
  be compelled under the law of each country it operates in.
- **Open Everywhere holds no certification.**

[Sovereignty § Limits](../security/sovereignty.md#limits) states each limit in full.
