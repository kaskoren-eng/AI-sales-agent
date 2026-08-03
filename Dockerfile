FROM node:20-alpine AS backend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS dashboard-builder
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=backend-builder /app/dist ./dist
COPY --from=dashboard-builder /app/dashboard/dist ./dashboard/dist
# tsc only emits .ts -> .js, so the migration .sql files and the drizzle journal are NOT in dist.
# The runtime migrator reads them from disk at dist/db/migrations, so they have to be copied
# explicitly. Miss this and the container starts, finds an empty migrations folder, and reports
# "migrations_applied" having applied nothing.
COPY --from=backend-builder /app/src/db/migrations ./dist/db/migrations
EXPOSE 3000
# Migrate, then boot. `&&` means a failed migration exits non-zero and the container never serves
# traffic against a stale schema — Railway restarts it and the deploy visibly fails, which is the
# correct outcome. Advisory-locked inside migrate.js so concurrent replicas can't race.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
