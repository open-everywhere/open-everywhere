FROM node:24-alpine AS build
WORKDIR /app

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

# Bring in the source and build. VERCEL is unset here → `eve build` emits a Nitro
# node-server bundle (.output/server/index.mjs), the portable off-Vercel artifact.
# `npm run build` runs `prebuild` (`oe:build` = `build:packages` + `oe build`), then `eve build`
# with a 6 GB Node heap, then `postbuild` (the bundle checks).
# 🔴 The builder needs about 6 GB of memory. `eve build` peaks at about 5.4 GB (OPE-1661). A smaller
# Node heap does not bring it under 4 GB: under a 4 GB limit the kernel killed the build inside
# `eve build` with a 3 GB heap and again with a 1.5 GB heap (OPE-2187).
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git/openssh for real git operations; `docker-cli` so the default docker() sandbox backend
# can spawn its sibling per-session containers through a MOUNTED daemon socket (DooD — see
# docker-compose.yml's `/var/run/docker.sock` line). Without the CLI eve's boot-time template
# init fails `spawn docker ENOENT` and the container exits. ca-certificates for TLS egress.
RUN apk add --no-cache git openssh-client ca-certificates docker-cli

# Copy the built app + installed deps. (Kept simple: copy the whole tree — the build
# stage already produced node_modules and .output. Trim later with a prune step if needed.)
COPY --from=build /app /app

ENV PORT=3000
EXPOSE 3000

CMD ["npx", "eve", "start", "--host", "0.0.0.0"]
