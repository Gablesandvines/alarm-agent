# ============================================================
# 闹钟 Agent — 生产镜像
# 仅打包运行所需：server.js / nlu.js / 静态资源 + web-push 依赖
# 构建上下文（context）为项目根目录（见 docker-compose.yml 的 context: ..）
# ============================================================
FROM node:22-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package*.json ./
RUN npm install --omit=dev

# 再复制源码（node_modules / data 已被 .dockerignore 排除）
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
