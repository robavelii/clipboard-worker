# ClipSync's server as an image (decisions §41): the Worker's app on Node
# (apps/server), with the web UI, serving one data volume.
#
#   docker run -d -p 8787:8787 -v clipsync:/data ghcr.io/robavelii/clipsync
#
# Options go after the image (`--trust-proxy`, `--storage <bytes>`) or in
# the environment (CLIPSYNC_ADMIN_SECRET, CLIPSYNC_TRUST_PROXY=1,
# CLIPSYNC_STORAGE_BYTES). The first device enrols with the admin secret,
# generated into /data/admin-secret unless CLIPSYNC_ADMIN_SECRET is set:
#
#   docker exec <container> cat /data/admin-secret

# The bundle is plain JavaScript, so it is built once on the builder's own
# platform and copied into each architecture's image: no emulation.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run build:server && mkdir -p -m 0700 /out/data

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="ClipSync server" \
      org.opencontainers.image.description="End-to-end encrypted clipboard sync: the server, which only ever holds ciphertext" \
      org.opencontainers.image.source="https://github.com/robavelii/clipboard-worker"
ENV NODE_ENV=production \
    CLIPSYNC_DATA=/data \
    CLIPSYNC_LISTEN=0.0.0.0:8787
# No RUN in this stage, so building it for another architecture needs no
# emulator: the data directory arrives empty, owned by the `node` user and
# private to it (0700), which Docker copies onto a new named volume. It is
# copied as an entry of /out, which keeps its mode in every BuildKit;
# `COPY --chmod` onto a directory does not (decisions §41).
COPY --from=build --chown=1000:1000 /out/ /
COPY --from=build /src/apps/server/dist /opt/clipsync
USER 1000:1000
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "const p = (process.env.CLIPSYNC_LISTEN || '').split(':').pop() || 8787; fetch('http://127.0.0.1:' + p + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/opt/clipsync/clipsync-server.mjs"]
