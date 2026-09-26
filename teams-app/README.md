# Teams app package

The Teams app package (manifest + icons) that surfaces the Open Everywhere bot inside Microsoft
Teams. The Azure Bot resource is the *runtime* identity; this package is what a user/admin
**installs** so the bot appears in Teams. See [`docs/deploy/surfaces/teams.md`](../docs/deploy/surfaces/teams.md)
for the full runbook — this directory is just the artifact it references.

## Contents

| File | What it is |
| --- | --- |
| `manifest.json` | Teams app manifest (schema 1.17). Templated — replace the `{{…}}` placeholders. |
| `color.png` | 192×192 full-colour icon (placeholder — replace with your brand). |
| `outline.png` | 32×32 transparent, single-colour outline icon (placeholder). |

## Placeholders to fill

| Placeholder | Value |
| --- | --- |
| `{{MICROSOFT_APP_ID}}` | The Azure Bot's **Application (client) ID** (`MICROSOFT_APP_ID`). Used for both `id` and `bots[].botId` — they must match. |
| `{{DEVELOPER_NAME}}` | Your org / developer name. |
| `{{DEPLOY_DOMAIN}}` | Your deployment host, e.g. `my-agent.vercel.app`. Must match the messaging-endpoint host so it's a valid domain. |

## Privacy policy and terms — served by your deployment

`privacyUrl` and `termsOfUseUrl` are **not** placeholders. They point at `/privacy` and `/terms` on
your own `{{DEPLOY_DOMAIN}}`, and the deployment serves both. Filling `{{DEPLOY_DOMAIN}}` is all the
manifest needs — the URLs resolve.

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

To point the two URLs at pages you host elsewhere, edit `manifest.json` **and** relax the manifest
join in `packages/core/scripts/policy-pages-test.ts` §7 — it asserts that `privacyUrl` and
`termsOfUseUrl` end at the two paths this deployment mounts, which is what stops the manifest and
the routes drifting apart again. Nothing else in the deployment requires the pages to be its own.

## Build the package

```bash
cd teams-app
APP_ID="<your MICROSOFT_APP_ID>"
DOMAIN="<your deploy host, e.g. my-agent.vercel.app>"
DEV="<your org name>"

sed -e "s/{{MICROSOFT_APP_ID}}/$APP_ID/g" \
    -e "s/{{DEPLOY_DOMAIN}}/$DOMAIN/g" \
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

The shipped PNGs are placeholders (an "OE" tile). Replace with real brand assets before any
public/org-wide install. Constraints Teams enforces:

- `color.png` — **192×192**, full colour, PNG.
- `outline.png` — **32×32**, **transparent background**, single colour (white glyph on
  transparent), PNG. A non-transparent outline icon is the most common validation rejection.
