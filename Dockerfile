# FIX-18：无头（headless）代理镜像。
#
# 只安装运行 CLI 代理所需的依赖，不安装 Electron，因此镜像远小于桌面产物，
# 可以在没有图形会话的 Linux 容器 / K8s 里直接跑「本地优先」的网关。
#
# 构建（仓库根目录）：
#   docker build -t contextgate:latest .
# 运行：
#   docker run --rm -p 127.0.0.1:12306:12306 \
#     -v "${PWD}/config.yaml:/config/config.yaml:ro" \
#     -v "${PWD}:/workspace:ro" \
#     -e OPENAI_API_KEY=sk-... \
#     contextgate:latest

FROM node:20-bookworm-slim AS deps
WORKDIR /build
COPY app/gui-js/package.json app/gui-js/package-lock.json ./
# 只装运行时依赖；--ignore-scripts 避免在构建阶段执行与桌面相关的安装脚本
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-bookworm-slim
ENV NODE_ENV=production
ENV CONTEXTGATE_HEADLESS=1
WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY app/gui-js/ ./
# 桌面产物、测试与本地缓存都不进镜像
RUN rm -rf dist test docs scripts .npm-cache .electron-cache .electron-builder-cache build
# 非 root 运行；/workspace 可写（若要只读挂载项目，请用 -o /tmp/full_context.txt）
# /data 存放统计库、缓存与请求日志——即使项目目录是只读挂载也能正常工作
ENV CONTEXTGATE_DATA_DIR=/data
RUN mkdir -p /workspace /config /data && chown -R node:node /workspace /config /data
USER node
EXPOSE 12306
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:12306/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "/app/cli.js"]
CMD ["serve", "/workspace", "--host", "0.0.0.0", "--port", "12306", "-c", "/config/config.yaml", "-o", "/tmp/full_context.txt"]
