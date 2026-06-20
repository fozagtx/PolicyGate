FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/data/home

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @circle-fin/cli

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/client ./client
COPY --from=build /app/config ./config
COPY --from=build /app/package*.json ./
COPY scripts/railway-start.sh ./scripts/railway-start.sh

RUN chmod +x ./scripts/railway-start.sh \
  && mkdir -p /data/app-data /data/home

EXPOSE 8086
CMD ["./scripts/railway-start.sh"]
