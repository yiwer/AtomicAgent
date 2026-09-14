# Control plane + explicit fixture execution; no Docker socket or model credentials.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG REVISION
LABEL org.opencontainers.image.revision=$REVISION
WORKDIR /opt/atomicagent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist/src ./dist/src
COPY dist/scripts ./dist/scripts
COPY web ./web
COPY deploy/cloud-check.mjs ./deploy/cloud-check.mjs
USER node
ENV ATOMIC_CONFIG=/run/atomicagent/config.json
CMD ["node", "dist/src/main.js"]
