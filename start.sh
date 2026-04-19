#!/bin/bash
set -e

echo "=== Starting PostgreSQL in Background ==="
/etc/init.d/postgresql start

echo "=== Waiting for Postgres to wake up ==="
until su - postgres -c "psql -c '\q'" > /dev/null 2>&1; do
  sleep 1
done

echo "=== Creating Database and User for Testing ==="
su - postgres -c "psql -c \"CREATE USER test_user WITH PASSWORD 'test_password';\"" || true
su - postgres -c "psql -c \"CREATE DATABASE testing_db OWNER test_user;\"" || true
su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE testing_db TO test_user;\"" || true
su - postgres -c "psql -c \"ALTER DATABASE testing_db OWNER TO test_user;\"" || true

# Export the local database URL for Prisma
export DATABASE_URL="postgresql://test_user:test_password@localhost:5432/testing_db?schema=public"
echo "DATABASE_URL forcefully set to local testing db."

echo "=== Running Prisma Migrations ==="
npx prisma migrate deploy

echo "=== Starting Up Backend ==="
node dist/server.js
