FROM oven/bun:1
WORKDIR /app

COPY package.json ./
RUN bun install

COPY src ./src
COPY fonts ./fonts

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
