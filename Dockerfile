# syntax=docker/dockerfile:1.7

# ─── builder ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

# ─── runner ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

# fonts-noto-core: includes Noto Sans Devanagari (Hindi). fontconfig: provides
# fc-cache so Pango/librsvg (via sharp's libvips) can resolve the font when
# rendering the report-card SVG → PNG. libatomic1: required by sharp's
# prebuilt libvips on Debian slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         fonts-noto-core \
         fontconfig \
         libatomic1 \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

CMD ["npm", "run", "start:prod"]
