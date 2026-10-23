# Makazi

Makazi is a Kenya-first rental and property management workspace. It uses KES, formats business dates in `Africa/Nairobi`, and supports SQLite for local use or PostgreSQL when configured.

This is an early, working foundation for local evaluation. It is not ready to hold production customer data. Read [PROJECT_STATUS.md](PROJECT_STATUS.md) for the implemented scope and the remaining work.

## Requirements

- Node.js 22.9 or later (Node 24 is recommended).
- SQLite mode uses Node's built-in HTTP, crypto, and SQLite modules. PostgreSQL mode uses the `pg` package.
- Run `npm ci` to install the packages before running PostgreSQL mode or the automated tests.

## Run locally

From this folder:

```powershell
Copy-Item .env.example .env
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) and create a workspace. The first registered user becomes its owner. The database is created at `data/makazi.sqlite` and the versioned SQL migrations are applied automatically.

For automatic server restart while editing:

```powershell
npm run dev
```

The server binds to `127.0.0.1` by default. Set `HOST` only when a container or trusted reverse proxy needs a different bind address. Do not expose the local server directly to the public internet.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `NODE_ENV` | Cookie and runtime mode | `development` |
| `HOST` | Listening interface | `127.0.0.1` |
| `PORT` | HTTP port | `4173` |
| `DB_PATH` | SQLite database path, relative to this folder unless absolute | `./data/makazi.sqlite` |
| `MAKAZI_DATABASE_URL` | PostgreSQL connection string; takes precedence over other provider URLs | unset |
| `SUPABASE_DATABASE_URL` | Supabase PostgreSQL connection string; use when `MAKAZI_DATABASE_URL` is unset | unset |
| `NETLIFY_DB_URL` | Netlify Database connection string; used when `MAKAZI_DATABASE_URL` is unset | unset |
| `NETLIFY_DATABASE_URL` | Legacy Netlify Postgres connection string; used when the other URLs are unset | unset |
| `PG_POOL_MAX` | Maximum PostgreSQL connections; defaults to `1` in serverless functions | `10` locally |
| `SESSION_TTL_HOURS` | Maximum session duration, limited to 1–168 hours | `12` |
| `DARAJA_ENVIRONMENT` | Must be `sandbox` to enable Daraja sandbox requests | `sandbox` |
| `DARAJA_CONSUMER_KEY` | Safaricom Daraja sandbox key | blank |
| `DARAJA_CONSUMER_SECRET` | Safaricom Daraja sandbox secret | blank |
| `DARAJA_SHORTCODE` | Daraja sandbox shortcode | blank |
| `DARAJA_PASSKEY` | Daraja sandbox passkey | blank |
| `DARAJA_CALLBACK_URL` | Public HTTPS callback URL reachable by Daraja | blank |

`.env.example` contains placeholders only. Real Daraja credentials must be supplied out of band and must never be committed. The app does not initiate production M-Pesa transactions. Without all sandbox values and a public HTTPS callback, STK Push remains unavailable; confirmed cash and bank receipts can still be recorded locally.

## PostgreSQL setup

Set private values for `POSTGRES_ADMIN_PASSWORD` and `APP_DB_PASSWORD` in `.env`, then start the local PostgreSQL 16 service:

```powershell
docker compose up -d postgres
```

Uncomment `MAKAZI_DATABASE_URL` in `.env` and set its password to the same value as `APP_DB_PASSWORD`. On startup, Makazi applies the PostgreSQL migrations and scopes API requests to the authenticated user and organization. Row-level policies cover workspace data, including accounts, invitations, and M-Pesa callback lookups. Those bootstrap lookups use a temporary database context; rental and financial records remain restricted to the active workspace.

To copy an existing SQLite workspace into a fresh PostgreSQL database, first stop the SQLite app and make a verified backup of its `data` folder. Set `MAKAZI_DATABASE_URL` or `SUPABASE_DATABASE_URL` to the PostgreSQL target, start Makazi once so it applies PostgreSQL migrations, then stop it again without registering a workspace. Run the importer while the app is stopped:

```powershell
npm run db:import:postgres -- --source=./data/makazi.sqlite
```

The importer checks that both databases are current, copies all supported tables in one transaction, and verifies row counts. It refuses a PostgreSQL target that already contains a workspace. The SQLite source is opened read-only. Review the reported counts before switching the app to PostgreSQL.

Run the PostgreSQL checks with the embedded PostgreSQL engine:

```powershell
npm run test:postgres
```

To run the policy and API checks against the disposable `makazi_test` database created by Compose, set `MAKAZI_TEST_DATABASE_URL` to its `makazi_app` connection string in `.env` before running the command. The API test creates and removes a uniquely named temporary schema; the policy test rolls its migration and fixture changes back in a transaction. The SQLite import check runs against a disposable embedded PostgreSQL database. Never point the test variable at production. Embedded PostgreSQL policy, import, and API checks pass; a separate PostgreSQL server has not yet been verified.

## Current workflows

1. Register a workspace owner.
2. Add a property, its rentable units, and tenant contact records.
3. Create a lease for a vacant unit.
4. Generate a monthly invoice run. The lease and billing-period uniqueness rule makes reruns safe.
5. Record a confirmed cash, bank, or other rent receipt. Payments allocate to the tenant's oldest open invoices; an excess stays unallocated. Record deposit receipts and refunds separately from rent in each lease's deposit ledger.
6. Review arrears, record expenses, approve expenses above the configured threshold, and update maintenance request status.
7. Create a one-time tenant invitation link from a tenant's row. The tenant chooses a password, then sees only their own lease overview, invoices, confirmed payments, maintenance requests, and editable phone/email. The link expires in 24 hours; deliver it through your own trusted channel because no email provider is configured.
8. Invite staff as a property manager, accountant, or caretaker. Caretaker links carry property assignments and caretaker screens only expose assigned units and maintenance work. The link expires in 24 hours and is copied for manual delivery.
9. Export the current table page to CSV. The export is recorded in the activity log.

Lease terms can be amended with a revision record, and a lease can be closed with its move-out date. Closing a lease preserves invoices and payments, updates unit availability, and keeps the tenant's historical ledger. Deposit refunds are limited to the recorded deposit balance.

The owner can change the workspace name and expense approval threshold in Workspace settings. The Starter plan currently allows 25 units. Plan limits are stored in the database, not repeated in billing code.

## M-Pesa sandbox setup

The server includes a Daraja sandbox STK Push adapter and a status-query verification step for callbacks. Fill in the sandbox values in `.env`, configure a publicly reachable HTTPS callback at `/api/v1/payments/mpesa/callback`, and use a secure tunnel only for local sandbox testing. The browser never receives consumer credentials or access tokens. Callback payloads are not logged or stored wholesale. The Daraja adapter has not been exercised against live sandbox credentials in this workspace, so verify it in a Safaricom sandbox account before relying on it.

Do not mark an M-Pesa request as received based on a redirect, message, screenshot, or client-side callback. A request remains pending unless the server can correlate it and Daraja's transaction query confirms success. This app does not collect real M-Pesa payments.

## Data and backup

Financial amounts are stored as integer cents. The local business currency is KES; due dates are fixed to a configured day from 1–28 to avoid month-end ambiguity. Timestamps are stored in UTC and business dates use `Africa/Nairobi`.

To back up the local database, stop the server cleanly, then copy the complete `data` folder to encrypted storage with access limited to the workspace owner. Keep a dated backup and periodically confirm that a copy can be opened. To restore, stop the server, preserve the current `data` folder, restore the backup to the configured `DB_PATH`, and restart. This local SQLite backup process is not a substitute for managed production backups or a tested disaster recovery plan.

There is no in-app organization deletion or personal-data retention workflow yet. Before disposing of a workspace, export records that must be retained, stop the server, and follow the organization's documented retention obligations before securely deleting the local database and its backups. Avoid collecting national-ID references; they are not part of the current tenant form.

## Testing

```powershell
npm test
```

The test suite uses Node's built-in test runner. It covers currency conversion, proration, allocation order and overpayments, arrears boundaries, role permissions, M-Pesa callback verification decisions, PostgreSQL organization policies and SQLite import, PostgreSQL and SQLite API workflows, registration, tenant and staff invitations, caretaker property scoping, property-to-payment flow, duplicate billing and payment retries, origin checks, security headers, and cross-workspace isolation.

## API

The versioned REST API is under `/api/v1`. See [openapi.yaml](openapi.yaml) for the implemented routes and payload shapes. Sessions use an opaque, hashed server-side token in an `HttpOnly`, `SameSite=Strict` cookie. Passwords use Node's `scrypt`; financial actions use database transactions and idempotency keys. All organization-owned reads and writes include the active workspace ID in their query or foreign-key checks.

Run a monthly billing batch from an external scheduler with `npm run billing:generate -- --month=YYYY-MM`. Omitting `--month` uses the current month in `Africa/Nairobi`. The job can be run again safely; this build does not install or operate a scheduler.

## Production path

### GitHub and Netlify deployment

The repository is configured for Netlify. Netlify serves `public/` and routes `/api/v1/*` to a serverless function. Production mode refuses to start on SQLite, whose files are not durable across serverless invocations. Automated CI is not enabled yet.

1. Push this project to the `main` branch of `https://github.com/prexlymwale-design/makazi`. The `.gitignore` excludes local environment files, SQLite databases, dependencies, and Netlify's local state.
2. In Netlify, import the GitHub repository as a new site and select `main` as the production branch. The checked-in `netlify.toml` supplies the publish folder, function routing, and security headers.
3. The Makazi Supabase project is already created in Mumbai, the closest region currently offered to Kenya. Kenya and Africa are not in Supabase's available-region list. Migrations `0000` through `0008` are applied, row-level security is enabled and forced on all public app tables, and the database has no property, tenant, user, or organization records. The `makazi_runtime` role exists without login until you set its password.
4. In the Supabase SQL Editor, open [supabase/runtime-role.sql](supabase/runtime-role.sql), replace its password placeholder with a new, unique, strong password, and run the script. Do not use Supabase's `postgres` or `service_role` credentials for the app. Do not send the password in chat or commit it to this repository.
5. In the Supabase **Connect** dialog, copy the **Shared pooler · Transaction** connection string. Use `makazi_runtime.<project-ref>` as the username, as Supabase requires for a custom role on its shared pooler. Set this URL as `SUPABASE_DATABASE_URL` (or `MAKAZI_DATABASE_URL`) in the Netlify site's Functions environment scope. The app requires TLS for Supabase URLs. Never put a database URL in GitHub or in this repository.
6. Set `NODE_ENV=production` and `PG_POOL_MAX=1` in Netlify's production environment. Keep deploy previews disabled until they have their own isolated database URL. The production check rejects PostgreSQL roles that are superusers or bypass row-level security.
7. Trigger the first production deploy, open the site, and register the initial workspace owner. The checked-in migration baseline prevents the function from reapplying the schema already installed in Supabase. For future PostgreSQL schema changes, apply the migration to Supabase first and include its filename in `public.schema_migrations` so the runtime skips it at startup.

This deployment starts with an empty production database; it does not copy the local SQLite file. If existing records need to move, use the SQLite-to-PostgreSQL importer against the fresh Supabase database before the first production workspace is created, and verify the imported counts before directing users to the site. The app uses Supabase PostgreSQL directly; Makazi's existing login system remains in use, so Supabase Auth and client-side Supabase keys are not needed.

This remains an early product foundation. Before using it for real customer records, complete the separate PostgreSQL-server verification, account recovery, managed backups and a restore drill, and a security and privacy review. Local development can continue using SQLite; production mode requires PostgreSQL.
