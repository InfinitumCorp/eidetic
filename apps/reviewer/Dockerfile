FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY apps/reviewer ./apps/reviewer
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @eidetic/reviewer build

FROM nginx:1.27-alpine
COPY apps/reviewer/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/reviewer/dist /usr/share/nginx/html
EXPOSE 80
