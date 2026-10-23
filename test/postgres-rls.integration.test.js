import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { PGlite } from '@electric-sql/pglite';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const databaseUrl=process.env.MAKAZI_TEST_DATABASE_URL;

test('PostgreSQL row-level policies isolate organization rental records',async()=>{
  let client,embedded;
  if(databaseUrl){
    client=new Client({connectionString:databaseUrl});
    await client.connect();
  }else{
    embedded=await PGlite.create();
    await embedded.exec(`CREATE ROLE makazi_policy_test LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT CREATE, USAGE ON SCHEMA public TO makazi_policy_test;
      SET ROLE makazi_policy_test;`);
  }
  const query=(sql,params=[])=>databaseUrl?client.query(sql,params):embedded.query(sql,params);
  const exec=(sql)=>databaseUrl?client.query(sql):embedded.exec(sql);
  try{
    const role=await query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.rows[0]?.rolsuper,false,'Use a non-superuser role so the test exercises row-level security.');
    await query('BEGIN');
    const migrationDir=resolve(projectRoot,'migrations','postgres');
    for(const filename of (await readdir(migrationDir)).filter((name)=>name.endsWith('.sql')).sort()){
      await exec(await readFile(resolve(migrationDir,filename),'utf8'));
    }

    await query("SELECT set_config('makazi.authentication_lookup','true',true)");
    await query("INSERT INTO organizations(id,name) VALUES('org-a','Amani Homes'),('org-b','Baraka Homes')");
    await query("INSERT INTO users(id,full_name,email,password_hash) VALUES('user-a','Amina Owner','amina@example.test','test-only'),('user-b','Brian Tenant','brian@example.test','test-only')");
    await query("SELECT set_config('makazi.authentication_lookup','false',true)");
    await query("SELECT set_config('makazi.organization_id','org-a',true)");
    await query("SELECT set_config('makazi.user_id','user-a',true)");
    await query("INSERT INTO organization_memberships(organization_id,user_id,role) VALUES('org-a','user-a','owner')");
    await query("INSERT INTO properties(id,organization_id,name,property_type) VALUES('property-a','org-a','Amani Court','Apartment building')");
    await query("INSERT INTO units(id,organization_id,property_id,unit_number,rent_cents) VALUES('unit-a','org-a','property-a','A-01',2500000)");
    await query("INSERT INTO tenants(id,organization_id,full_name,phone) VALUES('tenant-a','org-a','Brian Tenant','0712345678')");
    await query("INSERT INTO leases(id,organization_id,unit_id,tenant_id,start_date,monthly_rent_cents,due_day) VALUES('lease-a','org-a','unit-a','tenant-a','2026-10-01',2500000,5)");
    await query("INSERT INTO invoices(id,organization_id,lease_id,tenant_id,unit_id,period,invoice_number,issue_date,due_date,total_cents) VALUES('invoice-a','org-a','lease-a','tenant-a','unit-a','2026-10','MKZ-202610-A','2026-10-01','2026-10-05',2500000)");
    await query("INSERT INTO invitations(id,organization_id,tenant_id,email,token_hash,created_by,expires_at) VALUES('invite-a','org-a','tenant-a','brian@example.test','invite-hash-a','user-a','2030-01-01T00:00:00Z')");
    await query("INSERT INTO staff_invitations(id,organization_id,email,role,token_hash,created_by,expires_at) VALUES('staff-invite-a','org-a','simon@example.test','caretaker','staff-hash-a','user-a','2030-01-01T00:00:00Z')");
    await query("INSERT INTO mpesa_transactions(id,organization_id,tenant_id,requested_by,internal_reference,checkout_request_id,phone_number,amount_cents,idempotency_key) VALUES('mpesa-a','org-a','tenant-a','user-a','internal-a','checkout-a','254712345678',2500000,'mpesa-key-a')");
    await query("SELECT set_config('makazi.user_id','user-b',true)");
    await query("INSERT INTO tenant_users(organization_id,user_id,tenant_id) VALUES('org-a','user-b','tenant-a')");
    await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('session-b','user-b','2030-01-01T00:00:00Z')");

    await query("SELECT set_config('makazi.organization_id','org-b',true)");
    await query("SELECT set_config('makazi.user_id','user-a',true)");
    const properties=await query('SELECT id FROM properties');
    const invoices=await query('SELECT id FROM invoices');
    assert.deepEqual(properties.rows,[]);
    assert.deepEqual(invoices.rows,[]);
    for(const table of ['organization_memberships','tenant_users','invitations','staff_invitations','mpesa_transactions']){
      assert.deepEqual((await query(`SELECT * FROM ${table} WHERE organization_id='org-a'`)).rows,[],`${table} must remain scoped to the active organization`);
    }
    assert.deepEqual((await query("SELECT id FROM users WHERE id='user-b'")).rows,[],'Other users must not be visible through the user table.');
    assert.deepEqual((await query("SELECT token_hash FROM sessions WHERE token_hash='session-b'")).rows,[],'Other users\' sessions must not be visible.');
    assert.deepEqual((await query("SELECT id FROM organizations WHERE id='org-a'")).rows,[],'Other organizations must not be visible through the organization table.');

    await query("SELECT set_config('makazi.authentication_lookup','true',true)");
    assert.equal((await query("SELECT id FROM invitations WHERE id='invite-a'")).rowCount,1,'Invitation token lookup is available in the explicit bootstrap context.');
    assert.equal((await query("SELECT id FROM mpesa_transactions WHERE checkout_request_id='checkout-a'")).rowCount,1,'M-Pesa callback lookup is available in the explicit bootstrap context.');
    assert.equal((await query("SELECT token_hash FROM sessions WHERE token_hash='session-b'")).rowCount,1,'Session lookup is available in the explicit bootstrap context.');
    assert.deepEqual((await query("SELECT id FROM properties WHERE id='property-a'")).rows,[],'Bootstrap lookup must not expose rental tables across organizations.');
    await query("SELECT set_config('makazi.authentication_lookup','false',true)");

    await query('SAVEPOINT denied_cross_organization_write');
    await assert.rejects(
      query("INSERT INTO properties(id,organization_id,name,property_type) VALUES('property-leak','org-a','Should fail','House')"),
      (error)=>error.code==='42501'
    );
    await query('ROLLBACK TO SAVEPOINT denied_cross_organization_write');

    await query("SELECT set_config('makazi.organization_id','org-a',true)");
    await query("INSERT INTO audit_logs(id,organization_id,actor_id,action,entity_type,entity_id) VALUES('audit-a','org-a','user-a','test','property','property-a')");
    await query('SAVEPOINT denied_audit_edit');
    await assert.rejects(query("UPDATE audit_logs SET action='changed' WHERE id='audit-a'"));
    await query('ROLLBACK TO SAVEPOINT denied_audit_edit');
  }finally{
    try{await query('ROLLBACK');}catch{}
    if(client)await client.end();
    if(embedded)await embedded.close();
  }
});
