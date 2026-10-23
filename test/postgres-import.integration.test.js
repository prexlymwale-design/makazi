import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { importSqliteToPostgres } from '../scripts/import-sqlite-to-postgres.js';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('SQLite import preserves tenant and financial records and refuses a non-empty target',async(t)=>{
  const tempDir=await mkdtemp(join(tmpdir(),'makazi-import-test-'));
  const sourcePath=join(tempDir,'source.sqlite');
  const source=new DatabaseSync(sourcePath);
  let embedded;
  t.after(async()=>{try{source.close();}catch{}if(embedded)await embedded.close();await rm(tempDir,{recursive:true,force:true});});

  source.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')))');
  for(const filename of (await readdir(resolve(projectRoot,'migrations'))).filter((name)=>name.endsWith('.sql')).sort()){
    source.exec('BEGIN');
    try{
      source.exec(await readFile(resolve(projectRoot,'migrations',filename),'utf8'));
      source.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(filename);
      source.exec('COMMIT');
    }catch(error){source.exec('ROLLBACK');throw error;}
  }
  source.exec(`
    INSERT INTO organizations(id,name) VALUES('org-import','Kijani Homes');
    INSERT INTO users(id,full_name,email,password_hash) VALUES
      ('user-owner','Amina Owner','owner.import@example.test','test-hash'),
      ('user-manager','Peter Manager','manager.import@example.test','test-hash'),
      ('user-tenant','Brian Tenant','tenant.import@example.test','test-hash');
    INSERT INTO organization_memberships(organization_id,user_id,role) VALUES
      ('org-import','user-owner','owner'),('org-import','user-manager','manager');
    INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('session-import','user-owner','2030-01-01T00:00:00Z');
    INSERT INTO properties(id,organization_id,name,property_type) VALUES('property-import','org-import','Kijani Court','Apartment building');
    INSERT INTO units(id,organization_id,property_id,unit_number,rent_cents) VALUES('unit-import','org-import','property-import','A-01',2500000);
    INSERT INTO tenants(id,organization_id,full_name,phone,email) VALUES('tenant-import','org-import','Brian Tenant','0712345678','tenant.import@example.test');
    INSERT INTO leases(id,organization_id,unit_id,tenant_id,start_date,monthly_rent_cents,due_day) VALUES('lease-import','org-import','unit-import','tenant-import','2026-10-01',2500000,5);
    INSERT INTO invoices(id,organization_id,lease_id,tenant_id,unit_id,period,invoice_number,issue_date,due_date,total_cents) VALUES('invoice-import','org-import','lease-import','tenant-import','unit-import','2026-10','MKZ-202610-IMPORT','2026-10-01','2026-10-05',2500000);
    INSERT INTO invoice_lines(id,organization_id,invoice_id,description,amount_cents) VALUES('line-import','org-import','invoice-import','Monthly rent',2500000);
    INSERT INTO payments(id,organization_id,tenant_id,method,amount_cents,received_date,reference,idempotency_key,created_by) VALUES('payment-import','org-import','tenant-import','bank',1000000,'2026-10-05','BANK-IMPORT','payment-import-key','user-owner');
    INSERT INTO payment_allocations(id,organization_id,payment_id,invoice_id,amount_cents) VALUES('allocation-import','org-import','payment-import','invoice-import',1000000);
    INSERT INTO expenses(id,organization_id,property_id,category,amount_cents,spent_on,description,status,created_by) VALUES('expense-import','org-import','property-import','Repairs',20000,'2026-10-06','Tap repair','approved','user-owner');
    INSERT INTO maintenance_tickets(id,organization_id,property_id,unit_id,tenant_id,title,category,priority,description) VALUES('ticket-import','org-import','property-import','unit-import','tenant-import','Leaking tap','Plumbing','normal','The kitchen tap is leaking.');
    INSERT INTO audit_logs(id,organization_id,actor_id,action,entity_type,entity_id) VALUES('audit-import','org-import','user-owner','property.created','property','property-import');
    INSERT INTO mpesa_transactions(id,organization_id,tenant_id,requested_by,internal_reference,checkout_request_id,phone_number,amount_cents,idempotency_key) VALUES('mpesa-import','org-import','tenant-import','user-owner','internal-import','checkout-import','254712345678',2500000,'mpesa-import-key');
    INSERT INTO tenant_users(organization_id,user_id,tenant_id) VALUES('org-import','user-tenant','tenant-import');
    INSERT INTO invitations(id,organization_id,tenant_id,email,token_hash,created_by,expires_at) VALUES('invite-import','org-import','tenant-import','tenant.import@example.test','invite-import-hash','user-owner','2030-01-01T00:00:00Z');
    INSERT INTO lease_revisions(id,organization_id,lease_id,actor_id,changed_fields_json,previous_values_json,new_values_json) VALUES('revision-import','org-import','lease-import','user-owner','[]','{}','{}');
    INSERT INTO deposit_transactions(id,organization_id,lease_id,tenant_id,transaction_type,amount_cents,method,idempotency_key,created_by) VALUES('deposit-import','org-import','lease-import','tenant-import','received',2500000,'bank','deposit-import-key','user-owner');
    INSERT INTO staff_invitations(id,organization_id,email,role,token_hash,created_by,expires_at) VALUES('staff-invite-import','org-import','caretaker.import@example.test','caretaker','staff-import-hash','user-owner','2030-01-01T00:00:00Z');
    INSERT INTO staff_invitation_properties(organization_id,invitation_id,property_id) VALUES('org-import','staff-invite-import','property-import');
    INSERT INTO staff_property_assignments(organization_id,user_id,property_id,assigned_by) VALUES('org-import','user-manager','property-import','user-owner');
  `);
  source.close();

  embedded=await PGlite.create();
  await embedded.exec(`CREATE ROLE makazi_import_test LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT CREATE,USAGE ON SCHEMA public TO makazi_import_test;
    SET ROLE makazi_import_test;
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text));`);
  for(const filename of (await readdir(resolve(projectRoot,'migrations','postgres'))).filter((name)=>name.endsWith('.sql')).sort()){
    await embedded.exec(await readFile(resolve(projectRoot,'migrations','postgres',filename),'utf8'));
    await embedded.query('INSERT INTO schema_migrations(version) VALUES($1)',[filename]);
  }

  const counts=await importSqliteToPostgres(sourcePath,embedded);
  assert.equal(counts.organizations,1);
  assert.equal(counts.users,3);
  assert.equal(counts.invoices,1);
  assert.equal(counts.payments,1);
  assert.equal(counts.payment_allocations,1);
  assert.equal(counts.mpesa_transactions,1);
  assert.equal(counts.staff_property_assignments,1);
  await assert.rejects(importSqliteToPostgres(sourcePath,embedded),/already contains workspaces/);
});
