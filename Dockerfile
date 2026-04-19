# ---- Build Stage ----
FROM node:20-slim AS builder

WORKDIR /app

# Dummy variable so Prisma generates the type-safe client without complaining about missing envs during Docker build
ENV DATABASE_URL="postgresql://test:test@localhost:5432/test?schema=public"

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---- Production Stage ----
FROM node:20-slim AS production

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    curl \
    postgresql \
    postgresql-contrib \
    sudo \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs justpark

COPY package*.json ./
# Dummy variable so Prisma generates the type-safe client without complaining about missing envs during Docker build in production stage
ENV DATABASE_URL="postgresql://test:test@localhost:5432/test?schema=public"
RUN npm ci --omit=dev && npm install pino-pretty

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/src/prisma ./src/prisma

COPY start.sh ./
RUN chmod +x start.sh

RUN npm rebuild bcrypt

# Running as root is required to start postgresql service inside the container easily for testing
# USER justpark

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["./start.sh"]