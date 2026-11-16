FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY apps/admin ./apps/admin
COPY apps/reviewer/package.json ./apps/reviewer/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --frozen-lockfile
# Build-time settings. VITE_CID_ISSUER points sign-in at a Cumulus ID mirror (one that loads in Russia).
ARG VITE_CID_ISSUER=https://id.cumuluscloud.app
ARG VITE_REVENUE_URL=https://infinitum-revenue.infinitumcorp.workers.dev
ARG VITE_AMPLITUDE_API_KEY=
RUN pnpm --filter @eidetic/admin build

FROM nginx:1.27-alpine
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
