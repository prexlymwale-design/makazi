#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE makazi_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE makazi TO makazi_app;
GRANT USAGE, CREATE ON SCHEMA public TO makazi_app;
CREATE DATABASE makazi_test OWNER makazi_app;
SQL
