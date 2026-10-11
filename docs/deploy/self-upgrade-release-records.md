# Self-upgrade: the per-release migration record

Open Everywhere ships upgrade expertise as data, in the repo, next to the code it describes. Each
record answers four questions about one release:

1. **What changed** — the change set, classified by upgrade unit.
2. **What a deployer must do** — declared migration steps, beyond "bump the number".
3. **How to verify** — which existing acceptance rung proves the new version is healthy.
4. **How to roll back** — usually one command; a record says so explicitly when it is not.

This is the format piece of the self-upgrade design (OPE-377, OPE-993). It authorizes nothing and
gates nothing: it is new files plus a validator, so an agent — or a maintainer running the
eve upgrade check by hand today — has
something structured to reason over instead of a changelog written in prose.

## Where records live

```
releases/<sha>/migration.json
```

`<sha>` is the full 40-character commit sha the record describes — the same identity
[`agent_version`](../capabilities/self-documentation.md) and `/oe status` already report as
`deploymentSha` (OPE-991). Keying by commit sha, not a semantic version, matches how an operator's
fork tracks a commit range. The format can also serve an npm-package upgrade unit — see
`previousSha` below.

A record is a **contract with a machine**, not a changelog for a human. Every field is either a
typed enum, a structured object, or a reference to something that already exists (an npm script
name) — nothing here is free prose a reader has to parse for meaning.

## The shape

```jsonc
{
  "formatVersion": 1,
  "sha": "1111111111111111111111111111111111111111",
  "previousSha": "0000000000000000000000000000000000000000",
  "date": "2026-08-22",
  "summary": "eve framework pin 0.39.3 -> 0.44.0.",
  "changes": [
    { "unit": "evePin", "summary": "eve framework pin 0.39.3 -> 0.44.0.", "derived": true }
  ],
  "migrations": [
    {
      "id": "rotate-windows-after-eve-bump",
      "unit": "evePin",
      "required": true,
      "backwardsCompatible": true,
      "description": "Rotate every seat window. An eve version bump changes the runtime under every open window; rotation rows are per seat, never per surface.",
      "derived": true
    }
  ],
  "verify": ["deploy:verify", "deploy:census", "deploy:smoke"],
  "rollback": { "command": "rollback" }
}
```

- **`changes[].unit`** and **`migrations[].unit`** are one of four upgrade units: `config`
  (grants, roster, env — always declared by hand), `oeVersion` (the OE package version),
  `evePin` (the eve framework dependency), `provider` (a new `packages/providers/*` package).
- **`derived: true`** marks a field the generator computed from a git diff; `derived: false` marks
  something a maintainer typed. Both live in the same arrays — a record can carry both kinds.
- **`migrations[].backwardsCompatible: false`** means rolling the deployment back does **not**
  undo this step by itself. When any migration says that, `rollback.notes` is required and must
  say what else undoing it needs — otherwise a rollback is silently assumed free, which is the
  wrong default for anything that touched persisted state.
- **`verify`** and **`rollback.command`** are npm script names (no `npm run` prefix), checked
  against this repo's own `package.json` — see [Rollback, verify, record](./rollback.md) for what
  each one proves. The default floor for every release is all three: `deploy:verify`,
  `deploy:census`, `deploy:smoke`.
- **`previousSha`** is the sha this record's diff was computed *from*. It does not have to name
  another record's `sha` — the very first record a maintainer ships has nothing to chain to, by
  definition, and a future npm-published record may chain against a published version's commit
  rather than a sibling record. `null` means "the first record ever shipped".

## Generating a record

```
npm run release-record:generate -- --to <sha> [--from <sha>]
```

A **maintainer tool, run locally**, never on a gate — it shells out to `git show <sha>:<path>` for
an arbitrary historical commit, which needs full git history. A proof run works from a fresh clone
that may be shallow, so this would fail there for any commit but `HEAD`.

`--to` defaults to `HEAD`. `--from` defaults to the most recent existing record's sha. Pass it
explicitly for your first record, because the example record's placeholder sha is not a commit.
Pass it also to diff an arbitrary earlier point.

**Derived automatically**, per file diff: the OE package version, the eve framework pin (checked
across all ten mirrored `package.json` files — the generator refuses to guess if they disagree),
and any new `packages/providers/*` package. An eve pin change always gets the window-rotation
migration attached — not a heuristic, every eve bump in this repo's history has needed it.

**Never invented**: the `config` unit. A new required env name, a new credential row the census
will demand, a roster regeneration — none of that is a clean file diff the generator can read
without also re-running the deployed-state census against two hypothetical trees, so it does not
try. Add `config`-unit changes and migrations to the written JSON by hand, before committing.
Re-running the generator against an existing record preserves anything hand-added (`derived:
false` entries, and the `summary`/`rollback` fields once the file exists) and only refreshes the
derived entries.

## Validating

```
npm run lint:release-records
```

Runs in the root `test:chain`. It never shells out to git and never reads a historical commit —
only what is on disk in the current checkout, which is what keeps it valid inside a proof run's
possibly-shallow clone. It checks:

- every record parses against the schema (`scripts/release-record/schema.ts`);
- a record's `sha` matches its own directory name;
- every `verify` entry and the `rollback.command` name a real npm script;
- an `evePin` change is never shipped without a window-rotation migration;
- a non-backwards-compatible migration is never shipped without `rollback.notes`.

## Consuming a record

`scripts/release-record/context.ts#buildUpgradeContext(records, fromSha, toSha?)` walks the
record chain forward from a starting sha (an agent's own `deploymentSha`, from `agent_version` or
`/oe status`) and returns one aggregated answer: every change, every migration, the union of
verify rungs, and the last hop's rollback. It never throws for "no known continuation" — that is
the expected, honest answer when nothing newer is known yet. It throws only when two records
claim to continue from the same commit (an unresolvable fork a maintainer shipped by mistake).

This is the function a future self-upgrade routine calls to turn "here is the version I am
running" into "here is what changed and what I need to do". The routine itself (OPE-377's S4) is
still later work; this record format is what it reads.

The guardrail that stops an "upgrade" pull request from editing the access plane already ships —
see [The upgrade diff fence](../security/self-upgrade-fence.md). It refuses every diff that touches
a protected path, whoever authored it, so an upgrade that reaches into the access plane merges only
on an explicit review-and-override.
