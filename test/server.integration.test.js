import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
let child,base,workspaceCookie,otherCookie,tempDir;

async function freePort(){
  const server=createServer();server.listen(0,'127.0.0.1');await new Promise((resolvePromise,reject)=>{server.once('listening',resolvePromise);server.once('error',reject);});
  const port=server.address().port;await new Promise(resolvePromise=>server.close(resolvePromise));return port;
}

async function request(path,{cookie,method='GET',body,headers={}}={}){
  const result=await fetch(`${base}${path}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const payload=await result.json();return {status:result.status,payload,headers:result.headers};
}

async function waitForServer(getLogs=()=> ''){
  const deadline=Date.now()+12000;
  let lastResponse='no HTTP response';
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error('Application process exited before becoming ready.');
    try{const response=await fetch(`${base}/health`);lastResponse=`HTTP ${response.status}: ${await response.text()}`;if(response.ok)return;}catch(error){lastResponse=error.message;}
    await new Promise(resolvePromise=>setTimeout(resolvePromise,120));
  }
  throw new Error(`Application did not become ready in time (${lastResponse}). Logs: ${getLogs()}`);
}

test('registration to partial rent payment stays within the owning organization',async(t)=>{
  tempDir=await mkdtemp(join(tmpdir(),'makazi-test-'));
  const port=await freePort();base=`http://127.0.0.1:${port}/api/v1`;
  child=spawn(process.execPath,['src/server.js'],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',PORT:String(port),HOST:'127.0.0.1',DB_PATH:join(tempDir,'integration.sqlite'),MAKAZI_DATABASE_URL:''},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',chunk=>logs+=chunk.toString());child.stderr.on('data',chunk=>logs+=chunk.toString());
  t.after(async()=>{
    if(child&&!child.killed){child.kill('SIGTERM');await new Promise(resolvePromise=>{child.once('exit',resolvePromise);setTimeout(resolvePromise,1500).unref();});}
    await rm(tempDir,{recursive:true,force:true});
  });
  await waitForServer(()=>logs);
  const pageResponse=await fetch(`${base.replace(/\/api\/v1$/,'')}/invite?token=sample`);
  assert.equal(pageResponse.status,200);
  assert.match(await pageResponse.text(),/id="app"/);
  assert.match(pageResponse.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal((await fetch(`${base.replace(/\/api\/v1$/,'')}/staff-invite?token=sample`)).status,200);

  let response=await request('/auth/register',{method:'POST',body:{fullName:'Amina Wanjiku',organizationName:'Kijani Homes',email:'amina@example.test',password:'VeryStrongPass123!'}});
  assert.equal(response.status,201,JSON.stringify(response.payload));
  workspaceCookie=response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  assert.equal(response.payload.organization.currency,'KES');
  assert.equal(response.payload.organization.timezone,'Africa/Nairobi');
  assert.equal((await request('/session',{cookie:workspaceCookie})).status,200);

  const rejected=await request('/properties',{cookie:workspaceCookie,method:'POST',headers:{Origin:'https://untrusted.example'},body:{name:'Blocked',propertyType:'Apartment building'}});
  assert.equal(rejected.status,403);
  const property=(await request('/properties',{cookie:workspaceCookie,method:'POST',body:{name:'Kijani Court',propertyType:'Apartment building',county:'Kiambu',town:'Thika'}}));
  assert.equal(property.status,201,JSON.stringify(property.payload));
  const propertySearch=await request('/properties?q=Kijani&limit=12&offset=0',{cookie:workspaceCookie});
  assert.equal(propertySearch.payload.page.total,1);
  const unit=await request('/units',{cookie:workspaceCookie,method:'POST',body:{propertyId:property.payload.id,unitNumber:'B-04',category:'Bedsitter',monthlyRent:'25000',deposit:'25000'}});
  assert.equal(unit.status,201,JSON.stringify(unit.payload));
  const unitSearch=await request('/units?q=B-04&limit=12&offset=0',{cookie:workspaceCookie});
  assert.equal(unitSearch.payload.page.total,1);
  const secondProperty=await request('/properties',{cookie:workspaceCookie,method:'POST',body:{name:'Kijani Annex',propertyType:'Residential estate',county:'Kiambu',town:'Thika'}});
  assert.equal(secondProperty.status,201);
  const secondUnit=await request('/units',{cookie:workspaceCookie,method:'POST',body:{propertyId:secondProperty.payload.id,unitNumber:'A-01',category:'Apartment',monthlyRent:'32000',deposit:'32000'}});
  assert.equal(secondUnit.status,201);

  const managerInvite=await request('/staff-invitations',{cookie:workspaceCookie,method:'POST',body:{email:'joseph.manager@example.test',role:'manager'}});
  assert.equal(managerInvite.status,201,JSON.stringify(managerInvite.payload));
  const managerToken=new URL(managerInvite.payload.invitationPath,'http://local.test').searchParams.get('token');
  const managerAccepted=await request('/auth/accept-staff-invitation',{method:'POST',body:{token:managerToken,fullName:'Joseph Manager',password:'ManagerSecurePassword123!'}});
  assert.equal(managerAccepted.status,201,JSON.stringify(managerAccepted.payload));assert.equal(managerAccepted.payload.role,'manager');
  const managerCookie=managerAccepted.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/staff?limit=10&offset=0',{cookie:managerCookie})).status,403);
  const managerSettings=await request('/settings',{cookie:managerCookie,method:'PATCH',body:{name:'Unauthorized',expenseApprovalThreshold:'0'}});
  assert.equal(managerSettings.status,403);

  const caretakerInvite=await request('/staff-invitations',{cookie:workspaceCookie,method:'POST',body:{email:'simon.caretaker@example.test',role:'caretaker',propertyIds:[property.payload.id]}});
  assert.equal(caretakerInvite.status,201);
  const caretakerToken=new URL(caretakerInvite.payload.invitationPath,'http://local.test').searchParams.get('token');
  const caretakerAccepted=await request('/auth/accept-staff-invitation',{method:'POST',body:{token:caretakerToken,fullName:'Simon Caretaker',password:'CaretakerSecurePassword123!'}});
  assert.equal(caretakerAccepted.status,201);assert.equal(caretakerAccepted.payload.role,'caretaker');
  const caretakerCookie=caretakerAccepted.headers.get('set-cookie').split(';')[0];
  const caretakerUnits=await request('/caretaker/units?limit=10&offset=0',{cookie:caretakerCookie});
  assert.equal(caretakerUnits.payload.page.total,1);assert.equal(caretakerUnits.payload.data[0].property_id,property.payload.id);
  const caretakerAllProperties=await request('/properties?limit=10&offset=0',{cookie:caretakerCookie});
  assert.equal(caretakerAllProperties.status,403);
  const caretakerFinancials=await request('/payments?limit=10&offset=0',{cookie:caretakerCookie});
  assert.equal(caretakerFinancials.status,403);
  const caretakerCrossAssignment=await request('/caretaker/maintenance',{cookie:caretakerCookie,method:'POST',body:{unitId:secondUnit.payload.id,title:'Unauthorized request',category:'General',description:'Should be denied'}});
  assert.equal(caretakerCrossAssignment.status,404);
  const thirdStaffInvite=await request('/staff-invitations',{cookie:workspaceCookie,method:'POST',body:{email:'accountant@example.test',role:'accountant'}});
  assert.equal(thirdStaffInvite.status,409);
  const staffList=await request('/staff',{cookie:workspaceCookie});
  assert.equal(staffList.status,200);assert.equal(staffList.payload.members.filter(member=>member.role!=='owner').length,2);
  const tenant=await request('/tenants',{cookie:workspaceCookie,method:'POST',body:{fullName:'Brian Mwangi',phone:'+254 712 345 678',email:'brian@example.test'}});
  assert.equal(tenant.status,201,JSON.stringify(tenant.payload));
  const lease=await request('/leases',{cookie:workspaceCookie,method:'POST',body:{unitId:unit.payload.id,tenantId:tenant.payload.id,startDate:'2026-10-01',monthlyRent:'25000',deposit:'25000',dueDay:5}});
  assert.equal(lease.status,201,JSON.stringify(lease.payload));

  const period=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi'}).format(new Date()).slice(0,7);
  const generated=await request('/billing/generate',{cookie:workspaceCookie,method:'POST',body:{period}});
  assert.equal(generated.status,200);assert.equal(generated.payload.created,1);
  const repeated=await request('/billing/generate',{cookie:workspaceCookie,method:'POST',body:{period}});
  assert.equal(repeated.payload.created,0);assert.equal(repeated.payload.skipped,1);

  const sandboxUnavailable=await request('/payments/mpesa/stk-push',{cookie:workspaceCookie,method:'POST',headers:{'Idempotency-Key':'sandbox-payment-1'},body:{tenantId:tenant.payload.id,phone:'+254 712 345 678',amount:'25000'}});
  assert.equal(sandboxUnavailable.status,503);
  const noFakeRequest=await request('/payments/mpesa/transactions?limit=10&offset=0',{cookie:workspaceCookie});
  assert.equal(noFakeRequest.payload.page.total,0);

  const payment=await request('/payments',{cookie:workspaceCookie,method:'POST',headers:{'Idempotency-Key':'integration-payment-1'},body:{tenantId:tenant.payload.id,method:'bank',amount:'10000',receivedDate:'2026-10-23',reference:'BANK-001'}});
  assert.equal(payment.status,201,JSON.stringify(payment.payload));assert.equal(payment.payload.allocatedCents,1000000);assert.equal(payment.payload.unallocatedCents,0);
  const invoice=await request('/invoices?limit=10&offset=0',{cookie:workspaceCookie});
  assert.equal(invoice.payload.data[0].status,'part_paid');assert.equal(invoice.payload.data[0].balance_cents,1500000);
  const secondPayment=await request('/payments',{cookie:workspaceCookie,method:'POST',headers:{'Idempotency-Key':'integration-payment-2'},body:{tenantId:tenant.payload.id,method:'cash',amount:'20000',receivedDate:'2026-10-23'}});
  assert.equal(secondPayment.status,201);assert.equal(secondPayment.payload.allocatedCents,1500000);assert.equal(secondPayment.payload.unallocatedCents,500000);
  const duplicate=await request('/payments',{cookie:workspaceCookie,method:'POST',headers:{'Idempotency-Key':'integration-payment-2'},body:{tenantId:tenant.payload.id,method:'cash',amount:'99999',receivedDate:'2026-10-23'}});
  assert.equal(duplicate.status,200);assert.equal(duplicate.payload.duplicate,true);assert.equal(duplicate.payload.id,secondPayment.payload.id);
  const settled=await request('/invoices?limit=10&offset=0',{cookie:workspaceCookie});
  assert.equal(settled.payload.data[0].status,'paid');assert.equal(settled.payload.data[0].balance_cents,0);
  const leasePage=await request('/leases?limit=10&offset=0',{cookie:workspaceCookie});
  const leaseId=leasePage.payload.data[0].id;
  const amendment=await request(`/leases/${leaseId}`,{cookie:workspaceCookie,method:'PATCH',body:{monthlyRent:'26000',deposit:'30000',dueDay:6}});
  assert.equal(amendment.status,200);assert.equal(amendment.payload.changedFields.length,3);
  const depositReceipt=await request(`/leases/${leaseId}/deposits`,{cookie:workspaceCookie,method:'POST',headers:{'Idempotency-Key':'deposit-receipt-1'},body:{type:'received',amount:'25000',method:'bank',reference:'DEP-001'}});
  assert.equal(depositReceipt.status,201);
  const depositRefund=await request(`/leases/${leaseId}/deposits`,{cookie:workspaceCookie,method:'POST',headers:{'Idempotency-Key':'deposit-refund-1'},body:{type:'refunded',amount:'5000',method:'bank',reference:'DEP-REF-1'}});
  assert.equal(depositRefund.status,201);
  const depositLedger=await request(`/leases/${leaseId}/deposits`,{cookie:workspaceCookie});
  assert.equal(depositLedger.payload.expectedCents,3000000);assert.equal(depositLedger.payload.held_cents,2000000);
  const excessiveRefund=await request(`/leases/${leaseId}/deposits`,{cookie:workspaceCookie,method:'POST',headers:{'Idempotency-Key':'deposit-refund-2'},body:{type:'refunded',amount:'25000',method:'bank'}});
  assert.equal(excessiveRefund.status,409);
  const leaseHistory=await request(`/leases/${leaseId}/history`,{cookie:workspaceCookie});
  assert.equal(leaseHistory.payload.data.length,2);

  const expense=await request('/expenses',{cookie:workspaceCookie,method:'POST',body:{propertyId:property.payload.id,category:'Repairs and maintenance',amount:'12000',spentOn:'2026-10-23',supplier:'Maji Works',description:'Tap repair'}});
  assert.equal(expense.status,201);assert.equal(expense.payload.status,'pending_approval');
  const approved=await request(`/expenses/${expense.payload.id}/approval`,{cookie:workspaceCookie,method:'PATCH',body:{status:'approved'}});
  assert.equal(approved.status,200);
  const ticket=await request('/maintenance',{cookie:workspaceCookie,method:'POST',body:{unitId:unit.payload.id,tenantId:tenant.payload.id,title:'Kitchen tap leak',category:'Plumbing',priority:'high',description:'Tap is dripping',estimate:'3500'}});
  assert.equal(ticket.status,201);
  const ticketUpdate=await request(`/maintenance/${ticket.payload.id}`,{cookie:workspaceCookie,method:'PATCH',body:{status:'in_progress'}});
  assert.equal(ticketUpdate.status,200);
  const invitation=await request('/tenant-invitations',{cookie:workspaceCookie,method:'POST',body:{tenantId:tenant.payload.id}});
  assert.equal(invitation.status,201,JSON.stringify(invitation.payload));
  const inviteToken=new URL(invitation.payload.invitationPath,'http://local.test').searchParams.get('token');
  assert.ok(inviteToken);
  const accepted=await request('/auth/accept-invitation',{method:'POST',body:{token:inviteToken,password:'TenantSecurePassword789!'}});
  assert.equal(accepted.status,201,JSON.stringify(accepted.payload));
  const tenantCookie=accepted.headers.get('set-cookie').split(';')[0];
  const tenantSession=await request('/session',{cookie:tenantCookie});
  assert.equal(tenantSession.payload.role,'tenant');
  const tenantPortal=await request('/tenant/portal',{cookie:tenantCookie});
  assert.equal(tenantPortal.status,200);assert.equal(tenantPortal.payload.tenant.id,tenant.payload.id);assert.equal(tenantPortal.payload.balance,0);
  const privateList=await request('/properties?limit=10&offset=0',{cookie:tenantCookie});
  assert.equal(privateList.status,403);
  const tenantTicket=await request('/tenant/maintenance',{cookie:tenantCookie,method:'POST',body:{title:'Window latch',category:'General',priority:'normal',description:'The bedroom latch is loose.'}});
  assert.equal(tenantTicket.status,201);
  const tenantTickets=await request('/tenant/maintenance?limit=10&offset=0',{cookie:tenantCookie});
  assert.equal(tenantTickets.payload.page.total,2);
  const reusedInvitation=await request('/auth/accept-invitation',{method:'POST',body:{token:inviteToken,password:'TenantAnotherPassword012!'}});
  assert.equal(reusedInvitation.status,400);
  const tenantProfile=await request('/tenant/profile',{cookie:tenantCookie,method:'PATCH',body:{phone:'+254 712 345 679',email:'brian@example.test'}});
  assert.equal(tenantProfile.status,200);
  const tenantLogout=await request('/auth/logout',{cookie:tenantCookie,method:'POST',body:{}});
  assert.equal(tenantLogout.status,200);
  const tenantLogin=await request('/auth/login',{method:'POST',body:{email:'brian@example.test',password:'TenantSecurePassword789!'}});
  assert.equal(tenantLogin.status,200);assert.equal(tenantLogin.payload.role,'tenant');
  const returningTenantCookie=tenantLogin.headers.get('set-cookie').split(';')[0];
  const returningPortal=await request('/tenant/portal',{cookie:returningTenantCookie});
  assert.equal(returningPortal.status,200);assert.equal(returningPortal.payload.depositHeldCents,2000000);
  const leaseEnd=await request(`/leases/${leaseId}/end`,{cookie:workspaceCookie,method:'POST',body:{endDate:'2026-10-23'}});
  assert.equal(leaseEnd.status,200);
  const releasedUnit=await request('/units?q=B-04&limit=10&offset=0',{cookie:workspaceCookie});
  assert.equal(releasedUnit.payload.data[0].status,'vacant');

  const other=await request('/auth/register',{method:'POST',body:{fullName:'Other Owner',organizationName:'Other Homes',email:'other@example.test',password:'AnotherStrongPass456!'}});
  assert.equal(other.status,201);otherCookie=other.headers.get('set-cookie').split(';')[0];
  const otherProperties=await request('/properties?limit=20&offset=0',{cookie:otherCookie});
  assert.deepEqual(otherProperties.payload.data,[]);
  const crossTenant=await request('/units',{cookie:otherCookie,method:'POST',body:{propertyId:property.payload.id,unitNumber:'X-1',monthlyRent:'1000',deposit:'0'}});
  assert.equal(crossTenant.status,404);
  const exportAudit=await request('/exports',{cookie:workspaceCookie,method:'POST',body:{resource:'properties',rows:1}});
  assert.equal(exportAudit.status,200);
  const audit=await request('/audit?limit=100&offset=0',{cookie:workspaceCookie});
  assert.ok(audit.payload.data.some(event=>event.action==='data.exported'));
  assert.ok(audit.payload.data.some(event=>event.action==='tenant.invitation_created'));
  const health=await request('/health');assert.equal(health.status,200);assert.equal(health.payload.ok,true);
  assert.match(health.headers.get('x-content-type-options'),/nosniff/);
  assert.doesNotMatch(logs,/VeryStrongPass123|AnotherStrongPass456|password_hash/);
});
