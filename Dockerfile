FROM node:24-alpine AS build
WORKDIR /app

# eve collects its own CLI usage telemetry, ON by default. Each `eve` command posts the command name,
# the eve version, the platform, a random installation id and a salted hash of the git remote URL or
# of the working directory to telemetry.vercel.com (docs/deploy/telemetry.md lists every key).
# Open Everywhere turns it OFF (OPE-2526). `EVE_TELEMETRY_DISABLED=1` is eve's switch, both stages set
# it, and `npm run lint:eve-telemetry` pins it. Open Everywhere's own telemetry has its own switch,
# `OE_TELEMETRY` (docs/deploy/telemetry.md).
ENV EVE_TELEMETRY_DISABLED=1

RUN apk add --no-cache git

COPY package.json package-lock.json ./
COPY patches ./patches
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/create/package.json packages/create/package.json
COPY packages/providers/discord/package.json packages/providers/discord/package.json
COPY packages/providers/github/package.json packages/providers/github/package.json
COPY packages/providers/linear/package.json packages/providers/linear/package.json
COPY packages/providers/notion/package.json packages/providers/notion/package.json
COPY packages/providers/slack/package.json packages/providers/slack/package.json
COPY packages/providers/teams/package.json packages/providers/teams/package.json

RUN npm ci --ignore-scripts \
 && npm rebuild esbuild \
 && { npm rebuild @mongodb-js/zstd \
      || echo "optional @mongodb-js/zstd did not install; just-bash has no zstd command" >&2; }

RUN npx patch-package --error-on-fail \
 && for m in $(grep -oh '__oe[A-Za-z]*Patched' patches/eve+*.patch | sort -u); do \
      grep -rqF "$m" node_modules/eve/dist || { echo "eve patch marker $m missing" >&2; exit 1; }; \
    done

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV EVE_TELEMETRY_DISABLED=1
RUN apk add --no-cache git openssh-client ca-certificates docker-cli

# 🔴 THE IMAGE RUNS justbash (OPE-2407), because it is the only template this image carries (see the
# build step), and the app declares it (`sandbox.selfHostBackend`). What each backend gives here:
#   justbash (default) — runs. Its egress leaves through this app process, so behind the egress
#     proxy (docker-compose.yml) every session request is held to the session's allow list. It
#     shares the app process's filesystem: dev and testing grade isolation, with a boot warning.
#   docker — does NOT run here. Every sandbox step refuses: "Prepared sandbox artifact … belongs
#     to provider just-bash, not docker". It would also sit outside the egress proxy (eve starts
#     the session container on the daemon's default network), so with OE_EGRESS_PROXY_URL set the
#     app refuses to boot on it.

# Copy the built app + installed deps. (Kept simple: copy the whole tree — the build
# stage already produced node_modules and .output. Trim later with a prune step if needed.)
COPY --from=build /app /app

ENV PORT=3000
EXPOSE 3000

CMD ["npx", "eve", "start", "--host", "0.0.0.0"]
