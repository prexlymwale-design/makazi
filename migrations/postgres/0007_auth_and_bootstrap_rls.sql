CREATE OR REPLACE FUNCTION makazi_current_user_id()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('makazi.user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION makazi_auth_lookup_enabled()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(current_setting('makazi.authentication_lookup', true) = 'true', false)
$$;

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_plans_read_all ON subscription_plans
  FOR SELECT USING (true);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_context_isolation ON organizations
  USING (id = makazi_current_organization_id() OR makazi_auth_lookup_enabled())
  WITH CHECK (id = makazi_current_organization_id() OR makazi_auth_lookup_enabled());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_context_isolation ON users
  USING (
    id = makazi_current_user_id()
    OR makazi_auth_lookup_enabled()
    OR EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.user_id = users.id AND m.organization_id = makazi_current_organization_id()
    )
    OR EXISTS (
      SELECT 1 FROM tenant_users tu
      WHERE tu.user_id = users.id AND tu.organization_id = makazi_current_organization_id()
    )
  )
  WITH CHECK (id = makazi_current_user_id() OR makazi_auth_lookup_enabled());

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_context_isolation ON organization_memberships
  USING (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled())
  WITH CHECK (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_context_isolation ON sessions
  USING (user_id = makazi_current_user_id() OR makazi_auth_lookup_enabled())
  WITH CHECK (user_id = makazi_current_user_id() OR makazi_auth_lookup_enabled());

ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_user_context_isolation ON tenant_users
  USING (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled())
  WITH CHECK (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_context_isolation ON invitations
  USING (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled())
  WITH CHECK (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled());

ALTER TABLE staff_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_invitation_context_isolation ON staff_invitations
  USING (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled())
  WITH CHECK (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled());

ALTER TABLE mpesa_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mpesa_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY mpesa_context_isolation ON mpesa_transactions
  USING (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled())
  WITH CHECK (organization_id = makazi_current_organization_id() OR makazi_auth_lookup_enabled());
