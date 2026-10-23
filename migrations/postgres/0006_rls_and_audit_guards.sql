CREATE OR REPLACE FUNCTION makazi_current_organization_id()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('makazi.organization_id', true), '')
$$;

-- Provider callbacks need to find the organization before a request context exists.
-- Authentication, membership, and one-time invitation lookups are likewise bootstrap paths.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'properties',
    'units',
    'tenants',
    'leases',
    'lease_revisions',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'expenses',
    'maintenance_tickets',
    'audit_logs',
    'deposit_transactions',
    'staff_property_assignments',
    'staff_invitation_properties'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_isolation ON %I USING (organization_id = makazi_current_organization_id()) WITH CHECK (organization_id = makazi_current_organization_id())',
      table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE PLPGSQL
AS $$
BEGIN
  RAISE EXCEPTION 'audit logs are immutable';
END;
$$;

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
