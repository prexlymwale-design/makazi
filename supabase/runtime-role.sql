-- Run this in the Supabase SQL Editor after replacing the placeholder password.
-- Migration 0008 creates the role without login. Do not reuse the Supabase postgres password.
ALTER ROLE makazi_runtime
  WITH LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT CONNECT ON DATABASE postgres TO makazi_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO makazi_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO makazi_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO makazi_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO makazi_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO makazi_runtime;
