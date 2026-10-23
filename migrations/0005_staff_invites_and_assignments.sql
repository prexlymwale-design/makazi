CREATE TABLE IF NOT EXISTS staff_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('manager','accountant','caretaker')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(id,organization_id)
);
CREATE INDEX IF NOT EXISTS staff_invites_org_idx ON staff_invitations(organization_id,expires_at,accepted_at);

CREATE TABLE IF NOT EXISTS staff_invitation_properties (
  organization_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  PRIMARY KEY(organization_id,invitation_id,property_id),
  FOREIGN KEY(invitation_id,organization_id) REFERENCES staff_invitations(id,organization_id),
  FOREIGN KEY(property_id,organization_id) REFERENCES properties(id,organization_id)
);

CREATE TABLE IF NOT EXISTS staff_property_assignments (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(organization_id,user_id,property_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES organization_memberships(organization_id,user_id),
  FOREIGN KEY(property_id,organization_id) REFERENCES properties(id,organization_id)
);
CREATE INDEX IF NOT EXISTS staff_assignments_user_idx ON staff_property_assignments(organization_id,user_id);
