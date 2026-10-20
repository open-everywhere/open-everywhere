FROM node:24-alpine AS build
WORKDIR /app

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

COPY --from=build /app /app

ENV PORT=3000
EXPOSE 3000

CMD ["npx", "eve", "start", "--host", "0.0.0.0"]
