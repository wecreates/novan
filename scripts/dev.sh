#!/usr/bin/env bash
set -e

echo "Starting ops-platform development stack..."

# Copy env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# Start infrastructure
docker compose up -d postgres redis
echo "Waiting for postgres and redis..."
sleep 3

# Install deps
pnpm install

# Run migrations
cd packages/db && pnpm db:migrate && cd ../..

# Start all services in parallel
pnpm turbo dev --parallel
