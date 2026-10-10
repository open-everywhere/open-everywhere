# Teams app package

The Teams app package (manifest + icons) that surfaces the agent inside Microsoft Teams. The Azure Bot resource is the *runtime* identity; this package is what a user/admin
**installs** so the bot appears in Teams. See [`docs/deploy/surfaces/teams.md`](../docs/deploy/surfaces/teams.md)
for the full runbook — this directory is just the artifact it references.

## Contents

| File | What it is |
| --- | --- |
| `manifest.json` | **Not shipped — rendered** (OPE-2334). Get it from `surface_manifest { "surface": "teams" }` and save it here. |
| `color.png` | 192×192 full-colour icon: the project mark (see [Icons](#icons)). |
| `outline.png` | 32×32 white-on-transparent outline icon: the project mark (see [Icons](#icons)). |

## Get the manifest

The manifest is rendered from your deployment's settings, so the app carries your agent's name, not
the project's. The Teams bundle owns the template (`packages/providers/teams/agent/app-manifest.ts`),
and the ops MCP tool serves it with your host substituted:

```
surface_manifest { "surface": "teams", "baseUrl": "https://<your deploy host>" }
```

The `identity.name` setting in `agent/settings/settings.ts` names the app (`name.short`,
`name.full`, `description.full`). With no name configured it is "Open Everywhere". Pass `appName`
(at most 30 characters) to override the configured name. Save the `manifest` field of the response
as `manifest.json` in this directory.

## Placeholders to fill

| Placeholder | Value |
| --- | --- |
| `{{MICROSOFT_APP_ID}}` | The Azure Bot's **Application (client) ID** (`MICROSOFT_APP_ID`). Used for both `id` and `bots[].botId` — they must match. |
| `{{DEVELOPER_NAME}}` | Your org / developer name. |

## Privacy policy and terms — served by your deployment

`privacyUrl` and `termsOfUseUrl` are **not** placeholders. They point at `/privacy` and `/terms` on
your own deploy host, and the deployment serves both. The host `surface_manifest` substitutes is all
the manifest needs — the URLs resolve.

The TEXT of both documents is yours, because both are statements about what *you* do with *your*
deployment's data. Declare them in `agent/settings/settings.ts`, the same config-in-git plane as
every other operator setting:

```ts
export const SETTINGS_OVERRIDES = defineSettings({
  policyPages: {
    privacy: "…your privacy policy…",
    terms: "…your terms of use…",
  },
});
```

Both routes answer `200` whether or not you have declared the text. Undeclared, each renders a short
page saying the operator has not published that document yet and naming the setting to declare it
in. So a sideload never breaks — but **publish real text before an org-wide admin upload**, which is
where a reviewer reads them. The text is rendered as escaped plain text with its line breaks kept,
never as HTML or markdown. See
[the configuration reference](../docs/deploy/configuration-reference.md#agent-settings-behaviour-config-as-code).

To point the two URLs at pages you host elsewhere, edit your saved `manifest.json` **and** the
template, and relax the manifest join in `scripts/teams-provider-integration-test.ts` — it asserts that `privacyUrl` and
`termsOfUseUrl` end at the two paths this deployment mounts, which is what stops the manifest and
the routes drifting apart again. Nothing else in the deployment requires the pages to be its own.

## Build the package

```bash
cd teams-app
APP_ID="<your MICROSOFT_APP_ID>"
DEV="<your org name>"

# manifest.json is the rendered manifest you saved above (its host is already substituted).
sed -e "s/{{MICROSOFT_APP_ID}}/$APP_ID/g" \
    -e "s/{{DEVELOPER_NAME}}/$DEV/g" \
    manifest.json > manifest.filled.json

# Teams wants a flat zip: manifest at the root named exactly manifest.json, plus the two icons.
cp manifest.filled.json manifest.json.tmp
zip -j open-everywhere-teams.zip manifest.json.tmp color.png outline.png
printf '@ manifest.json.tmp\n@=manifest.json\n' | zipnote -w open-everywhere-teams.zip
rm manifest.json.tmp manifest.filled.json
```

(Or just fill `manifest.json` in place and `zip -j open-everywhere-teams.zip manifest.json color.png outline.png` — the `-j` keeps it flat, which Teams requires.)

## RSC permissions

`authorization.permissions.resourceSpecific` declares three **application-context** RSC permissions:

| Permission | Grants |
| --- | --- |
| `ChannelMessage.Read.Group` | Read this **team's channel** messages — and receive *every* channel message activity, not just @mentions. |
| `ChatMessage.Read.Chat` | The chat analogue: read this **chat's** messages (group chats and the chats behind meetings), and receive every chat message activity. |
| `ChannelMember.Read.Group` | Read this **team channel's** membership list — powers the routine fire-eligibility room check (a removed creator skips a scheduled fire instead of it posting anyway). |

All three are consented by the **resource owner** at install time (a team owner for the team
scope, a chat member for the chat scope) — not by a tenant admin, and none goes through
Microsoft's Protected-API approval queue. `webApplicationInfo` must be present whenever
`authorization` is.

> ⚠️ **RSC consent is captured at install time and is NOT retroactive.** Bumping `version` and
> re-uploading to the catalog does *not* grant a newly-added permission to a team or chat that
> already has the app. Each one must **re-add** the app (or be re-installed via the Graph
> install-with-consent call) — see the [Teams runbook](../docs/deploy/surfaces/teams.md).

## Install

- **Single team / dev sandbox:** Teams client → **Apps → Manage your apps → Upload an app →
  Upload a custom app** → pick `open-everywhere-teams.zip`. (Custom-app upload must be enabled by
  the tenant admin; the M365 Developer Program sandbox has it on by default.)
- **Org-wide:** [Teams Admin Center](https://admin.teams.microsoft.com) → **Teams apps → Manage
  apps → Upload new app**.

## Icons

The shipped PNGs are the project mark, the pigeon from [`../brand/`](../brand/README.md). With no
`identity.name` configured the agent presents as the project (`DEFAULT_AGENT_DISPLAY_NAME`), so the
mark is its default avatar. Keep both files unless you set `identity.name` and chose your own icon.
In that case, replace both before any public or org-wide install.

`scripts/teams-icons-generate.ts` renders both files from the brand SVGs with a headless Chromium:
`color.png` from `brand/svg/mark-square.svg`, and `outline.png` from `brand/svg/mark-mono-paper.svg`
recoloured white. `npm run test:teams-icons` pins the shipped bytes to those masters and checks the
rules below, so regenerate the files rather than edit them by hand.

Constraints Teams enforces:

- `color.png` — **192×192**, full colour, PNG.
- `outline.png` — **32×32**, **transparent background**, single colour (white glyph on
  transparent), PNG. A non-transparent outline icon is the most common validation rejection.
