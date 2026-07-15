FROM node:22-alpine

WORKDIR /app
COPY package.json weapi.mjs nemr.mjs ./

ENV COOKIE_FILE=/data/cookies.json \
    LOG_FILE=/data/nemr.jsonl

ENTRYPOINT ["node", "nemr.mjs"]
