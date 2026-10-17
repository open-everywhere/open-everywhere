FROM node:24-alpine AS build
WORKDIR /app

# eve collects its own CLI usage telemetry, ON by default. Each `eve` command posts the command name,
# the eve version, the platform, a random installation id and a salted hash of the git remote URL or
# of the working directory to telemetry.vercel.com. This image turns it OFF:
# `EVE_TELEMETRY_DISABLED=1` is eve's switch, and both stages set it. Open Everywhere's own telemetry
# has its own switch, `OE_TELEMETRY` (see README.md § Telemetry).
ENV EVE_TELEMETRY_DISABLED=1

RUN apk add --no-cache git

COPY package.json package-lock.json ./
RUN npm ci \
 && node --input-type=module -e 'const { probeEvePatch } = await import("@open-everywhere/core/agent/access/eve-patch-probe.js"); const r = await probeEvePatch(); if (r.status !== "patched") { console.error(`eve patch probe: ${r.status}`); process.exit(1); }'

COPY . .
RUN NODE_OPTIONS=--max-old-space-size=6144 npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV EVE_TELEMETRY_DISABLED=1
RUN apk add --no-cache git openssh-client ca-certificates

COPY --from=build /app /app

ENV PORT=3000
EXPOSE 3000

CMD ["npx", "eve", "start", "--host", "0.0.0.0"]
