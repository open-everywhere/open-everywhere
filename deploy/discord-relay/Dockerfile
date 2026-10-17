FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js proof-log.js voice.js ./

CMD ["node", "index.js"]
