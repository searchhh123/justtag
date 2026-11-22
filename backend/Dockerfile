FROM node:22-slim
# fonts for the server-rendered share cards
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
