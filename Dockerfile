# Fairquery EDGAR stdio MCP — build context = repository root
# Used by Glama (glama.ai) to build and inspect the server. Apify Actor Dockerfile lives in .actor/Dockerfile.
FROM node:22-alpine AS builder
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json* ./
RUN npm install --omit=optional
COPY mcp/tsconfig.json ./
COPY mcp/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY mcp/package.json mcp/package-lock.json* ./
RUN npm install --omit=dev --omit=optional \
    && rm -rf /root/.npm
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
