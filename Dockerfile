FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/pi-chat/package.json apps/pi-chat/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN cd apps/pi-chat && pnpm build

ENV NODE_ENV=production
ENV PI_CHAT_HOST=127.0.0.1
ENV PI_CHAT_PORT=4328
ENV PI_CHAT_ROOT_DIR=/tmp/pi-chat
ENV RCA_INVESTIGATIONS_DIR=/tmp/pi-chat/data/rca/investigations

EXPOSE 3000

CMD ["pnpm", "--filter", "pi-chat", "start:railway"]
