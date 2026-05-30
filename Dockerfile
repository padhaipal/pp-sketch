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

# PG_MAJOR: must match prod Postgres major version exactly. Drives the
# pg_dump/pg_restore binaries used by the staging-mirror processor. Override at
# build time: `docker build --build-arg PG_MAJOR=16 ...`. Default 15 matches
# Debian Bookworm's repo; for 16/17 the PGDG repo is added below.
ARG PG_MAJOR=18

# fonts-noto-core: includes Noto Sans Devanagari (Hindi). fontconfig: provides
# fc-cache so Pango/librsvg (via sharp's libvips) can resolve the font when
# rendering the report-card SVG → PNG. libatomic1: required by sharp's
# prebuilt libvips on Debian slim. postgresql-client-${PG_MAJOR}: pg_dump /
# pg_restore for the staging-mirror job.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates \
         curl \
         gnupg \
         fonts-noto-core \
         fontconfig \
         libatomic1 \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         "postgresql-client-${PG_MAJOR}" \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

# Sharp ships a bundled fontconfig (separate from system) that silently fails
# to parse Debian's /etc/fonts/fonts.conf, so it falls back to compile-time
# defaults that don't see /usr/share/fonts → Devanagari renders as tofu.
# Point sharp at a minimal DOCTYPE-less fonts.conf that just lists the system
# font dir.
RUN mkdir -p /etc/sharp-fonts \
    && printf '<?xml version="1.0"?>\n<fontconfig><dir>/usr/share/fonts</dir><cachedir>/var/cache/sharp-fc</cachedir></fontconfig>\n' > /etc/sharp-fonts/fonts.conf
ENV FONTCONFIG_PATH=/etc/sharp-fonts

# NODE_ENV deliberately NOT pinned here. Must be set explicitly per Railway
# service so prod/staging diverge cleanly (the staging-mirror module gates on
# NODE_ENV !== 'production').

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
# post-mirror.sql is read by MirrorProcessor at runtime via ../../sql/...
COPY --from=builder /app/sql ./sql

CMD ["npm", "run", "start:prod"]
