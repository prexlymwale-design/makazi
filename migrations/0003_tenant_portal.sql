CREATE TABLE IF NOT EXISTS tenant_users (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(organization_id,user_id),
  UNIQUE(organization_id,tenant_id),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id)
);
CREATE INDEX IF NOT EXISTS tenant_users_user_idx ON tenant_users(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id)
);
CREATE INDEX IF NOT EXISTS invitations_tenant_idx ON invitations(organization_id,tenant_id,expires_at);

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
BEFORE UPDATE ON audit_logs BEGIN
  SELECT RAISE(ABORT,'audit logs are immutable');
END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
BEFORE DELETE ON audit_logs BEGIN
  SELECT RAISE(ABORT,'audit logs are immutable');
END;
