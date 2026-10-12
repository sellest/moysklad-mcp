FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HTTP_PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.mjs ./docker-entrypoint.mjs
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "docker-entrypoint.mjs"]
