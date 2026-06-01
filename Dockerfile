FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

COPY src ./src
COPY fonts ./fonts
COPY public ./public
COPY config ./config

# Chain-agnostic image. Set IQ_CHAIN=solana|evm (+ the matching network vars)
# at runtime via env / k8s secret. Defaults to solana.
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
