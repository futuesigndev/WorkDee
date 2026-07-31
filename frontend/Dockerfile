# =========================================================
# Frontend Dockerfile — FutureSign Next.js (Node 20 LTS)
# =========================================================

# --- Stage 1: Install deps & build ---
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Build Next.js app
# Pass build-time env vars here if needed (non-secret ones only)
ARG NEXT_PUBLIC_API_URL=http://localhost:8011
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# --- Stage 2: Production runtime ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy only what's needed for production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
 
EXPOSE 3000

CMD ["node", "server.js"]
