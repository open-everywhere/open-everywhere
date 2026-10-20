FROM node:24-alpine AS build
WORKDIR /app

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
