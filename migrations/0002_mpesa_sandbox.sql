CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  tenant_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  internal_reference TEXT NOT NULL,
  merchant_request_id TEXT NOT NULL DEFAULT '',
  checkout_request_id TEXT,
  phone_number TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed','unmatched')),
  provider_receipt TEXT NOT NULL DEFAULT '',
  callback_result_code TEXT NOT NULL DEFAULT '',
  payment_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES tenants(id,organization_id),
  FOREIGN KEY(payment_id,organization_id) REFERENCES payments(id,organization_id),
  UNIQUE(organization_id,internal_reference),
  UNIQUE(organization_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS mpesa_reconciliation_idx ON mpesa_transactions(organization_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mpesa_checkout_unique_idx ON mpesa_transactions(checkout_request_id) WHERE checkout_request_id IS NOT NULL AND checkout_request_id<>'';
CREATE UNIQUE INDEX IF NOT EXISTS mpesa_receipt_unique_idx ON mpesa_transactions(provider_receipt) WHERE provider_receipt<>'';
