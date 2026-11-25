# PreVisit Desk image: web (Vite) + API (Rust) + data files in one small runtime.
# Build locally, never on the 2 GB host:
#   docker buildx build --platform linux/amd64 --load -t previsit-desk:dev .
# (deploy/build-image.ps1 wraps this and adds the tag and the checks.)
#
# Base tags verified 2026-11-25 (see DEPLOY.md, section "Base image versions"):
#   node:24-trixie-slim  rust:1.99-slim-trixie  debian:trixie-slim

# ---------------------------------------------------------------- stage 1: web
FROM node:24-trixie-slim AS web
WORKDIR /web
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
# Dependency layer: only reinstalls when the lockfile changes.
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY data/seed /data/seed
COPY data/rag /data/rag
COPY web/ ./
# i18n check + type check + vite build; output goes to /web/dist.
RUN npm run build

# ------------------------------------------------------------- stage 2: backend
FROM rust:1.99-slim-trixie AS backend
ENV CARGO_INCREMENTAL=0 \
    CARGO_TERM_COLOR=never \
    CARGO_NET_RETRY=5
# gcc and libc6-dev are already in the slim image; add the build tools that C dependencies
# (aws-lc-sys, bundled sqlite) may ask for. This stage is thrown away, so size does not matter.
# hadolint ignore=DL3008
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential cmake pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Dependency-cache layer: manifest + lockfile with a dummy main.rs. This layer is rebuilt only
# when Cargo.toml or Cargo.lock change, so source edits skip the (slow) dependency compile.
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo build --release --locked
# Real sources (src/, migrations/ for sqlx::migrate!, build.rs if any). touch main.rs so cargo
# does not mistake the dummy build for an up-to-date build of the real crate.
COPY backend/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    touch src/main.rs \
 && cargo build --release --locked \
 && strip target/release/previsit-api

# ------------------------------------------------------------- stage 3: runtime
FROM debian:trixie-slim AS runtime
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG IMAGE_VERSION=dev
LABEL org.opencontainers.image.title="previsit-desk" \
      org.opencontainers.image.description="PreVisit Desk API and web client" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${IMAGE_VERSION}"
# ca-certificates: HTTPS calls to the model API. No curl: the health check is a subcommand of the binary.
# hadolint ignore=DL3008
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 previsit \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
            --shell /usr/sbin/nologin previsit
WORKDIR /app
COPY --from=backend /build/target/release/previsit-api /app/previsit-api
COPY --from=web /web/dist /app/web
# Data files are read at start-up (rules, seed numbers, handbook, eval cases). Secrets are never copied:
# .dockerignore excludes every .env file and key/token pattern.
COPY data/seed /app/data/seed
COPY data/rag /app/data/rag
COPY data/eval /app/data/eval
COPY LICENSE NOTICE.md /app/
ENV WEB_DIR=/app/web \
    DATA_DIR=/app/data \
    BIND_ADDR=0.0.0.0:8088
USER 10001:10001
EXPOSE 8088
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/app/previsit-api", "healthcheck"]
ENTRYPOINT ["/app/previsit-api"]
CMD ["serve"]
