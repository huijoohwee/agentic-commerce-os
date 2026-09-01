FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS node-runtime

FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe

# The authored checks require Node's stable TypeScript stripping, while the Sandbox base
# currently ships Node 20. The copied runtime is an exact, multi-architecture OCI input.
COPY --from=node-runtime /usr/local/ /usr/local/

# Keep the browser outside uploaded source and npm state. Playwright resolves this exact
# location during the two receipt lanes; credentials and signing material never enter it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes --package=playwright@1.62.1 playwright install --with-deps chromium \
  && rm -rf /root/.npm /var/lib/apt/lists/*

# The Sandbox base owns the entrypoint; only the documented preview port is declared.
EXPOSE 8080
