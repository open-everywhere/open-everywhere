# CLAUDE.md

**Read [`AGENTS.md`](./AGENTS.md) first — it is the canonical agent/contributor guide** (repo
layout, setup, build/test/deploy, extension workflow, conventions, and what must never be
committed). This file only adds Claude Code-specific notes; everything substantive lives in
AGENTS.md and the [`docs/`](./docs/README.md) manual. Keep it that way — don't duplicate here.

## Write in Simplified Technical English (ASD-STE100)

**Applies to everything you write for a human to read** — chat replies, read-outs, reports, ticket
bodies, commit messages, and the prose in docs and skills. It is the house style, not a mode.

The rules that carry:

- **One idea per sentence.** Keep sentences short: about 20 words for an instruction, 25 for a
  description. Split a long sentence; do not join two with a semicolon.
- **Active voice.** "The gate refuses the call", not "the call is refused by the gate".
- **Present tense** where the meaning allows.
- 🔴 **One word, one meaning.** Use the same word for the same thing every time. Never vary a term
  for elegance — "seat", "parent", "conversational agent" for one concept is how a wrong claim
  survives review. Technical names from the project glossary are the approved vocabulary; use them
  exactly, and use nothing else for those concepts.
- **Say the thing.** Prefer a concrete verb to a vague one. Cut intensifiers ("really", "quite",
  "very"), throat-clearing, and hedges that carry no information. A hedge that carries real
  uncertainty stays — say what is unproven and why.
- **Short paragraphs**, about six sentences at most.
- Avoid `-ing` forms where a simple verb works. Keep the articles ("the", "a").

**What STE does not forbid**, so do not strip it out: a recommendation, a judgement, a stated
uncertainty, or a comparison. STE governs *how* you write a sentence, not *what* you are allowed to
say. Precision is the goal; terseness is only the usual side effect.

## Claude Code notes

- **Private, uncommitted instructions go in `CLAUDE.local.md`** (repo root, gitignored). Put
  operator/machine-specific rules — a personal Vercel scope, local ops shortcuts — there, never
  in this committed file.
- **This repo is open source and public.** Treat every commit as public forever. Never write
  secrets, tokens, `.env` values, credential blobs, or personal/DM/memory data into any tracked
  file or commit. See the security section of AGENTS.md.
- **Node 24.x** is required (`nvm use 24`). Before deploying, run `npm run build` and confirm it's
  green — and remember **`git push` does not deploy** (deploy is a separate explicit Vercel step).
- **There is no CI yet.** A pull request is proved by its own gates: `typecheck:all`, `test`,
  `build` and `test:integration`. Run all four on the head you push. A maintainer re-runs them
  before merge. See AGENTS.md § Build / test / typecheck.
- The repo ships an ops MCP server (`open-everywhere-ops`, see `.mcp.json`) and a
  `quickstart-open-everywhere` skill for standing up an instance — use them for setup/deploy flows.
