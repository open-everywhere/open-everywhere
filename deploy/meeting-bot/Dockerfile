# Open Everywhere meeting bot (OPE-2459) — one meeting per box. The image is the bot; OE starts it through
# its own sandbox backend: a Vercel Sandbox on the hosted stack, a docker container on the self-host stack.
# The Playwright base carries Chromium and its system libraries, so a box needs no install at start.
# See deploy/meeting-bot/README.md.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /opt/oe-meeting-bot
COPY package.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund
COPY bot.mjs cut-rule.js speakers.js capture.js ./

USER pwuser

CMD ["node", "/opt/oe-meeting-bot/bot.mjs"]
