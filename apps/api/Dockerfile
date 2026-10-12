FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp-server/package.json apps/mcp-server/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/rag/package.json packages/rag/package.json
COPY packages/investigator/package.json packages/investigator/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@voiceops/api --workspace=@voiceops/mcp-server --workspace=@voiceops/db --workspace=@voiceops/rag --workspace=@voiceops/investigator

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./package.json
COPY dist/apps/api/src ./dist/apps/api/src
COPY dist/apps/mcp-server/src ./dist/apps/mcp-server/src
COPY dist/packages/db/src/pool.js ./dist/packages/db/src/pool.js
COPY dist/packages/rag/src ./dist/packages/rag/src
COPY dist/packages/investigator/src ./dist/packages/investigator/src
COPY dist/web ./dist/web
COPY data/embedding-model.json ./data/embedding-model.json
USER node
EXPOSE 3001
CMD ["node", "dist/apps/api/src/server.js"]
