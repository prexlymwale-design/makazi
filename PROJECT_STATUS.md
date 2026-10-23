# Project status

Updated: 23 October 2026

## Working foundation

- Fresh workspace registration and sign-in, scrypt password hashing, expiring server-side sessions, same-origin checks on browser mutations, basic login throttling, safe response headers, and a loopback-only default listener.
- Organization-scoped SQLite and PostgreSQL schemas. SQLite remains the default; PostgreSQL can be selected with `MAKAZI_DATABASE_URL`. New organizations default to KES, `Africa/Nairobi`, and a configurable Starter unit allowance.
- Property, unit, tenant, and lease creation; property archival; unit and property search; unit, tenant, lease, and property tables.
- Active-lease overlap protection, occupancy changes on lease creation and termination, lease term amendments with immutable revision records, and move-out date workflow.
- Monthly rent invoice generation, due dates, invoice uniqueness by lease and period, repeat-safe job CLI, and a separate idempotent deposit receipt/refund ledger that blocks refunds above the recorded held balance.
- Integer-cent rent and expense values; cash, bank, and other confirmed payment entry; oldest-open-invoice allocation; partial payments, overpayments, invoice balance/status updates, and payment idempotency.
- Arrears aging, expenses with owner approval above the configured threshold, maintenance tickets and status updates, dashboard totals from stored records, activity log, CSV export audit entries, and responsive local UI.
- Owner-created, expiring one-time tenant invitations; tenant password setup; a tenant portal scoped to that tenant's lease, invoices, payments, profile contact details, and maintenance requests. Tenants cannot access manager property lists or financial controls.
- Owner-created staff invitations for managers, accountants, and caretakers; plan staff limits; assigned-property caretaker views and maintenance-only updates.
- Daraja sandbox STK Push adapter, provider status-query verification, normalized Kenyan phone numbers, pending-request reconciliation records, duplicate receipt protection, and an M-Pesa reconciliation screen. No sandbox credentials were available, so Safaricom network behavior remains unverified.
- PostgreSQL migrations, organization row-level policies, and immutable audit-log triggers are implemented under `migrations/postgres`. Policies cover core rental and financial records plus users, sessions, memberships, tenant accounts, invitations, and M-Pesa callback lookups. Authentication lookups run inside an explicit short-lived database context; normal rental reads and writes remain scoped to the active organization. Embedded PostgreSQL isolation, import, and API tests pass.
- A transactional SQLite-to-PostgreSQL importer copies the current schema into a fresh target, checks migration versions and row counts, and rejects targets that already contain a workspace. It is tested against embedded PostgreSQL; a separate server is not yet available in this environment.
- The public GitHub repository `prexlymwale-design/makazi` is populated on `main`; GitHub Actions CI is not enabled. Netlify site `makazi-kenya` is linked to that branch, and its first production deploy is published at `https://makazi-kenya.netlify.app`. The site remains private while production database access is unfinished. Netlify has `NODE_ENV=production` and `PG_POOL_MAX=1`; branch deploys and pull request previews are disabled. A clean Supabase project is active in Mumbai, currently the closest region Supabase offers to Kenya; there is no Kenya/Africa region. Its eight app migrations and migration baseline are applied, RLS is enabled and forced on all public app tables, and only the three subscription-plan seed rows exist. The `makazi_runtime` role has `NOSUPERUSER` and `NOBYPASSRLS`, but login remains disabled until the owner sets a unique password using the supplied SQL script. `SUPABASE_DATABASE_URL` is not yet set in Netlify, so the production API is not connected to Supabase.
- Ten automated checks pass: six domain/security decision tests, one PostgreSQL row-level policy test, one SQLite import test, one PostgreSQL API flow covering sign-in, invitations, property-to-payment operations, and one SQLite API flow covering invitations, role scoping, leases, deposits, expenses, maintenance, invoicing, and partial payments.

## Known gaps

- The app defaults to SQLite. PostgreSQL runtime behavior and SQLite import have passed embedded-engine tests but have not yet been validated against a separate PostgreSQL server. The importer requires a fresh target and a current SQLite source; it does not merge databases.
- No subscription billing, password reset, email verification, fine-grained custom permissions, or organization suspension interface.
- Owner statements, recurring reminders/notification delivery, PDF/document storage, downloadable receipts, rent-payment refunds/reversals, and full reconciliation workflows are not implemented.
- Prorated rent is available as a tested domain function, but invoice generation does not yet apply first/last-period proration or non-rent charge lines.
- CSV exports cover the current displayed page. PDF exports and server-generated financial statements are not implemented.
- The Daraja adapter must be verified with Safaricom sandbox credentials and an HTTPS callback endpoint before use. Production Daraja transactions are deliberately disabled.
- Tenant and staff invitation links must be delivered manually; there is no configured email provider. Tenants do not yet have downloadable receipts, lease files, or a maintenance attachment workflow.
- This build has not undergone an external penetration test, Kenyan legal review, or production-readiness assessment. The Supabase schema has been applied to the live Makazi project, but the Netlify function and production connection have not yet been exercised.

## Next phases

1. Run the app, import utility, and isolation suite against a separate PostgreSQL server.
2. Add property owner assignments, owner statements, line-item invoices, and proration in invoice generation.
3. Add fine-grained staff permission management, password recovery, and email verification.
4. Verify the complete Daraja sandbox callback and reconciliation journey using test credentials.
5. Add secure file storage, statements and receipt PDFs, provider-backed notifications, monitored jobs, and restore exercises.
6. Complete security, privacy, and deployment reviews before accepting real customer data.
