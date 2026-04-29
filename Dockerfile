# ============================================
# rw2026 + Edgetunnel Integration Dockerfile
# Multi-stage build for production
# ============================================

# Stage 1: Install dependencies
FROM node:18-alpine AS deps

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --production --no-audit --no-fund && \
    npm cache clean --force

# Stage 2: Runtime image
FROM node:18-alpine

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    FILE_PATH=/app/tmp

# Install system dependencies
RUN apk add --no-cache \
    openssl \
    curl \
    gcompat \
    iproute2 \
    coreutils \
    bash \
    unzip \
    ca-certificates \
    tzdata \
    procps && \
    update-ca-certificates

# Create non-root user
RUN addgroup -S appgroup && \
    adduser -S appuser -G appgroup && \
    mkdir -p /app/tmp && \
    chown -R appuser:appgroup /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules /app/node_modules

# Copy application code
COPY --chown=appuser:appgroup . /app

# Set working directory
WORKDIR /app

# ⭐ 关键修复：覆盖默认 entrypoint，直接使用 node
# 避免 docker-entrypoint.sh 改变工作目录导致的问题
ENTRYPOINT ["node", "/app/index_official.js"]

# Health check (使用 exec 格式，与 ENTRYPOINT 兼容)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const http=require('http');\
    const req=http.get('http://localhost:'+process.env.PORT+'/health',(r)=>{process.exit(r.statusCode===200?0:1)});\
    req.on('error',()=>process.exit(1))"

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000
