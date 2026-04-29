# ============================================
# rw2026 + Edgetunnel Integration Dockerfile
# ============================================

# Stage 1: 依赖安装
FROM node:18-alpine AS deps

WORKDIR /app

# 复制包管理文件
COPY package*.json ./

# 安装生产依赖（使用 install 而非 ci，兼容无 lockfile）
RUN npm install --production --no-audit --no-fund && \
    npm cache clean --force

# Stage 2: 运行时镜像
FROM node:18-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    FILE_PATH=/app/tmp

# 安装系统依赖
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

# 创建非root用户
RUN addgroup -S appgroup && \
    adduser -S appuser -G appgroup && \
    mkdir -p /app/tmp && \
    chown -R appuser:appgroup /app

# 从 deps 阶段复制 node_modules
COPY --from=deps /app/node_modules /app/node_modules

# 复制应用代码
COPY --chown=appuser:appgroup . /app

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const http=require('http');\
    const req=http.get('http://localhost:'+process.env.PORT+'/health',(r)=>{process.exit(r.statusCode===200?0:1)});\
    req.on('error',()=>process.exit(1))" || exit 1

# 切换到非root用户
USER appuser

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "index_official.js"]
