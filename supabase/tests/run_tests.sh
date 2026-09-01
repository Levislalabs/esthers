#!/usr/bin/env bash
#
# Run the chat security tests against a throwaway PostgreSQL database.
#
# Nothing here touches the real Supabase project. The script starts a local
# cluster in a temporary directory, applies the shim and then the two real
# migrations, runs the tests, and throws the whole thing away.
#
#   ./supabase/tests/run_tests.sh
#
# Requires the postgresql server binaries (initdb, pg_ctl, psql). On Debian
# or Ubuntu: apt-get install postgresql-16
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/var/tmp/esthers-chat-test-pg}"
PGPORT="${PGPORT:-55432}"
PGHOST="${PGHOST:-/var/tmp}"
DBNAME="chat_test_$$"

export PATH="$PGBIN:$PATH"

cleanup() {
  psql -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres \
       -c "drop database if exists \"$DBNAME\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Start a cluster only if one is not already listening.
if ! pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
  echo "starting a temporary PostgreSQL cluster in $PGDATA"
  rm -rf "$PGDATA"
  mkdir -p "$PGDATA"
  if id postgres >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
    su postgres -c "PATH=$PGBIN:\$PATH initdb -D '$PGDATA' -A trust -U postgres" >/dev/null
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D '$PGDATA' -o '-p $PGPORT -k $PGHOST' -l '$PGDATA/server.log' start" >/dev/null
  else
    initdb -D "$PGDATA" -A trust -U postgres >/dev/null
    pg_ctl -D "$PGDATA" -o "-p $PGPORT -k $PGHOST" -l "$PGDATA/server.log" start >/dev/null
  fi
  sleep 2
fi

echo "creating database $DBNAME"
psql -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -q \
     -c "create database \"$DBNAME\";"

PSQL=(psql -h "$PGHOST" -p "$PGPORT" -U postgres -d "$DBNAME" -v ON_ERROR_STOP=1 -q)

echo "applying the Supabase shim (test harness only)"
"${PSQL[@]}" -f "$HERE/supabase_shim.sql"

echo "applying migrations"
for f in "$REPO"/supabase/migrations/*.sql; do
  echo "  $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done

echo
echo "running security tests"
echo "----------------------------------------------------------------"
"${PSQL[@]}" -f "$HERE/rls_test.sql" 2>&1 | sed 's/^psql:.*NOTICE:  //'
echo "----------------------------------------------------------------"
echo "done"
