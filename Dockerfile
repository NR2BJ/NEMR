FROM node:22-alpine

WORKDIR /app
COPY package.json weapi.mjs nemr.mjs ./

# Both live in the /data volume so rotated tokens and logs survive restarts.
ENV COOKIE_FILE=/data/cookies.json \
    LOG_FILE=/data/nemr.jsonl

ENTRYPOINT ["node", "nemr.mjs"]
