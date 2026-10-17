FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /opt/oe-meeting-bot
COPY package.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund
COPY bot.mjs callback.js cut-rule.js speakers.js capture.js discord.mjs discord-voice.js ./

USER pwuser

CMD ["node", "/opt/oe-meeting-bot/bot.mjs"]
