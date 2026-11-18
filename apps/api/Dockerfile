FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
ENV PORT=43110
ENV MIGRATIONS_DIR=/app/apps/api/migrations
ENV BIOMETRIC_STORE_PATH=/data/templates
RUN mkdir -p /data/templates
EXPOSE 43110
# /v1/health answers 503 when the database is down, so the container reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||43110)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "--filter", "@eidetic/api", "start"]
