import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, transaction, audit, withAuthLookup, withRequest } from './db.js';
import { allocatePayment, arrearsBucket, ageInDays, can, dueDateForPeriod, moneyToCents } from './domain.js';
import { DarajaSandboxProvider, normalizeKenyanPhone, parseDarajaCallback, resolveVerifiedCallback, ProviderUnavailableError } from './providers/daraja.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(root, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const sessionHours = Math.max(1, Math.min(168, Number(process.env.SESSION_TTL_HOURS || 12)));
const MAX_BODY = 1024 * 1024;
const loginAttempts = new Map();
const callbackAttempts = new Map();
const responseContext = new AsyncLocalStorage();
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, message, code = 'request_error') { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());

function sendJson(res, status, payload) {
  const staged=responseContext.getStore();
  if(staged){staged.response={status,payload};return;}
  sendJsonNow(res,status,payload);
}

function sendJsonNow(res,status,payload){
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value !== undefined).map(([key, value]) => [key, decodeURIComponent(value)]));
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.toLowerCase().startsWith('application/json')) fail(415, 'Send request data as JSON.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) fail(413, 'Request is too large.');
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { fail(400, 'Request data is not valid JSON.'); }
}

function text(value, label, max = 160, required = true) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) fail(400, `${label} is required.`);
  if (result.length > max) fail(400, `${label} must be ${max} characters or fewer.`);
  return result;
}

function date(value, label, required = true) {
  const result = text(value, label, 10, required);
  if (!result && !required) return null;
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) fail(400, `${label} must be a valid date in YYYY-MM-DD format.`);
  return result;
}

function validEmail(email) {
  const result = text(email, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'Enter a valid email address.');
  return result;
}

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function passwordMatches(password, stored) {
  const [scheme, salt, expectedHex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function originIsSame(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    const expectedHost = req.headers.host;
    const expectedProtocol = process.env.NODE_ENV === 'production' ? 'https:' : 'http:';
    if (parsed.host !== expectedHost || (parsed.protocol !== expectedProtocol && !(process.env.NODE_ENV === 'production' && parsed.protocol === 'https:'))) fail(403, 'This request could not be verified.', 'origin_rejected');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(403, 'This request could not be verified.', 'origin_rejected');
  }
}

async function currentSession(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token || token.length > 256) return null;
  const session = await withAuthLookup(()=>db.prepare(`SELECT u.id AS user_id,u.full_name,u.email,COALESCE(m.organization_id,tu.organization_id) AS organization_id,
    CASE WHEN m.user_id IS NOT NULL THEN m.role ELSE 'tenant' END AS role,tu.tenant_id,
    o.name AS organization_name,o.currency,o.timezone,o.plan_id,o.status AS organization_status
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN organization_memberships m ON m.user_id=u.id
    LEFT JOIN tenant_users tu ON tu.user_id=u.id AND m.user_id IS NULL
    JOIN organizations o ON o.id=COALESCE(m.organization_id,tu.organization_id)
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND (m.user_id IS NOT NULL OR tu.user_id IS NOT NULL)
    ORDER BY COALESCE(m.created_at,tu.created_at) LIMIT 1`).get(hash(token), new Date().toISOString()));
  return session || null;
}

async function requireSession(req) {
  const session = await currentSession(req);
  if (!session) fail(401, 'Please sign in to continue.', 'authentication_required');
  if (session.organization_status !== 'active') fail(403, 'This workspace is currently suspended. Contact its administrator.', 'organization_suspended');
  return session;
}

function requirePermission(session, action) {
  if (!can(session.role, action)) fail(403, 'You do not have permission to perform this action.', 'permission_denied');
}

async function setSession(res, userId, organizationId=null) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000).toISOString();
  await transaction(()=>db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), userId, expiresAt),organizationId,userId);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionHours * 3600}${secure}`);
}

async function clearSession(req, res) {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

function pagination(url) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10) || 30));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  return { limit, offset };
}

async function listResult(sql, countSql, organizationId, url, searchValue = '', filters = []) {
  const { limit, offset } = pagination(url);
  const search = searchValue ? `%${searchValue.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%` : null;
  const args = [organizationId, search, search, ...filters];
  const data = await db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const total = (await db.prepare(countSql).get(...args)).count;
  return { data, page: { limit, offset, total, hasMore: offset + data.length < total } };
}

async function auditAction(session, action, entityType, entityId, metadata = {}) {
  return await audit({ organizationId: session.organization_id, actorId: session.user_id, action, entityType, entityId, metadata });
}

function requireRecord(result, label = 'Record') {
  if (!result) fail(404, `${label} was not found.`, 'not_found');
  return result;
}

function loginLimit(ip) {
  const record = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  if (record.resetAt < Date.now()) { record.count = 0; record.resetAt = Date.now() + 10 * 60 * 1000; }
  if (record.count >= 8) fail(429, 'Too many sign-in attempts. Try again in a few minutes.', 'rate_limited');
  record.count += 1;
  loginAttempts.set(ip, record);
}

function callbackLimit(ip){
  const now=Date.now();const record=callbackAttempts.get(ip)||{count:0,resetAt:now+60_000};
  if(record.resetAt<now){record.count=0;record.resetAt=now+60_000;}
  if(record.count>=60)fail(429,'Callback rate limit reached.','rate_limited');
  record.count+=1;callbackAttempts.set(ip,record);
}

async function invoiceBalances(organizationId, tenantId = null) {
  const where = tenantId ? 'AND i.tenant_id=?' : '';
  return await db.prepare(`SELECT i.id,i.tenant_id,i.due_date,i.total_cents,
    i.total_cents-COALESCE(SUM(CASE WHEN p.status='confirmed' THEN a.amount_cents ELSE 0 END),0) AS balance_cents
    FROM invoices i LEFT JOIN payment_allocations a ON a.invoice_id=i.id AND a.organization_id=i.organization_id
    LEFT JOIN payments p ON p.id=a.payment_id AND p.organization_id=a.organization_id
    WHERE i.organization_id=? AND i.status<>'void' ${where}
    GROUP BY i.id HAVING i.total_cents-COALESCE(SUM(CASE WHEN p.status='confirmed' THEN a.amount_cents ELSE 0 END),0)>0 ORDER BY i.due_date,i.id`).all(...(tenantId ? [organizationId, tenantId] : [organizationId]));
}

async function refreshInvoiceStatus(organizationId, invoiceId) {
  const row = await db.prepare(`SELECT i.total_cents,COALESCE(SUM(CASE WHEN p.status='confirmed' THEN a.amount_cents ELSE 0 END),0) AS paid
    FROM invoices i LEFT JOIN payment_allocations a ON a.invoice_id=i.id AND a.organization_id=i.organization_id
    LEFT JOIN payments p ON p.id=a.payment_id AND p.organization_id=a.organization_id
    WHERE i.id=? AND i.organization_id=? GROUP BY i.id`).get(invoiceId, organizationId);
  if (row) await db.prepare('UPDATE invoices SET status=? WHERE id=? AND organization_id=?').run(row.paid >= row.total_cents ? 'paid' : row.paid > 0 ? 'part_paid' : 'open', invoiceId, organizationId);
}

async function createConfirmedPayment({ organizationId, tenantId, amountCents, method, receivedDate, reference, idempotencyKey, actorId }) {
  const id=randomUUID();
  await db.prepare(`INSERT INTO payments(id,organization_id,tenant_id,method,amount_cents,received_date,reference,idempotency_key,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id,organizationId,tenantId,method,amountCents,receivedDate,reference,idempotencyKey,actorId);
  const invoices=(await invoiceBalances(organizationId,tenantId)).map(row=>({id:row.id,dueDate:row.due_date,balanceCents:row.balance_cents}));
  const allocation=allocatePayment(amountCents,invoices);
  for(const item of allocation.allocations){
    await db.prepare('INSERT INTO payment_allocations(id,organization_id,payment_id,invoice_id,amount_cents) VALUES(?,?,?,?,?)').run(randomUUID(),organizationId,id,item.invoiceId,item.amountCents);
    await refreshInvoiceStatus(organizationId,item.invoiceId);
  }
  return {id,allocatedCents:amountCents-allocation.unallocatedCents,unallocatedCents:allocation.unallocatedCents};
}

async function jsonRows(sql, organizationId, params = []) {
  return await db.prepare(sql).all(organizationId, ...params);
}

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = req.method || 'GET';
  if (!path.startsWith('/api/v1/')) return false;

  if (method !== 'GET' && method !== 'HEAD' && path !== '/api/v1/auth/login' && path !== '/api/v1/auth/register') originIsSame(req);
  if (method === 'GET' && path === '/api/v1/health') return sendJson(res, 200, { ok: true, service: 'makazi', time: new Date().toISOString() });

  if (method === 'POST' && path === '/api/v1/auth/register') {
    const body = await readJson(req);
    const fullName = text(body.fullName, 'Full name', 120);
    const organizationName = text(body.organizationName, 'Business name', 120);
    const email = validEmail(body.email);
    if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 200) fail(400, 'Use a password between 12 and 200 characters.');
    const organizationId = randomUUID();
    const userId = randomUUID();
    try {
      await transaction(async () => {
        await db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run(organizationId, organizationName);
        await db.prepare('INSERT INTO users(id,full_name,email,password_hash) VALUES(?,?,?,?)').run(userId, fullName, email, passwordHash(body.password));
        await db.prepare('INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(?,?,?)').run(organizationId, userId, 'owner');
      },organizationId,userId);
    } catch (error) {
      if (String(error.message).includes('users.email')) fail(409, 'An account with this email already exists.', 'email_in_use');
      throw error;
    }
    await setSession(res, userId);
    await audit({ organizationId, actorId: userId, action: 'organization.created', entityType: 'organization', entityId: organizationId });
    return sendJson(res, 201, { user: { id: userId, fullName, email }, organization: { id: organizationId, name: organizationName, currency: 'KES', timezone: 'Africa/Nairobi' }, role: 'owner' });
  }

  if (method === 'POST' && path === '/api/v1/auth/login') {
    loginLimit(req.socket.remoteAddress || 'unknown');
    const body = await readJson(req);
    const email = validEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const identity = await withAuthLookup(async()=>{
      const user = await db.prepare('SELECT id,full_name,email,password_hash FROM users WHERE email=? COLLATE NOCASE AND active=1').get(email);
      if (!user || !passwordMatches(password, user.password_hash)) fail(401, 'Email or password was not recognized.', 'invalid_credentials');
      const org = await db.prepare(`SELECT COALESCE(m.organization_id,tu.organization_id) AS organization_id,
      CASE WHEN m.user_id IS NOT NULL THEN m.role ELSE 'tenant' END AS role,tu.tenant_id,
      o.name AS organization_name,o.currency,o.timezone,o.status AS organization_status
      FROM users u LEFT JOIN organization_memberships m ON m.user_id=u.id
      LEFT JOIN tenant_users tu ON tu.user_id=u.id AND m.user_id IS NULL
      JOIN organizations o ON o.id=COALESCE(m.organization_id,tu.organization_id)
      WHERE u.id=? ORDER BY COALESCE(m.created_at,tu.created_at) LIMIT 1`).get(user.id);
      return {user,org};
    });
    const {user,org}=identity;
    if (!org) fail(403, 'This account is not linked to a workspace.', 'membership_required');
    await setSession(res, user.id, org.organization_id);
    await audit({ organizationId: org.organization_id, actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    return sendJson(res, 200, { user: { id: user.id, fullName: user.full_name, email: user.email }, organization: { id: org.organization_id, name: org.organization_name, currency: org.currency, timezone: org.timezone }, role: org.role, tenantId: org.tenant_id||null });
  }

  if(method==='POST'&&path==='/api/v1/auth/accept-invitation'){
    const body=await readJson(req);const token=text(body.token,'Invitation token',160);
    if(typeof body.password!=='string'||body.password.length<12||body.password.length>200)fail(400,'Use a password between 12 and 200 characters.');
    const candidate=await withAuthLookup(()=>db.prepare(`SELECT id,organization_id FROM invitations
      WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?`).get(hash(token),new Date().toISOString()));
    if(!candidate)fail(400,'This invitation is invalid or has expired.','invitation_invalid');
    const userId=randomUUID();
    let invitation;
    try{
      await transaction(async()=>{
        invitation=await db.prepare(`SELECT i.*,t.full_name,o.name AS organization_name,o.currency,o.timezone FROM invitations i
          JOIN tenants t ON t.id=i.tenant_id AND t.organization_id=i.organization_id
          JOIN organizations o ON o.id=i.organization_id
          WHERE i.id=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?`).get(candidate.id,new Date().toISOString());
        if(!invitation)fail(400,'This invitation is invalid or has expired.','invitation_invalid');
        await db.prepare('INSERT INTO users(id,full_name,email,password_hash) VALUES(?,?,?,?)').run(userId,invitation.full_name,invitation.email,passwordHash(body.password));
        await db.prepare('INSERT INTO tenant_users(organization_id,user_id,tenant_id) VALUES(?,?,?)').run(invitation.organization_id,userId,invitation.tenant_id);
        const redeemed=await db.prepare("UPDATE invitations SET accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?").run(invitation.id,new Date().toISOString());
        if(!redeemed.changes)fail(400,'This invitation is invalid or has expired.','invitation_invalid');
        await audit({organizationId:invitation.organization_id,actorId:userId,action:'tenant.invitation_accepted',entityType:'tenant',entityId:invitation.tenant_id});
      },candidate.organization_id,userId);
    }catch(error){
      if(String(error.message).includes('users.email'))fail(409,'An account with this email already exists. Ask the workspace manager to use a different email.','email_in_use');
      throw error;
    }
    await setSession(res,userId,invitation.organization_id);
    return sendJson(res,201,{user:{id:userId,fullName:invitation.full_name,email:invitation.email},organization:{id:invitation.organization_id,name:invitation.organization_name,currency:invitation.currency,timezone:invitation.timezone},role:'tenant',tenantId:invitation.tenant_id});
  }

  if(method==='POST'&&path==='/api/v1/auth/accept-staff-invitation'){
    const body=await readJson(req);const token=text(body.token,'Invitation token',160);
    if(typeof body.password!=='string'||body.password.length<12||body.password.length>200)fail(400,'Use a password between 12 and 200 characters.');
    const candidate=await withAuthLookup(()=>db.prepare(`SELECT id,organization_id FROM staff_invitations
      WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?`).get(hash(token),new Date().toISOString()));
    if(!candidate)fail(400,'This invitation is invalid or has expired.','invitation_invalid');
    const userId=randomUUID();
    let invitation;
    try{
      await transaction(async()=>{
        invitation=await db.prepare(`SELECT i.*,o.name AS organization_name,o.currency,o.timezone FROM staff_invitations i
          JOIN organizations o ON o.id=i.organization_id
          WHERE i.id=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?`).get(candidate.id,new Date().toISOString());
        if(!invitation)fail(400,'This invitation is invalid or has expired.','invitation_invalid');
        await db.prepare('INSERT INTO users(id,full_name,email,password_hash) VALUES(?,?,?,?)').run(userId,text(body.fullName,'Full name',120),invitation.email,passwordHash(body.password));
        await db.prepare('INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(?,?,?)').run(invitation.organization_id,userId,invitation.role);
        await db.prepare(`INSERT INTO staff_property_assignments(organization_id,user_id,property_id,assigned_by)
          SELECT p.organization_id,?,p.property_id,i.created_by FROM staff_invitation_properties p
          JOIN staff_invitations i ON i.id=p.invitation_id AND i.organization_id=p.organization_id
          WHERE p.invitation_id=? AND p.organization_id=?`).run(userId,invitation.id,invitation.organization_id);
        const redeemed=await db.prepare("UPDATE staff_invitations SET accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?").run(invitation.id,new Date().toISOString());
        if(!redeemed.changes)fail(400,'This invitation is invalid or has expired.','invitation_invalid');
        await audit({organizationId:invitation.organization_id,actorId:userId,action:'staff.invitation_accepted',entityType:'user',entityId:userId,metadata:{role:invitation.role}});
      },candidate.organization_id,userId);
    }catch(error){
      if(String(error.message).includes('users.email'))fail(409,'An account with this email already exists. Ask the workspace owner to use a different email.','email_in_use');
      throw error;
    }
    await setSession(res,userId,invitation.organization_id);
    return sendJson(res,201,{user:{id:userId,fullName:text(body.fullName,'Full name',120),email:invitation.email},organization:{id:invitation.organization_id,name:invitation.organization_name,currency:invitation.currency,timezone:invitation.timezone},role:invitation.role});
  }

  if (method === 'POST' && path === '/api/v1/auth/logout') {
    await clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if(method==='POST'&&path==='/api/v1/payments/mpesa/callback'){
    callbackLimit(req.socket.remoteAddress||'unknown');
    const payload=await readJson(req);const callback=parseDarajaCallback(payload);
    if(!callback)return sendJson(res,400,{ResultCode:1,ResultDesc:'Invalid callback.'});
    const transactionRow=await withAuthLookup(()=>db.prepare('SELECT * FROM mpesa_transactions WHERE checkout_request_id=?').get(callback.checkoutRequestId));
    if(!transactionRow)return sendJson(res,200,{ResultCode:0,ResultDesc:'Accepted.'});
    if(['confirmed','failed'].includes(transactionRow.status))return sendJson(res,200,{ResultCode:0,ResultDesc:'Already processed.'});
    let provider;
    try{provider=new DarajaSandboxProvider();}catch(error){if(error instanceof ProviderUnavailableError)return sendJson(res,503,{ResultCode:1,ResultDesc:'Verification is temporarily unavailable.'});throw error;}
    const verification=await provider.verify(callback);
    const normalizedPhone=callback.phoneNumber?normalizeKenyanPhone(callback.phoneNumber):'';
    const outcome=resolveVerifiedCallback({...callback,amountCents:normalizedPhone&&normalizedPhone===transactionRow.phone_number?callback.amountCents:null},transactionRow,verification);
    if(outcome.status==='pending')return sendJson(res,200,{ResultCode:0,ResultDesc:'Pending verification.'});
    if(outcome.status==='failed'){
      await transaction(async()=>{
        const latest=await db.prepare('SELECT status FROM mpesa_transactions WHERE id=?').get(transactionRow.id);
        if(latest.status==='pending'){
          await db.prepare("UPDATE mpesa_transactions SET status='failed',callback_result_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(callback.resultCode,transactionRow.id);
          await audit({organizationId:transactionRow.organization_id,actorId:transactionRow.requested_by,action:'mpesa.payment_failed',entityType:'mpesa_transaction',entityId:transactionRow.id,metadata:{resultCode:callback.resultCode}});
        }
      },transactionRow.organization_id);
      return sendJson(res,200,{ResultCode:0,ResultDesc:'Failure recorded.'});
    }
    try{
      await transaction(async()=>{
        const latest=await db.prepare('SELECT status FROM mpesa_transactions WHERE id=?').get(transactionRow.id);
        if(latest.status!=='pending')return;
        const duplicateReceipt=await db.prepare('SELECT id FROM mpesa_transactions WHERE provider_receipt=? AND id<>?').get(outcome.receiptNumber,transactionRow.id);
        if(duplicateReceipt){await db.prepare("UPDATE mpesa_transactions SET status='unmatched',callback_result_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(callback.resultCode,transactionRow.id);return;}
        const payment=await createConfirmedPayment({organizationId:transactionRow.organization_id,tenantId:transactionRow.tenant_id,amountCents:transactionRow.amount_cents,method:'mpesa_sandbox',receivedDate:today(),reference:outcome.receiptNumber,idempotencyKey:`mpesa:${transactionRow.id}`,actorId:transactionRow.requested_by});
        await db.prepare("UPDATE mpesa_transactions SET status='confirmed',provider_receipt=?,callback_result_code=?,payment_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(outcome.receiptNumber,callback.resultCode,payment.id,transactionRow.id);
        await audit({organizationId:transactionRow.organization_id,actorId:transactionRow.requested_by,action:'mpesa.payment_confirmed',entityType:'mpesa_transaction',entityId:transactionRow.id,metadata:{receipt:outcome.receiptNumber,amountCents:transactionRow.amount_cents,allocatedCents:payment.allocatedCents}});
      },transactionRow.organization_id);
    }catch(error){
      if(String(error.message).includes('mpesa_receipt_unique_idx'))return sendJson(res,200,{ResultCode:0,ResultDesc:'Receipt requires reconciliation.'});
      throw error;
    }
    return sendJson(res,200,{ResultCode:0,ResultDesc:'Payment processed.'});
  }

  const session = await requireSession(req);
  const orgId = session.organization_id;

  if (method === 'GET' && path === '/api/v1/session') {
    return sendJson(res, 200, { user: { id: session.user_id, fullName: session.full_name, email: session.email }, organization: { id: orgId, name: session.organization_name, currency: session.currency, timezone: session.timezone, planId: session.plan_id }, role: session.role, tenantId:session.tenant_id||null });
  }

  if(session.role==='tenant'){
    const tenantId=session.tenant_id;
    if(method==='GET'&&path==='/api/v1/tenant/portal'){
      const tenant=requireRecord(await db.prepare('SELECT id,full_name,phone,email FROM tenants WHERE id=? AND organization_id=?').get(tenantId,orgId),'Tenant');
      const lease=await db.prepare(`SELECT l.id,l.start_date,l.end_date,l.monthly_rent_cents,l.deposit_cents,l.due_day,u.unit_number,p.name AS property_name,p.address,p.town,p.county
        FROM leases l JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
        WHERE l.tenant_id=? AND l.organization_id=? AND l.status='active' ORDER BY l.start_date DESC LIMIT 1`).get(tenantId,orgId);
      const balance=await db.prepare(`SELECT COALESCE(SUM(i.total_cents),0)-COALESCE((SELECT SUM(a.amount_cents) FROM payment_allocations a JOIN invoices pi ON pi.id=a.invoice_id AND pi.organization_id=a.organization_id WHERE pi.tenant_id=? AND a.organization_id=?),0) AS balance_cents,
        COUNT(CASE WHEN i.due_date<? AND i.status<>'paid' THEN 1 END) AS overdue_count
        FROM invoices i WHERE i.tenant_id=? AND i.organization_id=? AND i.status<>'void'`).get(tenantId,orgId,today(),tenantId,orgId);
      const depositHeldCents=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN transaction_type='received' THEN amount_cents ELSE -amount_cents END),0) AS held_cents
        FROM deposit_transactions WHERE tenant_id=? AND organization_id=?`).get(tenantId,orgId).held_cents;
      const invoices=await db.prepare(`SELECT i.id,i.invoice_number,i.period,i.due_date,i.total_cents,i.status,i.total_cents-COALESCE(SUM(a.amount_cents),0) AS balance_cents
        FROM invoices i LEFT JOIN payment_allocations a ON a.invoice_id=i.id AND a.organization_id=i.organization_id WHERE i.tenant_id=? AND i.organization_id=?
        AND i.status<>'void' GROUP BY i.id ORDER BY i.due_date DESC LIMIT 5`).all(tenantId,orgId);
      const payments=await db.prepare(`SELECT id,amount_cents,method,received_date,reference FROM payments WHERE tenant_id=? AND organization_id=? AND status='confirmed' ORDER BY received_date DESC LIMIT 5`).all(tenantId,orgId);
      const maintenance=await db.prepare(`SELECT id,title,category,priority,status,created_at FROM maintenance_tickets WHERE tenant_id=? AND organization_id=? ORDER BY created_at DESC LIMIT 5`).all(tenantId,orgId);
      return sendJson(res,200,{tenant,lease:lease||null,balance:balance.balance_cents,depositHeldCents,overdueCount:balance.overdue_count,invoices,payments,maintenance});
    }
    if(method==='GET'&&path==='/api/v1/tenant/invoices'){
      const {limit,offset}=pagination(url);const data=await db.prepare(`SELECT i.id,i.invoice_number,i.period,i.issue_date,i.due_date,i.total_cents,i.status,
        i.total_cents-COALESCE(SUM(a.amount_cents),0) AS balance_cents FROM invoices i LEFT JOIN payment_allocations a ON a.invoice_id=i.id AND a.organization_id=i.organization_id
        WHERE i.tenant_id=? AND i.organization_id=? AND i.status<>'void' GROUP BY i.id ORDER BY i.due_date DESC LIMIT ? OFFSET ?`).all(tenantId,orgId,limit,offset);
      const total=(await db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE tenant_id=? AND organization_id=? AND status<>'void'").get(tenantId,orgId)).count;
      return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
    }
    if(method==='GET'&&path==='/api/v1/tenant/payments'){
      const {limit,offset}=pagination(url);const data=await db.prepare("SELECT id,amount_cents,method,received_date,reference FROM payments WHERE tenant_id=? AND organization_id=? AND status='confirmed' ORDER BY received_date DESC LIMIT ? OFFSET ?").all(tenantId,orgId,limit,offset);
      const total=(await db.prepare("SELECT COUNT(*) AS count FROM payments WHERE tenant_id=? AND organization_id=? AND status='confirmed'").get(tenantId,orgId)).count;
      return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
    }
    if(method==='GET'&&path==='/api/v1/tenant/maintenance'){
      const {limit,offset}=pagination(url);const data=await db.prepare('SELECT id,title,category,priority,status,description,created_at FROM maintenance_tickets WHERE tenant_id=? AND organization_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(tenantId,orgId,limit,offset);
      const total=(await db.prepare('SELECT COUNT(*) AS count FROM maintenance_tickets WHERE tenant_id=? AND organization_id=?').get(tenantId,orgId)).count;
      return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
    }
    if(method==='POST'&&path==='/api/v1/tenant/maintenance'){
      const body=await readJson(req);const lease=requireRecord(await db.prepare("SELECT l.unit_id,u.property_id FROM leases l JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id WHERE l.tenant_id=? AND l.organization_id=? AND l.status='active' ORDER BY l.start_date DESC LIMIT 1").get(tenantId,orgId),'Active lease');
      const id=randomUUID();const category=text(body.category||'General','Category',60);const priority=['low','normal','high'].includes(body.priority)?body.priority:'normal';
      await db.prepare(`INSERT INTO maintenance_tickets(id,organization_id,property_id,unit_id,tenant_id,title,category,priority,description)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id,orgId,lease.property_id,lease.unit_id,tenantId,text(body.title,'Title',140),category,priority,text(body.description,'Description',2000));
      await audit({organizationId:orgId,actorId:session.user_id,action:'tenant.maintenance_created',entityType:'maintenance_ticket',entityId:id,metadata:{priority}});
      return sendJson(res,201,{id});
    }
    if(method==='PATCH'&&path==='/api/v1/tenant/profile'){
      const body=await readJson(req);const phone=text(body.phone,'Phone number',40);
      if(!/^\+?[0-9 ()-]{7,24}$/.test(phone))fail(400,'Enter a valid phone number.');
      const email=body.email?validEmail(body.email):'';
      await db.prepare('UPDATE tenants SET phone=?,email=? WHERE id=? AND organization_id=?').run(phone,email,tenantId,orgId);
      await audit({organizationId:orgId,actorId:session.user_id,action:'tenant.profile_updated',entityType:'tenant',entityId:tenantId,metadata:{fields:['phone','email']}});
      return sendJson(res,200,{ok:true});
    }
    fail(403,'This area is not available for tenant accounts.','permission_denied');
  }

  if(session.role==='caretaker'){
    if(method==='GET'&&path==='/api/v1/caretaker/overview'){
      const properties=await db.prepare(`SELECT p.id,p.name,p.town,p.county,COUNT(DISTINCT u.id) AS unit_count,
        COUNT(DISTINCT CASE WHEN u.status='occupied' THEN u.id END) AS occupied_count
        FROM staff_property_assignments a JOIN properties p ON p.id=a.property_id AND p.organization_id=a.organization_id
        LEFT JOIN units u ON u.property_id=p.id AND u.organization_id=p.organization_id
        WHERE a.organization_id=? AND a.user_id=? GROUP BY p.id ORDER BY p.name`).all(orgId,session.user_id);
      const openTickets=await db.prepare(`SELECT COUNT(*) AS count FROM maintenance_tickets m WHERE m.organization_id=? AND m.status NOT IN ('resolved','closed')
        AND EXISTS(SELECT 1 FROM staff_property_assignments a WHERE a.organization_id=m.organization_id AND a.user_id=? AND a.property_id=m.property_id)`).get(orgId,session.user_id).count;
      return sendJson(res,200,{properties,openTickets});
    }
    if(method==='GET'&&path==='/api/v1/caretaker/units'){
      const {limit,offset}=pagination(url);const data=await db.prepare(`SELECT u.id,u.unit_number,u.category,u.floor,u.status,p.id AS property_id,p.name AS property_name,p.town
        FROM staff_property_assignments a JOIN properties p ON p.id=a.property_id AND p.organization_id=a.organization_id
        JOIN units u ON u.property_id=p.id AND u.organization_id=p.organization_id WHERE a.organization_id=? AND a.user_id=?
        ORDER BY p.name,u.unit_number LIMIT ? OFFSET ?`).all(orgId,session.user_id,limit,offset);
      const total=await db.prepare(`SELECT COUNT(*) AS count FROM staff_property_assignments a JOIN units u ON u.property_id=a.property_id AND u.organization_id=a.organization_id
        WHERE a.organization_id=? AND a.user_id=?`).get(orgId,session.user_id).count;
      return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
    }
    if(method==='GET'&&path==='/api/v1/caretaker/maintenance'){
      const {limit,offset}=pagination(url);const data=await db.prepare(`SELECT m.id,m.title,m.category,m.priority,m.description,m.status,m.estimate_cents,m.created_at,u.unit_number,p.name AS property_name
        FROM maintenance_tickets m JOIN properties p ON p.id=m.property_id AND p.organization_id=m.organization_id JOIN units u ON u.id=m.unit_id AND u.organization_id=m.organization_id
        WHERE m.organization_id=? AND EXISTS(SELECT 1 FROM staff_property_assignments a WHERE a.organization_id=m.organization_id AND a.user_id=? AND a.property_id=m.property_id)
        ORDER BY CASE m.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,m.created_at DESC LIMIT ? OFFSET ?`).all(orgId,session.user_id,limit,offset);
      const total=await db.prepare(`SELECT COUNT(*) AS count FROM maintenance_tickets m WHERE m.organization_id=? AND EXISTS(SELECT 1 FROM staff_property_assignments a
        WHERE a.organization_id=m.organization_id AND a.user_id=? AND a.property_id=m.property_id)`).get(orgId,session.user_id).count;
      return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
    }
    if(method==='POST'&&path==='/api/v1/caretaker/maintenance'){
      const body=await readJson(req);const unitId=text(body.unitId,'Unit',36);
      const unit=requireRecord(await db.prepare(`SELECT u.id,u.property_id FROM units u WHERE u.id=? AND u.organization_id=? AND EXISTS(
        SELECT 1 FROM staff_property_assignments a WHERE a.organization_id=u.organization_id AND a.user_id=? AND a.property_id=u.property_id)`).get(unitId,orgId,session.user_id),'Assigned unit');
      const id=randomUUID();const priority=['low','normal','high'].includes(body.priority)?body.priority:'normal';
      await db.prepare(`INSERT INTO maintenance_tickets(id,organization_id,property_id,unit_id,title,category,priority,description,estimate_cents)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id,orgId,unit.property_id,unit.id,text(body.title,'Title',140),text(body.category||'General','Category',60),priority,text(body.description,'Description',2000),body.estimate?moneyToCents(body.estimate):0);
      await audit({organizationId:orgId,actorId:session.user_id,action:'caretaker.maintenance_created',entityType:'maintenance_ticket',entityId:id,metadata:{priority}});
      return sendJson(res,201,{id});
    }
    const caretakerTicket=path.match(/^\/api\/v1\/caretaker\/maintenance\/([0-9a-f-]{36})$/i);
    if(caretakerTicket&&method==='PATCH'){
      const body=await readJson(req);const status=body.status;
      if(!['assigned','in_progress','resolved'].includes(status))fail(400,'Choose an allowed maintenance status.');
      const ticket=requireRecord(await db.prepare(`SELECT id,status FROM maintenance_tickets m WHERE m.id=? AND m.organization_id=? AND EXISTS(
        SELECT 1 FROM staff_property_assignments a WHERE a.organization_id=m.organization_id AND a.user_id=? AND a.property_id=m.property_id)`).get(caretakerTicket[1],orgId,session.user_id),'Assigned request');
      await transaction(async()=>{
        await db.prepare("UPDATE maintenance_tickets SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND organization_id=?").run(status,ticket.id,orgId);
        await audit({organizationId:orgId,actorId:session.user_id,action:'caretaker.maintenance_status_changed',entityType:'maintenance_ticket',entityId:ticket.id,metadata:{from:ticket.status,to:status}});
      });
      return sendJson(res,200,{ok:true,status});
    }
    fail(403,'Caretakers can only view assigned properties and update maintenance.','permission_denied');
  }

  if(!['owner','manager','accountant'].includes(session.role))fail(403,'This workspace role is not enabled for the current screens.','role_portal_unavailable');

  if(method==='GET'&&path==='/api/v1/staff'){
    requirePermission(session,'manage_staff');
    const members=await db.prepare(`SELECT u.id,u.full_name,u.email,m.role,m.created_at,COUNT(a.property_id) AS assigned_properties
      FROM organization_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN staff_property_assignments a ON a.organization_id=m.organization_id AND a.user_id=m.user_id
      WHERE m.organization_id=? GROUP BY u.id,m.role,m.created_at ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'accountant' THEN 2 ELSE 3 END,u.full_name`).all(orgId);
    const invitations=await db.prepare(`SELECT id,email,role,expires_at,created_at FROM staff_invitations WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC`).all(orgId,new Date().toISOString());
    const plan=await db.prepare('SELECT max_staff FROM subscription_plans WHERE id=?').get(session.plan_id);
    return sendJson(res,200,{members,invitations,staffLimit:plan?.max_staff||2});
  }

  if(method==='POST'&&path==='/api/v1/staff-invitations'){
    requirePermission(session,'manage_staff');const body=await readJson(req);const email=validEmail(body.email);const role=body.role;
    if(!['manager','accountant','caretaker'].includes(role))fail(400,'Choose manager, accountant, or caretaker.');
    if(await withAuthLookup(()=>db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email)))fail(409,'An account with this email already exists.','email_in_use');
    const propertyIds=Array.isArray(body.propertyIds)?[...new Set(body.propertyIds.map(id=>text(id,'Property',36)))]:[];
    if(role==='caretaker'&&!propertyIds.length)fail(400,'Assign at least one property to a caretaker.');
    if(propertyIds.length){
      const placeholders=propertyIds.map(()=>'?').join(',');
      const matches=await db.prepare(`SELECT id FROM properties WHERE organization_id=? AND status='active' AND id IN (${placeholders})`).all(orgId,...propertyIds);
      if(matches.length!==propertyIds.length)fail(404,'One or more assigned properties were not found.');
    }
    const plan=await db.prepare('SELECT max_staff FROM subscription_plans WHERE id=? AND active=1').get(session.plan_id);const limit=plan?.max_staff||2;
    const current=(await db.prepare("SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id=? AND role<>'owner'").get(orgId)).count;
    const pending=(await db.prepare("SELECT COUNT(*) AS count FROM staff_invitations WHERE organization_id=? AND email<>? COLLATE NOCASE AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?").get(orgId,email,new Date().toISOString())).count;
    if(current+pending>=limit)fail(409,`This plan allows up to ${limit} staff members.`, 'subscription_limit');
    const token=randomBytes(32).toString('base64url');const id=randomUUID();const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
    await transaction(async()=>{
      await db.prepare("UPDATE staff_invitations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? AND email=? COLLATE NOCASE AND accepted_at IS NULL AND revoked_at IS NULL").run(orgId,email);
      await db.prepare('INSERT INTO staff_invitations(id,organization_id,email,role,token_hash,created_by,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,orgId,email,role,hash(token),session.user_id,expiresAt);
      for(const propertyId of propertyIds)await db.prepare('INSERT INTO staff_invitation_properties(organization_id,invitation_id,property_id) VALUES(?,?,?)').run(orgId,id,propertyId);
      await auditAction(session,'staff.invitation_created','staff_invitation',id,{role,expiresAt,propertyCount:propertyIds.length});
    });
    return sendJson(res,201,{id,invitationPath:`/staff-invite?token=${encodeURIComponent(token)}`,expiresAt});
  }

  if(method==='POST'&&path==='/api/v1/tenant-invitations'){
    requirePermission(session,'manage_tenancy');const body=await readJson(req);const tenantId=text(body.tenantId,'Tenant',36);
    const tenant=requireRecord(await db.prepare("SELECT id,full_name,email FROM tenants WHERE id=? AND organization_id=? AND status='active'").get(tenantId,orgId),'Tenant');
    if(!tenant.email)fail(409,'Add an email address to this tenant before creating an invitation.');
    if(await db.prepare('SELECT user_id FROM tenant_users WHERE tenant_id=? AND organization_id=?').get(tenantId,orgId))fail(409,'This tenant already has a portal account.');
    const token=randomBytes(32).toString('base64url');const id=randomUUID();const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
    await transaction(async()=>{
      await db.prepare("UPDATE invitations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? AND tenant_id=? AND accepted_at IS NULL AND revoked_at IS NULL").run(orgId,tenantId);
      await db.prepare('INSERT INTO invitations(id,organization_id,tenant_id,email,token_hash,created_by,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,orgId,tenantId,tenant.email,hash(token),session.user_id,expiresAt);
      await auditAction(session,'tenant.invitation_created','tenant',tenantId,{expiresAt});
    });
    return sendJson(res,201,{id,invitationPath:`/invite?token=${encodeURIComponent(token)}`,expiresAt});
  }

  if (method === 'GET' && path === '/api/v1/dashboard') {
    const month = today().slice(0, 7);
    const metrics = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM properties WHERE organization_id=? AND status='active') AS properties,
      (SELECT COUNT(*) FROM units WHERE organization_id=? AND status<>'archived') AS units,
      (SELECT COUNT(*) FROM units WHERE organization_id=? AND status='occupied') AS occupied,
      (SELECT COALESCE(SUM(total_cents),0) FROM invoices WHERE organization_id=? AND period=? AND status<>'void') AS invoiced_cents,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE organization_id=? AND received_date LIKE ? AND status='confirmed') AS collected_cents,
      (SELECT COALESCE(SUM(i.total_cents-COALESCE(a.paid,0)),0) FROM invoices i LEFT JOIN (SELECT invoice_id,SUM(amount_cents) paid FROM payment_allocations WHERE organization_id=? GROUP BY invoice_id) a ON a.invoice_id=i.id WHERE i.organization_id=? AND i.status<>'void') AS arrears_cents,
      (SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE organization_id=? AND spent_on LIKE ? AND status='approved') AS expenses_cents,
      (SELECT COUNT(*) FROM maintenance_tickets WHERE organization_id=? AND status NOT IN ('resolved','closed')) AS open_maintenance`).get(orgId,orgId,orgId,orgId,month,orgId,`${month}%`,orgId,orgId,orgId,`${month}%`,orgId);
    const recentPayments = await db.prepare(`SELECT p.id,p.amount_cents,p.method,p.received_date,p.reference,t.full_name AS tenant_name
      FROM payments p JOIN tenants t ON t.id=p.tenant_id AND t.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.status='confirmed' ORDER BY p.received_date DESC,p.created_at DESC LIMIT 5`).all(orgId);
    const expiring = await db.prepare(`SELECT l.id,l.end_date,t.full_name AS tenant_name,u.unit_number,p.name AS property_name
      FROM leases l JOIN tenants t ON t.id=l.tenant_id AND t.organization_id=l.organization_id JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
      WHERE l.organization_id=? AND l.status='active' AND l.end_date BETWEEN ? AND date(?,'+60 day') ORDER BY l.end_date LIMIT 5`).all(orgId,today(),today());
    return sendJson(res, 200, { metrics, recentPayments, expiring, month });
  }

  if (method === 'GET' && path === '/api/v1/properties') {
    const q = text(url.searchParams.get('q') || '', 'Search', 80, false);
    return sendJson(res, 200, await listResult(`SELECT p.*,COUNT(u.id) AS unit_count,SUM(CASE WHEN u.status='occupied' THEN 1 ELSE 0 END) AS occupied_count
      FROM properties p LEFT JOIN units u ON u.property_id=p.id AND u.organization_id=p.organization_id
      WHERE p.organization_id=? AND (? IS NULL OR (p.name || ' ' || p.town || ' ' || p.county) LIKE ? ESCAPE '!') GROUP BY p.id ORDER BY p.created_at DESC`,
      `SELECT COUNT(*) AS count FROM properties p WHERE p.organization_id=? AND (? IS NULL OR (p.name || ' ' || p.town || ' ' || p.county) LIKE ? ESCAPE '!')`, orgId, url, q));
  }

  if (method === 'POST' && path === '/api/v1/properties') {
    requirePermission(session, 'manage_property');
    const body = await readJson(req);
    const id = randomUUID();
    await db.prepare(`INSERT INTO properties(id,organization_id,name,property_type,address,county,town,description)
      VALUES(?,?,?,?,?,?,?,?)`).run(id,orgId,text(body.name,'Property name',120),text(body.propertyType,'Property type',40),text(body.address||'','Address',200,false),text(body.county||'','County',80,false),text(body.town||'','Town or city',80,false),text(body.description||'','Description',1000,false));
    await auditAction(session,'property.created','property',id,{ propertyType: body.propertyType });
    return sendJson(res, 201, { id });
  }

  const propertyMatch = path.match(/^\/api\/v1\/properties\/([0-9a-f-]{36})$/i);
  if (propertyMatch && method === 'PATCH') {
    requirePermission(session, 'manage_property');
    const body = await readJson(req);
    const id = propertyMatch[1];
    const property = requireRecord(await db.prepare('SELECT id FROM properties WHERE id=? AND organization_id=?').get(id,orgId),'Property');
    if (body.status !== 'archived') fail(400, 'Only property archival is supported here.');
    await db.prepare("UPDATE properties SET status='archived' WHERE id=? AND organization_id=?").run(property.id,orgId);
    await auditAction(session,'property.archived','property',id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/v1/units') {
    const q = text(url.searchParams.get('q') || '', 'Search', 80, false);
    const status = text(url.searchParams.get('status') || '', 'Status', 20, false);
    const filterStatus = status && ['vacant','occupied','maintenance','archived'].includes(status) ? status : null;
    return sendJson(res, 200, await listResult(`SELECT u.*,p.name AS property_name,p.town AS town
      FROM units u JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
      WHERE u.organization_id=? AND (? IS NULL OR (u.unit_number || ' ' || p.name) LIKE ? ESCAPE '!') AND (? IS NULL OR u.status=?) ORDER BY p.name,u.unit_number`,
      `SELECT COUNT(*) AS count FROM units u JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
      WHERE u.organization_id=? AND (? IS NULL OR (u.unit_number || ' ' || p.name) LIKE ? ESCAPE '!') AND (? IS NULL OR u.status=?)`,orgId,url,q,[filterStatus,filterStatus]));
  }

  if (method === 'POST' && path === '/api/v1/units') {
    requirePermission(session,'manage_property');
    const body = await readJson(req);
    const property = requireRecord(await db.prepare("SELECT id FROM properties WHERE id=? AND organization_id=? AND status='active'").get(text(body.propertyId,'Property',36),orgId),'Property');
    const limit = (await db.prepare('SELECT max_units FROM subscription_plans WHERE id=? AND active=1').get(session.plan_id))?.max_units || 25;
    const current = (await db.prepare("SELECT COUNT(*) AS count FROM units WHERE organization_id=? AND status<>'archived'").get(orgId)).count;
    if (current >= limit) fail(409,`This plan allows up to ${limit} units. Update the plan limit to add more.`, 'subscription_limit');
    const id = randomUUID();
    await db.prepare(`INSERT INTO units(id,organization_id,property_id,unit_number,category,floor,rent_cents,deposit_cents,notes)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id,orgId,property.id,text(body.unitNumber,'Unit number',40),text(body.category||'Apartment','Unit category',60),text(body.floor||'','Floor or block',40,false),moneyToCents(body.monthlyRent),moneyToCents(body.deposit||0),text(body.notes||'','Notes',1000,false));
    await auditAction(session,'unit.created','unit',id,{ propertyId: property.id });
    return sendJson(res,201,{ id });
  }

  if (method === 'GET' && path === '/api/v1/tenants') {
    const q = text(url.searchParams.get('q') || '', 'Search', 80, false);
    return sendJson(res,200,await listResult(`SELECT t.*,COUNT(DISTINCT l.id) AS lease_count,MAX(CASE WHEN l.status='active' THEN u.unit_number END) AS current_unit
      FROM tenants t LEFT JOIN leases l ON l.tenant_id=t.id AND l.organization_id=t.organization_id LEFT JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id
      WHERE t.organization_id=? AND (? IS NULL OR (t.full_name || ' ' || t.phone) LIKE ? ESCAPE '!') GROUP BY t.id ORDER BY t.full_name`,
      `SELECT COUNT(*) AS count FROM tenants t WHERE t.organization_id=? AND (? IS NULL OR (t.full_name || ' ' || t.phone) LIKE ? ESCAPE '!')`,orgId,url,q));
  }

  if (method === 'POST' && path === '/api/v1/tenants') {
    requirePermission(session,'manage_tenancy');
    const body=await readJson(req); const id=randomUUID();
    const phone=text(body.phone,'Phone number',40);
    if (!/^\+?[0-9 ()-]{7,24}$/.test(phone)) fail(400,'Enter a valid phone number.');
    const email=body.email?validEmail(body.email):'';
    await db.prepare('INSERT INTO tenants(id,organization_id,full_name,phone,email,notes) VALUES(?,?,?,?,?,?)').run(id,orgId,text(body.fullName,'Tenant name',120),phone,email,text(body.notes||'','Notes',1000,false));
    await auditAction(session,'tenant.created','tenant',id);
    return sendJson(res,201,{id});
  }

  if (method === 'GET' && path === '/api/v1/leases') {
    const {limit,offset}=pagination(url);
    const data=await db.prepare(`SELECT l.*,t.full_name AS tenant_name,t.phone,u.unit_number,p.name AS property_name,
      COALESCE((SELECT SUM(i.total_cents) FROM invoices i WHERE i.lease_id=l.id AND i.organization_id=l.organization_id AND i.status<>'void'),0) AS invoiced_cents,
      COALESCE((SELECT SUM(a.amount_cents) FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id AND i.organization_id=a.organization_id WHERE i.lease_id=l.id AND a.organization_id=l.organization_id),0) AS paid_cents
      FROM leases l JOIN tenants t ON t.id=l.tenant_id AND t.organization_id=l.organization_id JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
      WHERE l.organization_id=? ORDER BY l.status,l.start_date DESC LIMIT ? OFFSET ?`).all(orgId,limit,offset);
    const total=(await db.prepare('SELECT COUNT(*) AS count FROM leases WHERE organization_id=?').get(orgId)).count;
    return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
  }

  if (method === 'POST' && path === '/api/v1/leases') {
    requirePermission(session,'manage_tenancy');
    const body=await readJson(req); const unitId=text(body.unitId,'Unit',36); const tenantId=text(body.tenantId,'Tenant',36);
    const unit=requireRecord(await db.prepare("SELECT id,status FROM units WHERE id=? AND organization_id=? AND status<>'archived'").get(unitId,orgId),'Unit');
    requireRecord(await db.prepare("SELECT id FROM tenants WHERE id=? AND organization_id=? AND status='active'").get(tenantId,orgId),'Tenant');
    const start=date(body.startDate,'Start date'); const end=date(body.endDate,'End date',false);
    if(end && end<start) fail(400,'End date must be on or after the start date.');
    if(unit.status==='occupied' || await db.prepare("SELECT id FROM leases WHERE unit_id=? AND organization_id=? AND status='active' AND (end_date IS NULL OR end_date>=?) AND (CAST(? AS TEXT) IS NULL OR start_date<=?)").get(unitId,orgId,start,end,end)) fail(409,'This unit already has an active lease for those dates.','unit_already_leased');
    const rent=moneyToCents(body.monthlyRent); if(rent<=0) fail(400,'Monthly rent must be greater than zero.');
    const deposit=moneyToCents(body.deposit||0); const dueDay=Number(body.dueDay||1);
    if(!Number.isInteger(dueDay)||dueDay<1||dueDay>28) fail(400,'Choose a rent due day between 1 and 28.');
    const id=randomUUID();
    await transaction(async()=>{
      await db.prepare(`INSERT INTO leases(id,organization_id,unit_id,tenant_id,start_date,end_date,monthly_rent_cents,deposit_cents,due_day) VALUES(?,?,?,?,?,?,?,?,?)`).run(id,orgId,unitId,tenantId,start,end,rent,deposit,dueDay);
      await db.prepare("UPDATE units SET status='occupied' WHERE id=? AND organization_id=?").run(unitId,orgId);
      await db.prepare(`INSERT INTO lease_revisions(id,organization_id,lease_id,actor_id,changed_fields_json,previous_values_json,new_values_json)
        VALUES(?,?,?,?,?,?,?)`).run(randomUUID(),orgId,id,session.user_id,JSON.stringify(['unitId','tenantId','startDate','endDate','monthlyRentCents','depositCents','dueDay']),JSON.stringify({}),JSON.stringify({unitId,tenantId,startDate:start,endDate:end,monthlyRentCents:rent,depositCents:deposit,dueDay}));
      await auditAction(session,'lease.created','lease',id,{unitId,tenantId,startDate:start,endDate:end});
    });
    return sendJson(res,201,{id});
  }

  const leaseDepositMatch=path.match(/^\/api\/v1\/leases\/([0-9a-f-]{36})\/deposits$/i);
  if(leaseDepositMatch&&method==='GET'){
    const lease=requireRecord(await db.prepare(`SELECT l.id,l.deposit_cents,l.tenant_id,t.full_name AS tenant_name,u.unit_number,p.name AS property_name
      FROM leases l JOIN tenants t ON t.id=l.tenant_id AND t.organization_id=l.organization_id JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id
      JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id WHERE l.id=? AND l.organization_id=?`).get(leaseDepositMatch[1],orgId),'Lease');
    const transactions=await db.prepare(`SELECT id,transaction_type,amount_cents,method,reference,created_at FROM deposit_transactions WHERE lease_id=? AND organization_id=? ORDER BY created_at DESC`).all(lease.id,orgId);
    const balance=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN transaction_type='received' THEN amount_cents ELSE -amount_cents END),0) AS held_cents,
      COALESCE(SUM(CASE WHEN transaction_type='received' THEN amount_cents ELSE 0 END),0) AS received_cents,
      COALESCE(SUM(CASE WHEN transaction_type='refunded' THEN amount_cents ELSE 0 END),0) AS refunded_cents FROM deposit_transactions WHERE lease_id=? AND organization_id=?`).get(lease.id,orgId);
    return sendJson(res,200,{lease,expectedCents:lease.deposit_cents,...balance,transactions});
  }
  if(leaseDepositMatch&&method==='POST'){
    requirePermission(session,'manage_finance');const body=await readJson(req);const lease=requireRecord(await db.prepare('SELECT id,tenant_id FROM leases WHERE id=? AND organization_id=?').get(leaseDepositMatch[1],orgId),'Lease');
    const type=body.type;if(!['received','refunded'].includes(type))fail(400,'Choose deposit received or deposit refunded.');
    const amount=moneyToCents(body.amount);if(amount<=0)fail(400,'Deposit amount must be greater than zero.');
    const method=body.method;if(!['cash','bank','other'].includes(method))fail(400,'Choose cash, bank transfer, or other confirmed receipt.');
    const key=text(req.headers['idempotency-key'],'Idempotency-Key',120);if(key.length<8)fail(400,'Idempotency-Key must contain at least 8 characters.');
    const previous=await db.prepare('SELECT id,amount_cents FROM deposit_transactions WHERE organization_id=? AND idempotency_key=?').get(orgId,key);
    if(previous)return sendJson(res,200,{id:previous.id,duplicate:true,amountCents:previous.amount_cents});
    const id=randomUUID();
    await transaction(async()=>{
      if(type==='refunded'){
        const held=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN transaction_type='received' THEN amount_cents ELSE -amount_cents END),0) AS held_cents
          FROM deposit_transactions WHERE lease_id=? AND organization_id=?`).get(lease.id,orgId).held_cents;
        if(amount>held)fail(409,'A refund cannot exceed the deposit currently held.','deposit_balance_insufficient');
      }
      await db.prepare(`INSERT INTO deposit_transactions(id,organization_id,lease_id,tenant_id,transaction_type,amount_cents,method,reference,idempotency_key,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,orgId,lease.id,lease.tenant_id,type,amount,method,text(body.reference||'','Reference',120,false),key,session.user_id);
      await auditAction(session,`deposit.${type}`,'lease',lease.id,{transactionId:id,amountCents:amount,method});
    });
    return sendJson(res,201,{id,type,amountCents:amount});
  }

  const leaseHistoryMatch=path.match(/^\/api\/v1\/leases\/([0-9a-f-]{36})\/history$/i);
  if(leaseHistoryMatch&&method==='GET'){
    requireRecord(await db.prepare('SELECT id FROM leases WHERE id=? AND organization_id=?').get(leaseHistoryMatch[1],orgId),'Lease');
    const data=await db.prepare('SELECT id,changed_fields_json,previous_values_json,new_values_json,created_at FROM lease_revisions WHERE lease_id=? AND organization_id=? ORDER BY created_at DESC').all(leaseHistoryMatch[1],orgId);
    return sendJson(res,200,{data:data.map(row=>({...row,changedFields:JSON.parse(row.changed_fields_json),previousValues:JSON.parse(row.previous_values_json),newValues:JSON.parse(row.new_values_json)}))});
  }

  const leaseUpdateMatch=path.match(/^\/api\/v1\/leases\/([0-9a-f-]{36})$/i);
  if(leaseUpdateMatch&&method==='PATCH'){
    requirePermission(session,'manage_tenancy');const body=await readJson(req);const lease=requireRecord(await db.prepare("SELECT * FROM leases WHERE id=? AND organization_id=? AND status='active'").get(leaseUpdateMatch[1],orgId),'Active lease');
    const previous={monthlyRentCents:lease.monthly_rent_cents,depositCents:lease.deposit_cents,dueDay:lease.due_day};
    const next={...previous};
    if(Object.hasOwn(body,'monthlyRent'))next.monthlyRentCents=moneyToCents(body.monthlyRent);
    if(Object.hasOwn(body,'deposit'))next.depositCents=moneyToCents(body.deposit);
    if(Object.hasOwn(body,'dueDay'))next.dueDay=Number(body.dueDay);
    if(next.monthlyRentCents<=0||next.depositCents<0||!Number.isInteger(next.dueDay)||next.dueDay<1||next.dueDay>28)fail(400,'Rent, deposit, or due day is invalid.');
    const fields=Object.keys(next).filter(key=>next[key]!==previous[key]);if(!fields.length)fail(400,'No lease terms were changed.');
    await transaction(async()=>{
      await db.prepare('UPDATE leases SET monthly_rent_cents=?,deposit_cents=?,due_day=? WHERE id=? AND organization_id=?').run(next.monthlyRentCents,next.depositCents,next.dueDay,lease.id,orgId);
      await db.prepare('INSERT INTO lease_revisions(id,organization_id,lease_id,actor_id,changed_fields_json,previous_values_json,new_values_json) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),orgId,lease.id,session.user_id,JSON.stringify(fields),JSON.stringify(previous),JSON.stringify(next));
      await auditAction(session,'lease.terms_amended','lease',lease.id,{changedFields:fields});
    });
    return sendJson(res,200,{ok:true,changedFields:fields});
  }

  const leaseEndMatch=path.match(/^\/api\/v1\/leases\/([0-9a-f-]{36})\/end$/i);
  if(leaseEndMatch&&method==='POST'){
    requirePermission(session,'manage_tenancy');const body=await readJson(req);const lease=requireRecord(await db.prepare("SELECT * FROM leases WHERE id=? AND organization_id=? AND status='active'").get(leaseEndMatch[1],orgId),'Active lease');
    const endDate=date(body.endDate||today(),'End date');if(endDate<lease.start_date||endDate>today())fail(400,'The move-out date must be between the lease start date and today.');
    await transaction(async()=>{
      await db.prepare("UPDATE leases SET status='ended',end_date=? WHERE id=? AND organization_id=?").run(endDate,lease.id,orgId);
      await db.prepare("UPDATE units SET status='vacant' WHERE id=? AND organization_id=? AND status='occupied' AND NOT EXISTS(SELECT 1 FROM leases WHERE unit_id=? AND organization_id=? AND status='active')").run(lease.unit_id,orgId,lease.unit_id,orgId);
      await db.prepare("UPDATE tenants SET status='former' WHERE id=? AND organization_id=? AND NOT EXISTS(SELECT 1 FROM leases WHERE tenant_id=? AND organization_id=? AND status='active')").run(lease.tenant_id,orgId,lease.tenant_id,orgId);
      await db.prepare('INSERT INTO lease_revisions(id,organization_id,lease_id,actor_id,changed_fields_json,previous_values_json,new_values_json) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),orgId,lease.id,session.user_id,JSON.stringify(['status','endDate']),JSON.stringify({status:'active',endDate:lease.end_date}),JSON.stringify({status:'ended',endDate}));
      await auditAction(session,'lease.ended','lease',lease.id,{endDate});
    });
    return sendJson(res,200,{ok:true,status:'ended',endDate});
  }

  if (method === 'POST' && path === '/api/v1/billing/generate') {
    requirePermission(session,'manage_finance');
    const body=await readJson(req); const period=text(body.period,'Billing month',7);
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail(400,'Choose a billing month in YYYY-MM format.');
    const periodStart=`${period}-01`; const periodEnd=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);
    const leases=await db.prepare(`SELECT l.*,t.full_name,u.unit_number,p.name AS property_name FROM leases l JOIN tenants t ON t.id=l.tenant_id AND t.organization_id=l.organization_id JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
      WHERE l.organization_id=? AND l.status='active' AND l.start_date<=? AND (l.end_date IS NULL OR l.end_date>=?)`).all(orgId,periodEnd,periodStart);
    let created=0;
    await transaction(async()=>{
      for(const lease of leases){
        if(await db.prepare('SELECT id FROM invoices WHERE lease_id=? AND period=? AND organization_id=?').get(lease.id,period,orgId)) continue;
        const id=randomUUID(); const number=`MKZ-${period.replace('-','')}-${id.slice(0,8).toUpperCase()}`; const due=dueDateForPeriod(period,lease.due_day);
        await db.prepare(`INSERT INTO invoices(id,organization_id,lease_id,tenant_id,unit_id,period,invoice_number,issue_date,due_date,total_cents)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,orgId,lease.id,lease.tenant_id,lease.unit_id,period,number,today(),due,lease.monthly_rent_cents);
        await db.prepare('INSERT INTO invoice_lines(id,organization_id,invoice_id,description,amount_cents) VALUES(?,?,?,?,?)').run(randomUUID(),orgId,id,`Rent — ${lease.property_name} / ${lease.unit_number}`,lease.monthly_rent_cents);
        await auditAction(session,'invoice.generated','invoice',id,{period,leaseId:lease.id}); created++;
      }
    });
    return sendJson(res,200,{period,created,skipped:leases.length-created});
  }

  if (method === 'GET' && path === '/api/v1/invoices') {
    const {limit,offset}=pagination(url);
    const data=await db.prepare(`SELECT i.*,t.full_name AS tenant_name,t.phone,u.unit_number,p.name AS property_name,
      COALESCE(SUM(CASE WHEN pay.status='confirmed' THEN a.amount_cents ELSE 0 END),0) AS paid_cents,
      i.total_cents-COALESCE(SUM(CASE WHEN pay.status='confirmed' THEN a.amount_cents ELSE 0 END),0) AS balance_cents
      FROM invoices i JOIN tenants t ON t.id=i.tenant_id AND t.organization_id=i.organization_id JOIN units u ON u.id=i.unit_id AND u.organization_id=i.organization_id JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
      LEFT JOIN payment_allocations a ON a.invoice_id=i.id AND a.organization_id=i.organization_id LEFT JOIN payments pay ON pay.id=a.payment_id AND pay.organization_id=a.organization_id
      WHERE i.organization_id=? GROUP BY i.id,t.full_name,t.phone,u.unit_number,p.name ORDER BY i.due_date DESC,i.created_at DESC LIMIT ? OFFSET ?`).all(orgId,limit,offset);
    const total=(await db.prepare('SELECT COUNT(*) AS count FROM invoices WHERE organization_id=?').get(orgId)).count;
    return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
  }

  if (method === 'GET' && path === '/api/v1/payments') {
    const {limit,offset}=pagination(url);
    const data=await db.prepare(`SELECT p.*,t.full_name AS tenant_name,COALESCE(SUM(a.amount_cents),0) AS allocated_cents
      FROM payments p JOIN tenants t ON t.id=p.tenant_id AND t.organization_id=p.organization_id LEFT JOIN payment_allocations a ON a.payment_id=p.id AND a.organization_id=p.organization_id
      WHERE p.organization_id=? GROUP BY p.id,t.full_name ORDER BY p.received_date DESC,p.created_at DESC LIMIT ? OFFSET ?`).all(orgId,limit,offset);
    const total=(await db.prepare('SELECT COUNT(*) AS count FROM payments WHERE organization_id=?').get(orgId)).count;
    return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
  }

  if (method === 'POST' && path === '/api/v1/payments') {
    requirePermission(session,'manage_finance');
    const body=await readJson(req); const key=text(req.headers['idempotency-key'],'Idempotency-Key',120);
    if(key.length<8) fail(400,'Idempotency-Key must contain at least 8 characters.');
    const prior=await db.prepare('SELECT id,amount_cents FROM payments WHERE organization_id=? AND idempotency_key=?').get(orgId,key);
    if(prior) return sendJson(res,200,{id:prior.id,duplicate:true,amountCents:prior.amount_cents});
    const tenantId=text(body.tenantId,'Tenant',36);
    requireRecord(await db.prepare("SELECT id FROM tenants WHERE id=? AND organization_id=? AND status='active'").get(tenantId,orgId),'Tenant');
    const method=body.method;
    if(!['cash','bank','other'].includes(method)) fail(501,'M-Pesa collection is not enabled. Configure and verify the Daraja sandbox adapter before using it.','payment_provider_unavailable');
    const amount=moneyToCents(body.amount); if(amount<=0) fail(400,'Payment amount must be greater than zero.');
    const receivedDate=date(body.receivedDate||today(),'Payment date');
    let result;
    await transaction(async()=>{
      result=await createConfirmedPayment({organizationId:orgId,tenantId,amountCents:amount,method,receivedDate,reference:text(body.reference||'','Payment reference',120,false),idempotencyKey:key,actorId:session.user_id});
      await auditAction(session,'payment.recorded','payment',result.id,{method,amountCents:amount,allocatedCents:result.allocatedCents});
    });
    return sendJson(res,201,result);
  }

  if(method==='POST'&&path==='/api/v1/payments/mpesa/stk-push'){
    requirePermission(session,'manage_finance');
    let provider;try{provider=new DarajaSandboxProvider();}catch(error){if(error instanceof ProviderUnavailableError)fail(503,error.message,error.code);throw error;}
    const body=await readJson(req);const key=text(req.headers['idempotency-key'],'Idempotency-Key',120);
    if(key.length<8)fail(400,'Idempotency-Key must contain at least 8 characters.');
    const existing=await db.prepare('SELECT id,status,internal_reference FROM mpesa_transactions WHERE organization_id=? AND idempotency_key=?').get(orgId,key);
    if(existing)return sendJson(res,200,{id:existing.id,status:existing.status,reference:existing.internal_reference,duplicate:true});
    const tenantId=text(body.tenantId,'Tenant',36);requireRecord(await db.prepare("SELECT id FROM tenants WHERE id=? AND organization_id=? AND status='active'").get(tenantId,orgId),'Tenant');
    const amountCents=moneyToCents(body.amount);if(amountCents<=0)fail(400,'Payment amount must be greater than zero.');
    if(amountCents%100!==0)fail(400,'Daraja STK Push accepts whole Kenyan shillings only.');
    const phone=normalizeKenyanPhone(body.phone);const id=randomUUID();const reference=`MKZ${id.replaceAll('-','').slice(0,9).toUpperCase()}`;
    await db.prepare(`INSERT INTO mpesa_transactions(id,organization_id,tenant_id,requested_by,internal_reference,phone_number,amount_cents,idempotency_key)
      VALUES(?,?,?,?,?,?,?,?)`).run(id,orgId,tenantId,session.user_id,reference,phone,amountCents,key);
    try{
      const response=await provider.initiate({phone,amountKes:Math.ceil(amountCents/100),accountReference:reference,description:'Rental payment'});
      await db.prepare(`UPDATE mpesa_transactions SET merchant_request_id=?,checkout_request_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND organization_id=?`).run(response.merchantRequestId,response.checkoutRequestId,id,orgId);
      await auditAction(session,'mpesa.stk_push_requested','mpesa_transaction',id,{amountCents});
      return sendJson(res,202,{id,status:'pending',reference,message:response.customerMessage});
    }catch(error){
      if(error instanceof ProviderUnavailableError)return sendJson(res,502,{error:{code:error.code,message:error.message}});
      throw error;
    }
  }

  if(method==='GET'&&path==='/api/v1/payments/mpesa/transactions'){
    requirePermission(session,'manage_finance');const {limit,offset}=pagination(url);
    const data=await db.prepare(`SELECT m.id,m.internal_reference,m.phone_number,m.amount_cents,m.status,m.provider_receipt,m.created_at,m.updated_at,t.full_name AS tenant_name
      FROM mpesa_transactions m JOIN tenants t ON t.id=m.tenant_id AND t.organization_id=m.organization_id WHERE m.organization_id=? ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).all(orgId,limit,offset);
    const total=(await db.prepare('SELECT COUNT(*) AS count FROM mpesa_transactions WHERE organization_id=?').get(orgId)).count;
    return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
  }

  if (method === 'GET' && path === '/api/v1/arrears') {
    const asOf=date(url.searchParams.get('asOf')||today(),'As-of date');
    const rows=[];
    for(const row of await invoiceBalances(orgId)){
      const invoice=await db.prepare(`SELECT i.id,i.invoice_number,i.period,i.due_date,i.total_cents,t.id AS tenant_id,t.full_name AS tenant_name,t.phone,u.unit_number,p.name AS property_name
        FROM invoices i JOIN tenants t ON t.id=i.tenant_id AND t.organization_id=i.organization_id JOIN units u ON u.id=i.unit_id AND u.organization_id=i.organization_id JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id WHERE i.id=? AND i.organization_id=?`).get(row.id,orgId);
      const days=ageInDays(asOf,invoice.due_date);
      if(days>0)rows.push({...invoice,balance_cents:row.balance_cents,days_overdue:days,bucket:arrearsBucket(days)});
    }
    const {limit,offset}=pagination(url);
    const aging={ '1_30':0,'31_60':0,'61_90':0,'90_plus':0 };
    for(const row of rows) aging[row.bucket]+=row.balance_cents;
    return sendJson(res,200,{asOf,rows:rows.slice(offset,offset+limit),aging,totalCents:Object.values(aging).reduce((sum,x)=>sum+x,0),page:{limit,offset,total:rows.length,hasMore:offset+limit<rows.length}});
  }

  if (method === 'GET' && path === '/api/v1/expenses') {
    const {limit,offset}=pagination(url);
    const data=await db.prepare(`SELECT e.*,p.name AS property_name,u.unit_number,creator.full_name AS created_by_name,approver.full_name AS approved_by_name
      FROM expenses e JOIN properties p ON p.id=e.property_id AND p.organization_id=e.organization_id LEFT JOIN units u ON u.id=e.unit_id AND u.organization_id=e.organization_id
      JOIN users creator ON creator.id=e.created_by LEFT JOIN users approver ON approver.id=e.approved_by WHERE e.organization_id=? ORDER BY e.spent_on DESC,e.created_at DESC LIMIT ? OFFSET ?`).all(orgId,limit,offset);
    const total=(await db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE organization_id=?').get(orgId)).count;
    return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
  }

  if (method === 'POST' && path === '/api/v1/expenses') {
    requirePermission(session,'manage_finance');
    const body=await readJson(req); const propertyId=text(body.propertyId,'Property',36); const unitId=body.unitId?text(body.unitId,'Unit',36):null;
    requireRecord(await db.prepare("SELECT id FROM properties WHERE id=? AND organization_id=? AND status='active'").get(propertyId,orgId),'Property');
    if(unitId) requireRecord(await db.prepare('SELECT id FROM units WHERE id=? AND organization_id=? AND property_id=?').get(unitId,orgId,propertyId),'Unit');
    const amount=moneyToCents(body.amount); if(amount<=0) fail(400,'Expense amount must be greater than zero.');
    const threshold=(await db.prepare('SELECT expense_approval_threshold_cents FROM organizations WHERE id=?').get(orgId)).expense_approval_threshold_cents;
    const status=amount>threshold?'pending_approval':'approved'; const id=randomUUID();
    await transaction(async()=>{
      await db.prepare(`INSERT INTO expenses(id,organization_id,property_id,unit_id,category,amount_cents,spent_on,supplier,description,status,created_by,approved_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,orgId,propertyId,unitId,text(body.category,'Category',80),amount,date(body.spentOn||today(),'Date'),text(body.supplier||'','Supplier',120,false),text(body.description,'Description',1000),status,session.user_id,status==='approved'?session.user_id:null);
      await auditAction(session,'expense.created','expense',id,{amountCents:amount,status});
    });
    return sendJson(res,201,{id,status});
  }

  const approvalMatch=path.match(/^\/api\/v1\/expenses\/([0-9a-f-]{36})\/approval$/i);
  if(approvalMatch&&method==='PATCH'){
    requirePermission(session,'approve_expense'); const body=await readJson(req); const status=body.status;
    if(!['approved','rejected'].includes(status)) fail(400,'Choose approve or reject.');
    const id=approvalMatch[1]; const expense=requireRecord(await db.prepare("SELECT id,status FROM expenses WHERE id=? AND organization_id=?").get(id,orgId),'Expense');
    if(expense.status!=='pending_approval') fail(409,'This expense is no longer awaiting approval.');
    await transaction(async()=>{
      await db.prepare('UPDATE expenses SET status=?,approved_by=? WHERE id=? AND organization_id=?').run(status,session.user_id,id,orgId);
      await auditAction(session,`expense.${status}`,'expense',id);
    });
    return sendJson(res,200,{ok:true,status});
  }

  if (method === 'GET' && path === '/api/v1/maintenance') {
    const {limit,offset}=pagination(url);
    const data=await db.prepare(`SELECT m.*,p.name AS property_name,u.unit_number,t.full_name AS tenant_name
      FROM maintenance_tickets m JOIN properties p ON p.id=m.property_id AND p.organization_id=m.organization_id JOIN units u ON u.id=m.unit_id AND u.organization_id=m.organization_id
      LEFT JOIN tenants t ON t.id=m.tenant_id AND t.organization_id=m.organization_id WHERE m.organization_id=? ORDER BY CASE m.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,m.created_at DESC LIMIT ? OFFSET ?`).all(orgId,limit,offset);
    const total=(await db.prepare('SELECT COUNT(*) AS count FROM maintenance_tickets WHERE organization_id=?').get(orgId)).count;
    return sendJson(res,200,{data,page:{limit,offset,total,hasMore:offset+data.length<total}});
  }

  if(method==='POST'&&path==='/api/v1/maintenance'){
    requirePermission(session,'maintenance_update'); const body=await readJson(req); const unitId=text(body.unitId,'Unit',36);
    const unit=requireRecord(await db.prepare('SELECT id,property_id FROM units WHERE id=? AND organization_id=?').get(unitId,orgId),'Unit');
    const tenantId=body.tenantId?text(body.tenantId,'Tenant',36):null;
    if(tenantId) requireRecord(await db.prepare('SELECT id FROM tenants WHERE id=? AND organization_id=?').get(tenantId,orgId),'Tenant');
    const id=randomUUID(); const priority=['low','normal','high','urgent'].includes(body.priority)?body.priority:'normal';
    await db.prepare(`INSERT INTO maintenance_tickets(id,organization_id,property_id,unit_id,tenant_id,title,category,priority,description,estimate_cents)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,orgId,unit.property_id,unitId,tenantId,text(body.title,'Title',140),text(body.category,'Category',60),priority,text(body.description,'Description',2000),body.estimate?moneyToCents(body.estimate):0);
    await auditAction(session,'maintenance.created','maintenance_ticket',id,{unitId,priority});
    return sendJson(res,201,{id});
  }

  const maintenanceMatch=path.match(/^\/api\/v1\/maintenance\/([0-9a-f-]{36})$/i);
  if(maintenanceMatch&&method==='PATCH'){
    requirePermission(session,'maintenance_update'); const body=await readJson(req); const status=body.status;
    if(!['open','assigned','in_progress','awaiting_approval','resolved','closed'].includes(status)) fail(400,'Choose a valid maintenance status.');
    const ticket=requireRecord(await db.prepare('SELECT id,status FROM maintenance_tickets WHERE id=? AND organization_id=?').get(maintenanceMatch[1],orgId),'Ticket');
    await db.prepare("UPDATE maintenance_tickets SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND organization_id=?").run(status,ticket.id,orgId);
    await auditAction(session,'maintenance.status_changed','maintenance_ticket',ticket.id,{from:ticket.status,to:status});
    return sendJson(res,200,{ok:true,status});
  }

  if(method==='GET'&&path==='/api/v1/settings'){
    const org=await db.prepare('SELECT name,currency,timezone,plan_id,expense_approval_threshold_cents,created_at FROM organizations WHERE id=?').get(orgId);
    return sendJson(res,200,org);
  }
  if(method==='PATCH'&&path==='/api/v1/settings'){
    requirePermission(session,'manage_settings'); const body=await readJson(req);
    const name=text(body.name,'Business name',120); const threshold=moneyToCents(body.expenseApprovalThreshold||0);
    await db.prepare('UPDATE organizations SET name=?,expense_approval_threshold_cents=? WHERE id=?').run(name,threshold,orgId);
    await auditAction(session,'settings.updated','organization',orgId,{name,expenseApprovalThresholdCents:threshold});
    return sendJson(res,200,{ok:true});
  }

  if(method==='GET'&&path==='/api/v1/audit'){
    requirePermission(session,'view_audit'); const {limit,offset}=pagination(url);
    const data=await db.prepare('SELECT a.action,a.entity_type,a.entity_id,a.metadata_json,a.created_at,u.full_name AS actor_name FROM audit_logs a JOIN users u ON u.id=a.actor_id WHERE a.organization_id=? ORDER BY a.created_at DESC LIMIT ? OFFSET ?').all(orgId,limit,offset);
    const total=(await db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE organization_id=?').get(orgId)).count;
    return sendJson(res,200,{data:data.map(row=>({...row,metadata:JSON.parse(row.metadata_json)})),page:{limit,offset,total,hasMore:offset+data.length<total}});
  }

  if(method==='POST'&&path==='/api/v1/exports'){
    requirePermission(session,'manage_finance');const body=await readJson(req);
    const resource=text(body.resource,'Export type',60);const rows=Math.max(0,Math.min(1000,Number(body.rows)||0));
    await auditAction(session,'data.exported',resource,orgId,{rows});
    return sendJson(res,200,{ok:true});
  }

  fail(404, 'That page or action was not found.', 'not_found');
}

async function staticFile(req, res, url) {
  const requested = url.pathname === '/' || url.pathname === '/invite' || url.pathname === '/staff-invite' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = resolve(publicRoot, `.${requested}`);
  if (!file.startsWith(publicRoot + '\\') && file !== publicRoot) return sendJson(res,404,{error:{code:'not_found',message:'That page was not found.'}});
  try {
    const info = await stat(file);
    if (!info.isFile()) return sendJson(res,404,{error:{code:'not_found',message:'That page was not found.'}});
    res.writeHead(200,{ 'Content-Type':MIME[extname(file)]||'application/octet-stream','Cache-Control':'no-cache' });
    createReadStream(file).pipe(res);
  } catch { sendJson(res,404,{error:{code:'not_found',message:'That page was not found.'}}); }
}

export async function handleHttpRequest(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/v1/')){
      const session=await currentSession(req);
      const staged={};
      const handled=await withRequest(session?.organization_id||null,session?.user_id||null,()=>responseContext.run(staged,()=>handleApi(req,res,url)));
      if(handled!==false){
        if(staged.response)sendJsonNow(res,staged.response.status,staged.response.payload);
        return;
      }
    }
    if(req.method==='GET'||req.method==='HEAD')return await staticFile(req,res,url);
    fail(405,'That request method is not supported.','method_not_allowed');
  }catch(error){
    const constraintError=String(error?.code||'').startsWith('SQLITE_CONSTRAINT')||/^23/.test(String(error?.code||''));
    const status=error instanceof HttpError?error.status:(constraintError?409:500);
    if(status>=500)console.error(JSON.stringify({level:'error',message:'request_failed',method:req.method,path:(req.url||'').split('?')[0],error:error.message}));
    const message=status>=500?'Something went wrong. Please try again.':constraintError?'That record conflicts with existing data.':error.message;
    if(res.hasHeader('Set-Cookie'))res.removeHeader('Set-Cookie');
    if(!res.headersSent)sendJson(res,status,{error:{code:error instanceof HttpError?error.code:constraintError?'conflict':error.code||'internal_error',message}});
    else res.end();
  }
}

const server=createServer(handleHttpRequest);
const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  server.listen(port,host,()=>console.log(JSON.stringify({level:'info',message:'server_started',host,port,environment:process.env.NODE_ENV||'development'})));
  function shutdown(){ server.close(async()=>{await db.close();process.exit(0);}); setTimeout(()=>process.exit(1),5000).unref(); }
  process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
}


