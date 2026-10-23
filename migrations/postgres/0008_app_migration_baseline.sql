-- Keep Supabase's migration history and Makazi's startup migration tracker aligned.
-- The custom role has no login until a password is set through Supabase SQL Editor.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'makazi_runtime')
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname = current_user AND rolcreaterole
     ) THEN
    EXECUTE 'CREATE ROLE makazi_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

INSERT INTO public.schema_migrations(version) VALUES
  ('0000_functions.sql'),
  ('0001_initial.sql'),
  ('0002_mpesa_sandbox.sql'),
  ('0003_tenant_portal.sql'),
  ('0004_lease_history_and_deposits.sql'),
  ('0005_staff_invites_and_assignments.sql'),
  ('0006_rls_and_audit_guards.sql'),
  ('0007_auth_and_bootstrap_rls.sql'),
  ('0008_app_migration_baseline.sql')
ON CONFLICT (version) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'makazi_runtime')
     AND current_user <> 'makazi_runtime' THEN
    EXECUTE 'GRANT CONNECT ON DATABASE postgres TO makazi_runtime';
    EXECUTE 'GRANT USAGE, CREATE ON SCHEMA public TO makazi_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO makazi_runtime';
    EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO makazi_runtime';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO makazi_runtime';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO makazi_runtime';
  END IF;
END $$;

REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC;
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.schema_migrations FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'makazi_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.schema_migrations TO makazi_runtime';
  END IF;
END $$;
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schema_migrations FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'schema_migrations'
      AND policyname = 'schema_migrations_access'
  ) THEN
    EXECUTE 'CREATE POLICY schema_migrations_access ON public.schema_migrations FOR ALL TO PUBLIC USING (true) WITH CHECK (true)';
  END IF;
END $$;

ALTER FUNCTION public.makazi_now() SET search_path = pg_catalog;
ALTER FUNCTION public.makazi_current_organization_id() SET search_path = pg_catalog;
ALTER FUNCTION public.makazi_current_user_id() SET search_path = pg_catalog;
ALTER FUNCTION public.makazi_auth_lookup_enabled() SET search_path = pg_catalog;
ALTER FUNCTION public.reject_audit_log_mutation() SET search_path = pg_catalog;
