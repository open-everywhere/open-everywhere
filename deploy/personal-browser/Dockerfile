FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /opt/oe-personal-browser
COPY package.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund
COPY box.mjs fence.mjs teach.mjs never.mjs ./

RUN mkdir -p /profile && chown pwuser:pwuser /profile

USER pwuser
EXPOSE 8080

CMD ["node", "/opt/oe-personal-browser/box.mjs"]
