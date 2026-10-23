CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  max_units INTEGER NOT NULL CHECK (max_units > 0),
  max_staff INTEGER NOT NULL CHECK (max_staff > 0),
  advanced_reports INTEGER NOT NULL DEFAULT 0 CHECK (advanced_reports IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
INSERT INTO subscription_plans(id,name,max_units,max_staff,advanced_reports) VALUES
  ('starter','Starter',25,2,0),('growth','Growth',150,10,0),('professional','Professional',5000,100,1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  plan_id TEXT NOT NULL DEFAULT 'starter' REFERENCES subscription_plans(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  expense_approval_threshold_cents BIGINT NOT NULL DEFAULT 1000000 CHECK (expense_approval_threshold_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (makazi_now())
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE ,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (makazi_now())
);
CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','manager','accountant','caretaker','tenant')),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  PRIMARY KEY (organization_id,user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON organization_memberships(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (makazi_now())
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  property_type TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  county TEXT NOT NULL DEFAULT '',
  town TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  UNIQUE(id,organization_id)
);
CREATE INDEX IF NOT EXISTS properties_org_idx ON properties(organization_id,status,name);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  property_id TEXT NOT NULL,
  unit_number TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Apartment',
  floor TEXT NOT NULL DEFAULT '',
  rent_cents BIGINT NOT NULL CHECK (rent_cents >= 0),
  deposit_cents BIGINT NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  status TEXT NOT NULL DEFAULT 'vacant' CHECK (status IN ('vacant','occupied','maintenance','archived')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(property_id,organization_id) REFERENCES properties(id,organization_id),
  UNIQUE(property_id,unit_number),
  UNIQUE(id,organization_id)
);
CREATE INDEX IF NOT EXISTS units_org_status_idx ON units(organization_id,status);
CREATE INDEX IF NOT EXISTS units_property_idx ON units(property_id,status);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','former')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  UNIQUE(id,organization_id)
);
CREATE INDEX IF NOT EXISTS tenants_org_idx ON tenants(organization_id,status,full_name);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  unit_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  monthly_rent_cents BIGINT NOT NULL CHECK (monthly_rent_cents >= 0),
  deposit_cents BIGINT NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 28),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','draft')),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(unit_id,organization_id) REFERENCES units(id,organization_id),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id),
  UNIQUE(id,organization_id)
);
CREATE INDEX IF NOT EXISTS leases_org_status_idx ON leases(organization_id,status,start_date);
CREATE INDEX IF NOT EXISTS leases_unit_idx ON leases(unit_id,status,start_date,end_date);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  lease_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  period TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','part_paid','paid','void')),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(lease_id,organization_id) REFERENCES leases(id,organization_id),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id),
  FOREIGN KEY(unit_id,organization_id) REFERENCES units(id,organization_id),
  UNIQUE(lease_id,period), UNIQUE(invoice_number,organization_id), UNIQUE(id,organization_id)
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  FOREIGN KEY(invoice_id,organization_id) REFERENCES invoices(id,organization_id)
);
CREATE INDEX IF NOT EXISTS invoices_tenant_due_idx ON invoices(organization_id,tenant_id,due_date,status);
CREATE INDEX IF NOT EXISTS invoices_period_idx ON invoices(organization_id,period);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  tenant_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','bank','mpesa_sandbox','other')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  received_date TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','reversed')),
  provider_reference TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id),
  UNIQUE(organization_id,idempotency_key), UNIQUE(id,organization_id)
);
CREATE TABLE IF NOT EXISTS payment_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  FOREIGN KEY(payment_id,organization_id) REFERENCES payments(id,organization_id),
  FOREIGN KEY(invoice_id,organization_id) REFERENCES invoices(id,organization_id),
  UNIQUE(payment_id,invoice_id)
);
CREATE INDEX IF NOT EXISTS payments_org_date_idx ON payments(organization_id,received_date);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  property_id TEXT NOT NULL,
  unit_id TEXT,
  category TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  spent_on TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','rejected')),
  created_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(property_id,organization_id) REFERENCES properties(id,organization_id),
  FOREIGN KEY(unit_id,organization_id) REFERENCES units(id,organization_id)
);
CREATE INDEX IF NOT EXISTS expenses_org_date_idx ON expenses(organization_id,spent_on,status);

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  tenant_id TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','in_progress','awaiting_approval','resolved','closed')),
  estimate_cents BIGINT NOT NULL DEFAULT 0 CHECK(estimate_cents >= 0),
  actual_cents BIGINT NOT NULL DEFAULT 0 CHECK(actual_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  updated_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(property_id,organization_id) REFERENCES properties(id,organization_id),
  FOREIGN KEY(unit_id,organization_id) REFERENCES units(id,organization_id),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id)
);
CREATE INDEX IF NOT EXISTS maintenance_org_status_idx ON maintenance_tickets(organization_id,status,priority);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (makazi_now())
);
CREATE INDEX IF NOT EXISTS audit_org_date_idx ON audit_logs(organization_id,created_at DESC);

