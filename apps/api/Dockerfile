FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
ENV PORT=43110
ENV MIGRATIONS_DIR=/app/apps/api/migrations
ENV BIOMETRIC_STORE_PATH=/data/templates
RUN mkdir -p /data/templates
EXPOSE 43110
CMD ["pnpm", "--filter", "@eidetic/api", "start"]
