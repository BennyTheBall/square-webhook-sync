#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DB_SYNC_ENV_FILE:-$ROOT_DIR/scripts/db-sync.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy scripts/db-sync.env.example to scripts/db-sync.env and fill in the DigitalOcean database values." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

mysql_password_arg() {
  local password="$1"
  if [[ -n "$password" ]]; then
    printf -- "--password=%s" "$password"
  fi
}

require_command mysqldump
require_command mysql
require_command gzip
require_command gunzip

: "${LOCAL_DB_HOST:=mserver}"
: "${LOCAL_DB_PORT:=3306}"
: "${LOCAL_DB_USER:=root}"
: "${LOCAL_DB_PASSWORD:=}"
: "${LOCAL_DB_NAME:=Strawberry}"
: "${DO_DB_PORT:=25060}"
: "${DO_DB_USER:=doadmin}"
: "${DO_DB_NAME:=Strawberry}"
: "${DUMP_DIR:=/tmp}"
: "${KEEP_DUMP:=false}"

if [[ -z "${DO_DB_HOST:-}" || -z "${DO_DB_PASSWORD:-}" ]]; then
  echo "DO_DB_HOST and DO_DB_PASSWORD must be set in $ENV_FILE." >&2
  exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
dump_file="$DUMP_DIR/${LOCAL_DB_NAME}-${timestamp}.sql.gz"

cleanup() {
  if [[ "${KEEP_DUMP}" != "true" && -f "$dump_file" ]]; then
    rm -f "$dump_file"
  fi
}
trap cleanup EXIT

local_password_arg="$(mysql_password_arg "$LOCAL_DB_PASSWORD")"
do_password_arg="$(mysql_password_arg "$DO_DB_PASSWORD")"

echo "Dumping ${LOCAL_DB_NAME} from ${LOCAL_DB_HOST}..."
mysqldump \
  --host="$LOCAL_DB_HOST" \
  --port="$LOCAL_DB_PORT" \
  --user="$LOCAL_DB_USER" \
  ${local_password_arg:+"$local_password_arg"} \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --add-drop-table \
  --no-tablespaces \
  "$LOCAL_DB_NAME" | gzip -c > "$dump_file"

echo "Importing into DigitalOcean MySQL ${DO_DB_NAME}..."
gunzip -c "$dump_file" | mysql \
  --host="$DO_DB_HOST" \
  --port="$DO_DB_PORT" \
  --user="$DO_DB_USER" \
  ${do_password_arg:+"$do_password_arg"} \
  --ssl-mode=REQUIRED \
  "$DO_DB_NAME"

echo "Ensuring webhook support tables exist..."
mysql \
  --host="$DO_DB_HOST" \
  --port="$DO_DB_PORT" \
  --user="$DO_DB_USER" \
  ${do_password_arg:+"$do_password_arg"} \
  --ssl-mode=REQUIRED \
  "$DO_DB_NAME" < "$ROOT_DIR/sql/schema.sql"

echo "Database sync complete."
