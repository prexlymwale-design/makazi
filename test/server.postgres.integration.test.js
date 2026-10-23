import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));

async function freePort(){
  const server=createServer();server.listen(0,'127.0.0.1');
  await new Promise((resolvePromise,reject)=>{server.once('listening',resolvePromise);server.once('error',reject);});
  const port=server.address().port;await new Promise((resolvePromise)=>server.close(resolvePromise));return port;
}

test('PostgreSQL-backed API commits scoped rental and payment workflows',async(t)=>{
  const tempDir=await mkdtemp(join(tmpdir(),'makazi-pg-api-'));
  const port=await freePort();const base=`http://127.0.0.1:${port}/api/v1`;
  const externalDatabaseUrl=process.env.MAKAZI_TEST_DATABASE_URL;
  const schema=`makazi_pg_api_${randomUUID().replaceAll('-','')}`;
  let schemaClient;
  if(externalDatabaseUrl){
    const databaseName=decodeURIComponent(new URL(externalDatabaseUrl).pathname.slice(1));
    assert.match(databaseName,/test/i,'Use a dedicated test database, never production.');
    schemaClient=new Client({connectionString:externalDatabaseUrl});
    await schemaClient.connect();
    const role=await schemaClient.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.rows[0]?.rolsuper,false,'Use a non-superuser PostgreSQL test role.');
    await schemaClient.query(`CREATE SCHEMA "${schema}"`);
  }
  const child=spawn(process.execPath,['src/server.js'],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',PORT:String(port),HOST:'127.0.0.1',DB_PATH:join(tempDir,'unused.sqlite'),MAKAZI_DATABASE_URL:externalDatabaseUrl||'pglite:memory',MAKAZI_PG_SCHEMA:externalDatabaseUrl?schema:''},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',(chunk)=>logs+=chunk.toString());child.stderr.on('data',(chunk)=>logs+=chunk.toString());
  t.after(async()=>{
    if(child.exitCode===null){child.kill('SIGTERM');await new Promise((resolvePromise)=>{child.once('exit',resolvePromise);setTimeout(resolvePromise,2000).unref();});}
    if(schemaClient){try{await schemaClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await schemaClient.end();}}
    await rm(tempDir,{recursive:true,force:true});
  });
  const deadline=Date.now()+20000;
  let lastResponse='no HTTP response';
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`PostgreSQL-backed server exited early: ${logs}`);
    try{const response=await fetch(`${base}/health`);lastResponse=`HTTP ${response.status}: ${await response.text()}`;if(response.ok)break;}catch(error){lastResponse=error.message;}
    await new Promise((resolvePromise)=>setTimeout(resolvePromise,120));
  }
  assert.ok(Date.now()<deadline,`PostgreSQL-backed server did not start (${lastResponse}): ${logs}`);

  async function request(path,{cookie,method='GET',body,headers={}}={}){
    const response=await fetch(`${base}${path}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
    const payload=await response.json();return{status:response.status,payload,headers:response.headers};
  }

  const registered=await request('/auth/register',{method:'POST',body:{fullName:'Amina Owner',organizationName:'Pamoja Homes',email:'amina.pg@example.test',password:'VeryStrongPass123!'}});
  assert.equal(registered.status,201,JSON.stringify(registered.payload));
  let cookie=registered.headers.get('set-cookie').split(';')[0];
  const logout=await request('/auth/logout',{cookie,method:'POST',body:{}});
  assert.equal(logout.status,200,JSON.stringify(logout.payload));
  const login=await request('/auth/login',{method:'POST',body:{email:'amina.pg@example.test',password:'VeryStrongPass123!'}});
  assert.equal(login.status,200,JSON.stringify(login.payload));
  cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal(login.payload.organization.id,registered.payload.organization.id);
  const staffInvite=await request('/staff-invitations',{cookie,method:'POST',body:{email:'manager.pg@example.test',role:'manager'}});
  assert.equal(staffInvite.status,201,JSON.stringify(staffInvite.payload));
  const staffToken=new URL(staffInvite.payload.invitationPath,'http://local.test').searchParams.get('token');
  const staffAccept=await request('/auth/accept-staff-invitation',{method:'POST',body:{token:staffToken,fullName:'Peter Manager',password:'ManagerSecurePassword123!'}});
  assert.equal(staffAccept.status,201,JSON.stringify(staffAccept.payload));
  assert.equal(staffAccept.payload.role,'manager');
  const property=await request('/properties',{cookie,method:'POST',body:{name:'Pamoja Court',propertyType:'Apartment building',county:'Nairobi',town:'Nairobi'}});
  assert.equal(property.status,201,JSON.stringify(property.payload));
  const unit=await request('/units',{cookie,method:'POST',body:{propertyId:property.payload.id,unitNumber:'C-10',category:'Apartment',monthlyRent:'25000',deposit:'25000'}});
  assert.equal(unit.status,201,JSON.stringify(unit.payload));
  const tenant=await request('/tenants',{cookie,method:'POST',body:{fullName:'Brian Tenant',phone:'0712345678',email:'brian.pg@example.test'}});
  assert.equal(tenant.status,201,JSON.stringify(tenant.payload));
  const tenantInvite=await request('/tenant-invitations',{cookie,method:'POST',body:{tenantId:tenant.payload.id}});
  assert.equal(tenantInvite.status,201,JSON.stringify(tenantInvite.payload));
  const tenantToken=new URL(tenantInvite.payload.invitationPath,'http://local.test').searchParams.get('token');
  const tenantAccept=await request('/auth/accept-invitation',{method:'POST',body:{token:tenantToken,password:'TenantSecurePassword789!'}});
  assert.equal(tenantAccept.status,201,JSON.stringify(tenantAccept.payload));
  const lease=await request('/leases',{cookie,method:'POST',body:{unitId:unit.payload.id,tenantId:tenant.payload.id,startDate:'2026-10-01',monthlyRent:'25000',deposit:'25000',dueDay:5}});
  assert.equal(lease.status,201,JSON.stringify(lease.payload));

  const period=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi'}).format(new Date()).slice(0,7);
  const billing=await request('/billing/generate',{cookie,method:'POST',body:{period}});
  assert.equal(billing.status,200,JSON.stringify(billing.payload));
  assert.equal(billing.payload.created,1);
  const payment=await request('/payments',{cookie,method:'POST',headers:{'Idempotency-Key':'pg-api-payment-1'},body:{tenantId:tenant.payload.id,amount:'12500',method:'cash',receivedDate:'2026-10-23'}});
  assert.equal(payment.status,201,JSON.stringify({payload:payment.payload,logs}));
  const invoiceList=await request('/invoices?limit=10&offset=0',{cookie});
  assert.equal(invoiceList.status,200,JSON.stringify(invoiceList.payload));
  assert.equal(invoiceList.payload.data[0].status,'part_paid');
  assert.equal(Number(invoiceList.payload.data[0].balance_cents),1250000);

  const events=await request('/audit?limit=100&offset=0',{cookie});
  assert.equal(events.status,200,JSON.stringify(events.payload));
  assert.ok(events.payload.data.length>=6);
});
