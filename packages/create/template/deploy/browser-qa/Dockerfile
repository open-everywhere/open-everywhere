FROM mcr.microsoft.com/playwright:v1.56.1-noble

RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-audit --no-fund agent-browser@0.32.4

USER pwuser
RUN agent-browser install
WORKDIR /home/pwuser

CMD ["sleep", "infinity"]
