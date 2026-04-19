# ---- Build Stage ----
FROM node:20-slim AS builder

WORKDIR /app

# 1. Set the build-time dummy variable
ENV DATABASE_URL="postgresql://test:test@localhost:5432/test?schema=public"

# 2. Copy manifest files
COPY package*.json ./

# 3. CRITICAL: Copy the prisma schema BEFORE running npm ci
# This ensures the post-install hooks find the schema and the ENV variable
COPY src/prisma ./src/prisma

RUN npm ci

# 4. Explicitly generate the client to be safe
RUN npx prisma generate --schema=./src/prisma/schema.prisma

# 5. Copy the rest of the source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production Stage ----
FROM node:20-slim AS production

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    curl \
    postgresql \
    postgresql-contrib \
    sudo \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs justpark

# Set production dummy env
ENV DATABASE_URL="postgresql://test:test@localhost:5432/test?schema=public"

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm install pino-pretty

# Copy built assets and Prisma schema
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/prisma ./src/prisma

# Copy Prisma Client from builder to ensure binaries match
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Re-run generate in production stage to link everything correctly
RUN npx prisma generate --schema=./src/prisma/schema.prisma

COPY start.sh ./
RUN chmod +x start.sh

# Rebuild bcrypt for the specific OS architecture
RUN npm rebuild bcrypt

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["./start.sh"]