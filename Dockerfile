FROM mcr.microsoft.com/playwright:v1.49.1-jammy

RUN apt-get update \
    && apt-get install -y --no-install-recommends x11vnc x11-utils unzip curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Baked into the image so a Portainer stack can deploy straight from the repo
# without anyone hand-placing the extension on the host first.
ARG EXT_ID=ibglohpjgdhkmhmfpdibjgmjjmccafmh
COPY fetch-ext.sh ./
RUN chmod +x fetch-ext.sh && EXT_ID="$EXT_ID" OUT_DIR=/ext ./fetch-ext.sh

COPY package.json ./
RUN npm install --omit=dev

COPY probe.js login-entrypoint.sh ./
RUN chmod +x login-entrypoint.sh

ENV PROFILE_DIR=/data/profile \
    EXT_DIR=/ext \
    LOG_FILE=/data/probe.jsonl \
    SHOT_DIR=/data/shots

ENTRYPOINT ["xvfb-run", "-a", "node", "probe.js"]
