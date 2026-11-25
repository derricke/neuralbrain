# Stage 1: Builder
FROM node:24 AS builder

WORKDIR /app

# Prevent Docker bridge IPv6 DNS connection timeouts to registry.npmjs.org
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

# Copy package manifests
COPY package.json npm-shrinkwrap.json ./

# Configure npm retry timeouts and install dependencies cleanly using BuildKit cache
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retry-mintimeout 5000 && \
    npm config set fetch-retry-maxtimeout 10000 && \
    npm ci --no-audit --no-fund --onnxruntime-node-install-cuda=skip

# Copy source code and TypeScript config
COPY . .

# Build the TypeScript project
RUN npm run build

# Prune devDependencies to keep only production modules, preserving prebuilt native binaries
RUN --mount=type=cache,target=/root/.npm \
    npm prune --production --no-audit --no-fund

# Stage 2: Runner (lean bookworm-slim reduces image size from ~1.1GB to ~220MB)
FROM node:24-bookworm-slim AS runner

ARG NEURALBRAIN_VERSION=0.1.0
LABEL org.opencontainers.image.title="neuralbrain" \
      org.opencontainers.image.version="${NEURALBRAIN_VERSION}"

WORKDIR /app

# Ensure IPv4 DNS resolution order in runtime as well
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
ENV NEURALBRAIN_VERSION=${NEURALBRAIN_VERSION}

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled source code
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Create data and cert directories for SQLite database, models, and TLS certs
RUN mkdir -p /app/data /app/data/models /app/certs
RUN chown -R node:node /app/data /app/certs

# Use non-root node user for security
USER node

# Expose the API port
EXPOSE 3000

# Set environment variables for the application
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_URL=/app/data/brain.db
ENV BRAIN_MODEL_CACHE_DIR=/app/data/models

# Healthcheck to probe the Brain service status (supports HTTP and BRAIN_HTTPS=1)
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const https=require('https'),fs=require('fs');if(process.env.BRAIN_HTTPS==='1'||process.env.BRAIN_HTTPS==='true'){const cert=process.env.BRAIN_TLS_CERT||'/app/certs/server.crt';const ca=fs.existsSync(cert)?fs.readFileSync(cert):undefined;const req=https.request({hostname:'127.0.0.1',port:3000,path:'/health',ca},r=>process.exit(r.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.end();}else{fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));}"

# Start the application directly with Node for fast startup and clean signal forwarding
CMD ["node", "dist/index.js"]
