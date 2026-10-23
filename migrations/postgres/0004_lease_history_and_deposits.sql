CREATE TABLE IF NOT EXISTS lease_revisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  changed_fields_json TEXT NOT NULL,
  previous_values_json TEXT NOT NULL,
  new_values_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(lease_id,organization_id) REFERENCES leases(id,organization_id)
);
CREATE INDEX IF NOT EXISTS lease_revisions_idx ON lease_revisions(organization_id,lease_id,created_at DESC);

CREATE TABLE IF NOT EXISTS deposit_transactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK(transaction_type IN ('received','refunded')),
  amount_cents BIGINT NOT NULL CHECK(amount_cents > 0),
  method TEXT NOT NULL CHECK(method IN ('cash','bank','other')),
  reference TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (makazi_now()),
  FOREIGN KEY(lease_id,organization_id) REFERENCES leases(id,organization_id),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id),
  UNIQUE(organization_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS deposit_ledger_idx ON deposit_transactions(organization_id,lease_id,created_at);

