FROM node:24-bookworm-slim

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    JIJI_HEADLESS=true \
    JIJI_CHROMIUM_PATH=/usr/bin/chromium \
    JIJI_BROWSER_CHANNEL= \
    JIJI_CHROMIUM_NO_SANDBOX=1 \
    JIJI_BIND_HOST=127.0.0.1 \
    JIJI_MCP_SOCKET=/data/bridge.sock \
    JIJI_IDENTITY_FILE=/data/relay-identity.json \
    HOME=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 950 jiji \
    && useradd --system --uid 950 --gid 950 --home-dir /tmp --shell /usr/sbin/nologin jiji

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY deploy/entrypoint.sh /entrypoint.sh
COPY deploy/credential-helper.mjs /usr/local/bin/jiji-credential-helper
COPY deploy/vnc-password.mjs /usr/local/bin/jiji-vnc-password
RUN chmod 0555 /entrypoint.sh /usr/local/bin/jiji-credential-helper /usr/local/bin/jiji-vnc-password

USER 950:950
VOLUME /data
ENTRYPOINT ["/entrypoint.sh"]
