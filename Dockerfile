FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript && npx tsc -p tsconfig.json && npm prune --omit=dev

ENV DATA_DIR=/data
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
