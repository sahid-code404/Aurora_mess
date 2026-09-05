#!/bin/bash

set -euo pipefail

# BoardOps uses an external PostgreSQL database. Build artifacts must never copy,
# initialize, migrate, or otherwise embed a runtime database file. Database
# migrations are committed under prisma/migrations and are applied explicitly by
# the release/deployment environment with `prisma migrate deploy`.
#
# This script is retained because the platform build wrapper already invokes it;
# it now acts only as a fail-closed deployment configuration guard.

BUILD_DIR="${BUILD_DIR:?BUILD_DIR is required}"

if [ -e "$BUILD_DIR/db/custom.db" ]; then
    echo "❌ Refusing to package legacy SQLite database: $BUILD_DIR/db/custom.db"
    exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ℹ️  DATABASE_URL is not present during build; no database is packaged."
    echo "   Runtime must provide an external PostgreSQL DATABASE_URL."
    exit 0
fi

case "$DATABASE_URL" in
    postgresql://*|postgres://*)
        echo "✅ External PostgreSQL DATABASE_URL detected; no database is copied into the build artifact."
        ;;
    *)
        echo "❌ BoardOps requires PostgreSQL. Refusing non-PostgreSQL DATABASE_URL during build."
        exit 1
        ;;
esac
