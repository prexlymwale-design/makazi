const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');
const state = { session: null, view: 'dashboard', offsets: {}, search: '', data: [], page: null, busy: false };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
const navItems = [
  { section: 'WORKSPACE', id: 'dashboard', label: 'Dashboard', icon: '◫' },
  { section: 'PORTFOLIO', id: 'properties', label: 'Properties', icon: '⌂', action: 'manage_property' },
  { section: 'PORTFOLIO', id: 'units', label: 'Units', icon: '▦', action: 'manage_property' },
  { section: 'PORTFOLIO', id: 'tenants', label: 'Tenants', icon: '♙', action: 'manage_tenancy' },
  { section: 'PORTFOLIO', id: 'leases', label: 'Leases', icon: '▤', action: 'manage_tenancy' },
  { section: 'FINANCES', id: 'invoices', label: 'Rent & invoices', icon: '▧', action: 'manage_finance' },
  { section: 'FINANCES', id: 'payments', label: 'Payments', icon: '↙', action: 'manage_finance' },
  { section: 'FINANCES', id: 'reconciliation', label: 'M-Pesa reconciliation', icon: '⇄', action: 'manage_finance' },
  { section: 'FINANCES', id: 'arrears', label: 'Arrears', icon: '◷', action: 'manage_finance' },
  { section: 'OPERATIONS', id: 'expenses', label: 'Expenses', icon: '↗', action: 'manage_finance' },
  { section: 'OPERATIONS', id: 'maintenance', label: 'Maintenance', icon: '⌁' },
  { section: 'ADMINISTRATION', id: 'staff', label: 'Staff & permissions', icon: '♙', action: 'manage_staff' },
  { section: 'ADMINISTRATION', id: 'activity', label: 'Activity log', icon: '≋', action: 'view_audit' },
  { section: 'ADMINISTRATION', id: 'settings', label: 'Workspace settings', icon: '⚙', action: 'manage_settings' }
];
const can = (action) => {
  const role = state.session?.role;
  return ({
    owner: ['read','manage_property','manage_tenancy','manage_finance','approve_expense','manage_staff','manage_settings','maintenance_update','view_audit'],
    manager: ['read','manage_property','manage_tenancy','manage_finance','maintenance_update','view_audit'],
    accountant: ['read','manage_finance','view_audit']
  })[role]?.includes(action) || false;
};
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[ch]);
const money = (cents = 0) => new Intl.NumberFormat('en-KE',{style:'currency',currency:'KES',maximumFractionDigits:0}).format(Number(cents||0)/100);
const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-KE',{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Nairobi'}).format(new Date(`${value.slice(0,10)}T12:00:00Z`)) : '—';
const initials = (name='M') => name.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type','application/json');
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials:'same-origin', body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(payload.error?.message || 'Something went wrong. Please try again.');
  return payload;
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type === 'error' ? 'error' : ''}`;
  element.textContent = message;
  toastRegion.append(element);
  window.setTimeout(() => element.remove(), 3800);
}

function authScreen(mode = 'login', error = '') {
  const registering = mode === 'register';
  app.innerHTML = `
    <main class="auth-page">
      <aside class="auth-aside">
        <div class="auth-brand"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Property, made clearer</div></div></div>
        <div class="auth-copy">
          <p class="eyebrow auth-highlight">MADE FOR KENYA</p>
          <h1>Your rentals, in good order.</h1>
          <p>One calm workspace for properties, tenants, rent, and the details that keep a home running well.</p>
          <div class="auth-point"><span>✦</span><div>Rent records that stay easy to follow</div></div>
          <div class="auth-point"><span>✦</span><div>One view across every property and unit</div></div>
          <div class="auth-point"><span>✦</span><div>Designed around KES and Kenyan businesses</div></div>
        </div>
        <div class="auth-footer">A clear view of the work behind every home.</div>
      </aside>
      <section class="auth-main">
        <div class="auth-form-wrap">
          <div class="auth-brand auth-brand-mobile"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Property, made clearer</div></div></div>
          <p class="eyebrow">${registering ? 'GET STARTED' : 'WELCOME BACK'}</p>
          <h2>${registering ? 'Create your workspace' : 'Sign in to Makazi'}</h2>
          <p class="auth-subtitle">${registering ? 'Set up your business workspace. You can invite tenants after adding their rental records.' : 'Your properties and rent records are ready when you are.'}</p>
          <form id="auth-form" class="auth-fields" data-mode="${mode}">
            ${registering ? `<div class="field"><label for="fullName">Your name</label><input id="fullName" name="fullName" autocomplete="name" required maxlength="120" placeholder="e.g. Amina Wanjiku"></div><div class="field"><label for="organizationName">Business or workspace name</label><input id="organizationName" name="organizationName" required maxlength="120" placeholder="e.g. Kijani Property Co."></div>` : ''}
            <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></div>
            <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${registering?'new-password':'current-password'}" required minlength="${registering?'12':'1'}" placeholder="${registering?'At least 12 characters':'Enter your password'}"></div>
            <div class="auth-error" role="alert">${escapeHtml(error)}</div>
            <button class="button auth-submit" type="submit">${registering?'Create workspace':'Sign in'} <span>→</span></button>
          </form>
          <p class="auth-switch">${registering?'Already have an account?':'New to Makazi?'}<button class="text-button" data-action="auth-switch" data-mode="${registering?'login':'register'}">${registering?'Sign in':'Create a workspace'}</button></p>
          ${registering?'<p class="auth-switch auth-plan-note">By continuing, your workspace starts with the Starter unit allowance.</p>':''}
        </div>
      </section>
    </main>`;
}

function shell() {
  const session = state.session;
  const shown = navItems.filter(item => !item.action || can(item.action));
  const groups = [...new Set(shown.map(item=>item.section))];
  const navigation = groups.map(section=>`<div><div class="side-label">${section}</div><div class="nav-list">${shown.filter(item=>item.section===section).map(item=>`<button class="nav-item ${state.view===item.id?'active':''}" data-action="navigate" data-view="${item.id}"><span class="nav-icon">${item.icon}</span><span>${item.label}</span>${item.id==='arrears'&&state.arrearsCount?`<span class="nav-count">${state.arrearsCount}</span>`:''}</button>`).join('')}</div></div>`).join('');
  app.innerHTML = `<div class="mobile-shade" id="mobile-shade"></div>
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Property, made clearer</div></div></div>
        ${navigation}
        <div class="sidebar-bottom"><div class="workspace-chip"><span class="avatar">${escapeHtml(initials(session.user.fullName))}</span><div class="workspace-copy"><div class="workspace-name">${escapeHtml(session.organization.name)}</div><div class="workspace-role">${escapeHtml(session.role)} · ${escapeHtml(session.organization.currency||'KES')}</div></div></div></div>
      </aside>
      <div class="main-column">
        <header class="topbar"><button class="icon-button mobile-menu" data-action="menu" aria-label="Open navigation">☰</button><div class="crumb">Workspace <span class="crumb-separator">/</span><strong>${escapeHtml(viewTitle(state.view))}</strong></div><div class="top-actions"><span class="top-date">${new Intl.DateTimeFormat('en-KE',{weekday:'short',day:'numeric',month:'short',timeZone:'Africa/Nairobi'}).format(new Date())}</span><button class="icon-button" data-action="refresh" aria-label="Refresh page">↻</button><button class="button ghost small" data-action="logout">Sign out</button></div></header>
        <main class="content" id="content"><div class="boot boot-short">Loading your records…</div></main>
      </div>
    </div>`;
  renderView();
}

function viewTitle(view) {
  return ({dashboard:'Dashboard',properties:'Properties',units:'Units',tenants:'Tenants',leases:'Leases',invoices:'Rent & invoices',payments:'Payments',reconciliation:'M-Pesa reconciliation',arrears:'Arrears',expenses:'Expenses',maintenance:'Maintenance',staff:'Staff & permissions',activity:'Activity log',settings:'Workspace settings'})[view] || 'Dashboard';
}

const pageDescriptions = {
  properties:'Keep the full picture of the places you manage.', units:'See availability, rent, and unit details at a glance.', tenants:'Keep tenant contact and tenancy records together.', leases:'Review current and previous tenancy agreements.', invoices:'Create a monthly rent run and follow every open balance.', payments:'Record confirmed cash, bank, and other payments.', arrears:'See overdue balances and how long they have been outstanding.', expenses:'Track property costs and the approvals they need.', maintenance:'Keep requests moving from first report through resolution.', staff:'Invite your team with the right role and property access.', activity:'A record of key changes made in this workspace.', settings:'Keep the business details and approval rules up to date.'
};

function pageHeading(view, action = '', buttonLabel = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(state.session.organization.name)}</p><h1>${escapeHtml(viewTitle(view))}</h1><p class="subheading">${escapeHtml(pageDescriptions[view]||'A clear view of your rental operations.')}</p></div>${action?`<button class="button" data-action="${action}"><span>＋</span>${escapeHtml(buttonLabel)}</button>`:''}</div>`;
}

function badge(value) {
  const raw=String(value||'unknown').replaceAll('_',' ');
  let cls='';
  if(['pending approval','awaiting approval','open','in progress','assigned'].includes(raw))cls='warning';
  if(['overdue','urgent','rejected','90 plus'].includes(raw))cls='danger';
  if(['vacant','ended','former','closed'].includes(raw))cls='neutral';
  return `<span class="badge ${cls}">${escapeHtml(raw)}</span>`;
}

function tableMarkup({columns,rows,emptyTitle,emptyCopy,page,search=true,searchPlaceholder='Search records',exportable=true}) {
  const table=rows.length?`<div class="table-scroll"><table><thead><tr>${columns.map(col=>`<th>${escapeHtml(col.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(col=>`<td>${col.render?col.render(row):escapeHtml(row[col.key]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:`<div class="empty"><span class="empty-icon">⌂</span><h3>${escapeHtml(emptyTitle)}</h3><p>${escapeHtml(emptyCopy)}</p></div>`;
  const total=page?.total??rows.length, offset=page?.offset??0, limit=page?.limit??rows.length;
  const start=total?offset+1:0, end=Math.min(total,offset+rows.length);
  return `<div class="table-card"><div class="table-toolbar">${search?`<label class="search-wrap"><span>⌕</span><input class="search-input" id="table-search" value="${escapeHtml(state.search)}" placeholder="${escapeHtml(searchPlaceholder)}" aria-label="${escapeHtml(searchPlaceholder)}"></label>`:'<span class="panel-note">Latest records</span>'}<div class="toolbar-actions">${exportable&&rows.length?'<button class="button secondary small" data-action="export">↓ Export CSV</button>':''}</div></div>${table}<div class="table-footer"><span>Showing ${start}–${end} of ${total}</span><div class="pager"><button data-action="page-prev" aria-label="Previous page" ${offset<=0?'disabled':''}>‹</button><button data-action="page-next" aria-label="Next page" ${offset+limit>=total?'disabled':''}>›</button></div></div></div>`;
}

async function fetchPage(endpoint, view = state.view, { searchable = false } = {}) {
  const offset=state.offsets[view]||0;
  const query=new URLSearchParams({limit:'12',offset:String(offset)});
  if(searchable&&state.search)query.set('q',state.search);
  const result=await api(`${endpoint}?${query}`);
  state.data=result.data||[]; state.page=result.page||{total:state.data.length,offset,limit:12};
  return state.data;
}

function renderView() {
  const content=document.querySelector('#content'); if(!content)return;
  content.innerHTML=`<div class="boot boot-short">Loading ${escapeHtml(viewTitle(state.view).toLowerCase())}…</div>`;
  const renderer=({dashboard:renderDashboard,properties:renderProperties,units:renderUnits,tenants:renderTenants,leases:renderLeases,invoices:renderInvoices,payments:renderPayments,reconciliation:renderReconciliation,arrears:renderArrears,expenses:renderExpenses,maintenance:renderMaintenance,staff:renderStaff,activity:renderActivity,settings:renderSettings})[state.view]||renderDashboard;
  renderer().catch(error=>{content.innerHTML=`${pageHeading(state.view)}<div class="callout gold">${escapeHtml(error.message)}</div>`;});
}

async function renderDashboard() {
  const [dashboard, arrears, tickets] = await Promise.all([api('/dashboard'),api(`/arrears?asOf=${today}`),api('/maintenance?limit=4&offset=0')]);
  state.arrearsCount=arrears.rows.length;
  const m=dashboard.metrics; const occupancy=m.units?Math.round(m.occupied*100/m.units):0;
  const metrics=[
    {label:'Properties',value:m.properties,foot:`${m.units} total units`,icon:'⌂'},
    {label:'Occupancy',value:`${occupancy}%`,foot:`${m.occupied} occupied · ${Math.max(0,m.units-m.occupied)} available`,icon:'▦'},
    {label:'Rent invoiced',value:money(m.invoiced_cents),foot:`${new Intl.DateTimeFormat('en-KE',{month:'long',timeZone:'Africa/Nairobi'}).format(new Date())} billing`,icon:'▧'},
    {label:'Rent collected',value:money(m.collected_cents),foot:`${money(m.arrears_cents)} outstanding`,icon:'↙'}
  ];
  const max=Math.max(m.invoiced_cents,m.collected_cents,1);
  const topArrears=arrears.rows.slice(0,3);
  const attention=topArrears.length?topArrears.map(row=>`<div class="attention-item"><span class="attention-icon">◷</span><div class="attention-copy-wrap"><div class="attention-title">${escapeHtml(row.tenant_name)}</div><div class="attention-copy">${escapeHtml(row.property_name)} · ${escapeHtml(row.unit_number)} · ${row.days_overdue} days overdue</div></div><span class="attention-value">${money(row.balance_cents)}</span></div>`).join(''):`<div class="empty empty-compact"><span class="empty-icon">✓</span><h3>All caught up</h3><p>No overdue invoices to follow up today.</p></div>`;
  const payments=dashboard.recentPayments;
  const paymentTable=payments.length?`<div class="panel panel-flush"><div class="table-toolbar"><div><h2 class="panel-title">Recent payments</h2><p class="panel-note">Confirmed payments recorded in your workspace</p></div><button class="panel-link" data-action="navigate" data-view="payments">View all →</button></div><div class="table-scroll"><table><thead><tr><th>Tenant</th><th>Date</th><th>Method</th><th>Amount</th></tr></thead><tbody>${payments.map(p=>`<tr><td class="cell-primary">${escapeHtml(p.tenant_name)}</td><td>${dateLabel(p.received_date)}</td><td>${badge(p.method)}</td><td class="currency">${money(p.amount_cents)}</td></tr>`).join('')}</tbody></table></div></div>`:`<div class="panel"><div class="panel-head"><div><h2 class="panel-title">Recent payments</h2><p class="panel-note">Confirmed payments will appear here</p></div></div><div class="empty empty-payments"><span class="empty-icon">↙</span><h3>No payments yet</h3><p>Record the first confirmed payment to start your rent ledger.</p><button class="button small" data-action="navigate" data-view="payments">Go to payments</button></div></div>`;
  const upcoming=dashboard.expiring.length?dashboard.expiring.map(x=>`<div class="attention-item"><span class="attention-icon">▤</span><div><div class="attention-title">${escapeHtml(x.tenant_name)}</div><div class="attention-copy">${escapeHtml(x.property_name)} · ${escapeHtml(x.unit_number)}</div></div><span class="attention-value upcoming-value">${dateLabel(x.end_date)}</span></div>`).join(''):`<div class="attention-item"><span class="attention-icon">✓</span><div><div class="attention-title">No lease expirations due</div><div class="attention-copy">No active leases end in the next 60 days.</div></div></div>`;
  document.querySelector('#content').innerHTML=`${pageHeading('dashboard','add-property','Add property')}
    <section class="grid metrics-grid">${metrics.map(card=>`<article class="metric-card"><div class="metric-top"><span>${card.label}</span><span class="metric-icon">${card.icon}</span></div><div class="metric-value">${card.value}</div><div class="metric-foot">${card.foot}</div></article>`).join('')}</section>
    <section class="grid dash-grid dashboard-section"><article class="panel"><div class="panel-head"><div><h2 class="panel-title">Rent at a glance</h2><p class="panel-note">This month · collected versus invoiced</p></div><button class="panel-link" data-action="navigate" data-view="invoices">Open rent ledger →</button></div><div class="collect-bars"><div class="bar-row"><span class="bar-label">Invoiced</span><span class="bar-track"><span class="bar-fill bar-fill-invoiced level-100"></span></span><strong class="bar-value">${money(m.invoiced_cents)}</strong></div><div class="bar-row"><span class="bar-label">Collected</span><span class="bar-track"><span class="bar-fill level-${Math.min(100,Math.round(m.collected_cents/max*100/10)*10)}"></span></span><strong class="bar-value">${money(m.collected_cents)}</strong></div></div><div class="legend"><span><i class="legend-dot"></i>Confirmed receipts</span><span><i class="legend-dot gold"></i>${money(m.expenses_cents)} approved expenses this month</span></div></article>
    <article class="panel"><div class="panel-head"><div><h2 class="panel-title">Needs your attention</h2><p class="panel-note">${arrears.rows.length} overdue invoices · ${money(arrears.totalCents)} total</p></div><button class="panel-link" data-action="navigate" data-view="arrears">View arrears →</button></div><div class="attention-list">${attention}</div></article></section>
    <section class="grid dash-grid"><div>${paymentTable}</div><article class="panel"><div class="panel-head"><div><h2 class="panel-title">Coming up</h2><p class="panel-note">Lease end dates in the next 60 days</p></div></div><div class="attention-list">${upcoming}</div><div class="setting-row setting-row-spaced"><span class="setting-label">Maintenance needing action</span><strong>${m.open_maintenance}</strong></div></article></section>`;
}

async function renderProperties() {
  const searchable=true; const rows=await fetchPage('/properties','properties',{searchable});
  document.querySelector('#content').innerHTML=`${pageHeading('properties',can('manage_property')?'add-property':'','Add property')}${tableMarkup({rows,page:state.page,emptyTitle:'Start with a property',emptyCopy:'Add a building, estate, home, or commercial space to begin organizing your rental portfolio.',columns:[{label:'Property',render:r=>`<div class="cell-primary">${escapeHtml(r.name)}</div><div class="cell-secondary">${escapeHtml(r.town||r.county||r.address||'Location not added')}</div>`},{label:'Type',key:'property_type',render:r=>escapeHtml(r.property_type)},{label:'Units',render:r=>`${r.occupied_count||0} occupied <span class="muted-slash">/</span> ${r.unit_count||0}`},{label:'Status',render:r=>badge(r.status)},{label:'Added',render:r=>dateLabel(r.created_at?.slice(0,10))}],searchPlaceholder:'Search properties or towns'})}`;
}

async function renderUnits() {
  const rows=await fetchPage('/units','units',{searchable:true});
  document.querySelector('#content').innerHTML=`${pageHeading('units',can('manage_property')?'add-unit':'','Add unit')}${tableMarkup({rows,page:state.page,emptyTitle:'No units have been added',emptyCopy:'Add rentable units to your properties and see what is vacant or occupied.',columns:[{label:'Unit',render:r=>`<div class="cell-primary">${escapeHtml(r.unit_number)}</div><div class="cell-secondary">${escapeHtml(r.property_name)}${r.floor?` · ${escapeHtml(r.floor)}`:''}</div>`},{label:'Category',key:'category'},{label:'Monthly rent',render:r=>`<span class="currency">${money(r.rent_cents)}</span>`},{label:'Deposit',render:r=>money(r.deposit_cents)},{label:'Status',render:r=>badge(r.status)}],searchPlaceholder:'Search unit or property'})}`;
}

async function renderTenants() {
  const rows=await fetchPage('/tenants','tenants',{searchable:true});
  document.querySelector('#content').innerHTML=`${pageHeading('tenants',can('manage_tenancy')?'add-tenant':'','Add tenant')}${tableMarkup({rows,page:state.page,emptyTitle:'Add your first tenant',emptyCopy:'Tenant records hold only the contact details needed to manage a tenancy.',columns:[{label:'Tenant',render:r=>`<div class="cell-primary">${escapeHtml(r.full_name)}</div><div class="cell-secondary">${escapeHtml(r.email||'Email not supplied')}</div>`},{label:'Phone',key:'phone'},{label:'Current unit',render:r=>escapeHtml(r.current_unit||'—')},{label:'Leases',key:'lease_count'},{label:'Status',render:r=>badge(r.status)},{label:'Portal',render:r=>can('manage_tenancy')&&r.email?`<button class="button ghost small" data-action="invite-tenant" data-id="${r.id}">Create invite link</button>`:'Email needed'}],searchPlaceholder:'Search name or phone'})}`;
}

async function renderLeases() {
  const rows=await fetchPage('/leases');
  document.querySelector('#content').innerHTML=`${pageHeading('leases',can('manage_tenancy')?'add-lease':'','Create lease')}${tableMarkup({rows,page:state.page,emptyTitle:'No leases yet',emptyCopy:'Create a lease after adding a property, a unit, and a tenant.',columns:[{label:'Tenant',render:r=>`<div class="cell-primary">${escapeHtml(r.tenant_name)}</div><div class="cell-secondary">${escapeHtml(r.phone)}</div>`},{label:'Unit',render:r=>`<div class="cell-primary">${escapeHtml(r.unit_number)}</div><div class="cell-secondary">${escapeHtml(r.property_name)}</div>`},{label:'Monthly rent',render:r=>`<span class="currency">${money(r.monthly_rent_cents)}</span>`},{label:'Deposit requirement',render:r=>money(r.deposit_cents)},{label:'Term',render:r=>`${dateLabel(r.start_date)} — ${dateLabel(r.end_date)}`},{label:'Due',render:r=>`Day ${r.due_day}`},{label:'Status',render:r=>badge(r.status)},{label:'Records',render:r=>`<span class="inline-actions"><button class="button ghost small" data-action="deposit-ledger" data-id="${r.id}">Deposit</button>${r.status==='active'&&can('manage_tenancy')?`<button class="button ghost small" data-action="amend-lease" data-id="${r.id}">Amend</button><button class="button ghost small" data-action="end-lease" data-id="${r.id}">End</button>`:''}</span>`}]})}`;
}

async function renderInvoices() {
  const rows=await fetchPage('/invoices');
  const generate=can('manage_finance')?'<button class="button secondary" data-action="generate-invoices">↻ Generate this month</button>':'';
  document.querySelector('#content').innerHTML=`<div class="page-heading"><div><p class="eyebrow">${escapeHtml(state.session.organization.name)}</p><h1>Rent &amp; invoices</h1><p class="subheading">Create a monthly rent run and follow every open balance.</p></div><div class="toolbar-actions">${generate}</div></div>${tableMarkup({rows,page:state.page,emptyTitle:'Your rent ledger is ready',emptyCopy:'Create leases first, then generate this month’s invoices. The monthly run safely skips invoices already created.',columns:[{label:'Invoice',render:r=>`<div class="cell-primary">${escapeHtml(r.invoice_number)}</div><div class="cell-secondary">${escapeHtml(r.period)}</div>`},{label:'Tenant',render:r=>`<div class="cell-primary">${escapeHtml(r.tenant_name)}</div><div class="cell-secondary">${escapeHtml(r.property_name)} · ${escapeHtml(r.unit_number)}</div>`},{label:'Due date',render:r=>dateLabel(r.due_date)},{label:'Amount',render:r=>`<span class="currency">${money(r.total_cents)}</span>`},{label:'Paid',render:r=>money(r.paid_cents)},{label:'Balance',render:r=>`<span class="currency">${money(r.balance_cents)}</span>`},{label:'Status',render:r=>badge(r.status)}],search:false})}`;
}

async function renderPayments() {
  const rows=await fetchPage('/payments');
  document.querySelector('#content').innerHTML=`${pageHeading('payments',can('manage_finance')?'add-payment':'','Record payment')}<div class="callout gold spaced-bottom">Payments entered here are treated as confirmed cash or bank receipts. M-Pesa STK Push requires Daraja sandbox credentials and a public HTTPS callback URL.</div>${tableMarkup({rows,page:state.page,emptyTitle:'No confirmed payments yet',emptyCopy:'Record a cash, bank, or other confirmed receipt. Each payment is allocated to the tenant’s oldest open invoices first.',columns:[{label:'Tenant',render:r=>`<div class="cell-primary">${escapeHtml(r.tenant_name)}</div><div class="cell-secondary">${escapeHtml(r.reference||'No reference')}</div>`},{label:'Received',render:r=>dateLabel(r.received_date)},{label:'Method',render:r=>badge(r.method)},{label:'Amount',render:r=>`<span class="currency">${money(r.amount_cents)}</span>`},{label:'Allocated',render:r=>money(r.allocated_cents)},{label:'Unallocated',render:r=>money(Math.max(0,r.amount_cents-r.allocated_cents))}],search:false})}`;
}

async function renderReconciliation(){
  const rows=await fetchPage('/payments/mpesa/transactions');
  document.querySelector('#content').innerHTML=`${pageHeading('reconciliation')}<div class="callout gold spaced-bottom">Only successful server verification can turn a sandbox request into a confirmed receipt. Requests remain pending until Daraja confirms the result; this screen does not mark a transfer as paid based on a browser response.</div>${tableMarkup({rows,page:state.page,emptyTitle:'No M-Pesa requests yet',emptyCopy:'Daraja sandbox requests will appear here for status tracking and reconciliation.',columns:[{label:'Request',render:r=>`<div class="cell-primary">${escapeHtml(r.internal_reference)}</div><div class="cell-secondary">${escapeHtml(r.phone_number)}</div>`},{label:'Tenant',key:'tenant_name'},{label:'Requested',render:r=>new Intl.DateTimeFormat('en-KE',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Nairobi'}).format(new Date(r.created_at))},{label:'Amount',render:r=>`<span class="currency">${money(r.amount_cents)}</span>`},{label:'Receipt',render:r=>escapeHtml(r.provider_receipt||'—')},{label:'Status',render:r=>badge(r.status)}],search:false})}`;
}

async function renderArrears() {
  const offset=state.offsets.arrears||0;
  const result=await api(`/arrears?asOf=${today}&limit=12&offset=${offset}`); state.data=result.rows; state.page=result.page;
  const titles={'1_30':'1–30 days','31_60':'31–60 days','61_90':'61–90 days','90_plus':'90+ days'};
  const aging=Object.entries(result.aging).map(([key,value])=>`<div class="aging-card"><span>${titles[key]}</span><strong>${money(value)}</strong></div>`).join('');
  const columns=[{label:'Tenant',render:r=>`<div class="cell-primary">${escapeHtml(r.tenant_name)}</div><div class="cell-secondary">${escapeHtml(r.phone)}</div>`},{label:'Property / unit',render:r=>`<div class="cell-primary">${escapeHtml(r.property_name)} · ${escapeHtml(r.unit_number)}</div><div class="cell-secondary">${escapeHtml(r.invoice_number)} · ${escapeHtml(r.period)}</div>`},{label:'Due date',render:r=>dateLabel(r.due_date)},{label:'Overdue',render:r=>badge(`${r.days_overdue} days`)},{label:'Outstanding',render:r=>`<span class="currency">${money(r.balance_cents)}</span>`}];
  document.querySelector('#content').innerHTML=`${pageHeading('arrears')}${aging?`<section class="grid aging-grid">${aging}</section>`:''}<div class="panel arrears-panel"><div class="panel-head arrears-head"><div><h2 class="panel-title">Total overdue</h2><p class="panel-note">Outstanding invoice balances as at ${dateLabel(result.asOf)}</p></div><strong class="arrears-total">${money(result.totalCents)}</strong></div></div>${tableMarkup({rows:result.rows,page:result.page,emptyTitle:'No overdue rent',emptyCopy:'Open invoice balances that pass their due date will appear here.',columns,search:false,exportable:result.rows.length>0})}`;
}

async function renderExpenses() {
  const rows=await fetchPage('/expenses');
  const add=can('manage_finance')?`<button class="button" data-action="add-expense"><span>＋</span>Add expense</button>`:'';
  const columns=[{label:'Expense',render:r=>`<div class="cell-primary">${escapeHtml(r.category)}</div><div class="cell-secondary">${escapeHtml(r.description)}</div>`},{label:'Property / unit',render:r=>`<div class="cell-primary">${escapeHtml(r.property_name)}</div><div class="cell-secondary">${escapeHtml(r.unit_number||'Property-wide')}</div>`},{label:'Date',render:r=>dateLabel(r.spent_on)},{label:'Payee',render:r=>escapeHtml(r.supplier||'—')},{label:'Amount',render:r=>`<span class="currency">${money(r.amount_cents)}</span>`},{label:'Status',render:r=>r.status==='pending_approval'?`${badge(r.status)} ${can('approve_expense')?`<span class="inline-actions"><button class="button small" data-action="approve-expense" data-id="${r.id}" data-status="approved">Approve</button><button class="button ghost small" data-action="approve-expense" data-id="${r.id}" data-status="rejected">Reject</button></span>`:''}`:badge(r.status)}];
  document.querySelector('#content').innerHTML=`<div class="page-heading"><div><p class="eyebrow">${escapeHtml(state.session.organization.name)}</p><h1>Expenses</h1><p class="subheading">Track property costs and the approvals they need.</p></div>${add}</div>${tableMarkup({rows,page:state.page,emptyTitle:'No expenses recorded',emptyCopy:'Record a property expense. Costs above the approval threshold will wait for an owner’s decision.',columns,search:false})}`;
}

async function renderMaintenance() {
  const rows=await fetchPage('/maintenance');
  const add=can('maintenance_update')?`<button class="button" data-action="add-maintenance"><span>＋</span>New request</button>`:'';
  const columns=[{label:'Request',render:r=>`<div class="cell-primary">${escapeHtml(r.title)}</div><div class="cell-secondary">${escapeHtml(r.category)} · ${escapeHtml(r.tenant_name||'Staff report')}</div>`},{label:'Location',render:r=>`<div class="cell-primary">${escapeHtml(r.property_name)}</div><div class="cell-secondary">Unit ${escapeHtml(r.unit_number)}</div>`},{label:'Priority',render:r=>badge(r.priority)},{label:'Status',render:r=>can('maintenance_update')?`<select class="status-select" data-ticket-status="${r.id}" aria-label="Update request status"><option value="${r.status}" selected>${escapeHtml(r.status.replaceAll('_',' '))}</option>${['open','assigned','in_progress','awaiting_approval','resolved','closed'].filter(x=>x!==r.status).map(x=>`<option value="${x}">${escapeHtml(x.replaceAll('_',' '))}</option>`).join('')}</select>`:badge(r.status)},{label:'Reported',render:r=>dateLabel(r.created_at?.slice(0,10))}];
  document.querySelector('#content').innerHTML=`${pageHeading('maintenance',can('maintenance_update')?'add-maintenance':'','New request')}${tableMarkup({rows,page:state.page,emptyTitle:'Nothing needs repair yet',emptyCopy:'New maintenance reports will appear here, linked to the property and unit they concern.',columns,search:false})}`;
}

async function renderStaff(){
  const result=await api('/staff');const members=result.members;state.data=members;
  const active=members.filter(row=>row.role!=='owner').length;
  const memberRows=members.map(row=>`<tr><td><div class="cell-primary">${escapeHtml(row.full_name)}</div><div class="cell-secondary">${escapeHtml(row.email)}</div></td><td>${badge(row.role)}</td><td>${row.role==='caretaker'?`${row.assigned_properties} assigned properties`:'Workspace access'}</td><td>${dateLabel(row.created_at.slice(0,10))}</td></tr>`).join('');
  const pendingRows=result.invitations.map(row=>`<tr><td class="cell-primary">${escapeHtml(row.email)}</td><td>${badge(row.role)}</td><td>${dateLabel(row.expires_at.slice(0,10))}</td><td>${badge('pending')}</td></tr>`).join('');
  document.querySelector('#content').innerHTML=`<div class="page-heading"><div><p class="eyebrow">${escapeHtml(state.session.organization.name)}</p><h1>Staff &amp; permissions</h1><p class="subheading">Give each teammate the access they need for their role.</p></div><button class="button" data-action="add-staff"><span>＋</span>Invite staff</button></div>
    <div class="callout gold spaced-bottom">${active} of ${result.staffLimit} staff accounts used. Caretakers see only assigned properties and maintenance work. Invite links expire after 24 hours and must be shared manually.</div>
    <div class="grid staff-grid"><article class="panel"><div class="panel-head"><div><h2 class="panel-title">Workspace members</h2><p class="panel-note">Roles and access in this organization</p></div></div><div class="table-scroll"><table><thead><tr><th>Member</th><th>Role</th><th>Access</th><th>Added</th></tr></thead><tbody>${memberRows||'<tr><td colspan="4">No staff members added.</td></tr>'}</tbody></table></div></article>
    <article class="panel"><div class="panel-head"><div><h2 class="panel-title">Pending invitations</h2><p class="panel-note">Only active links are listed. The link itself is shown once when created.</p></div></div><div class="table-scroll"><table><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Status</th></tr></thead><tbody>${pendingRows||'<tr><td colspan="4">No pending invitations.</td></tr>'}</tbody></table></div></article></div>`;
}

async function renderActivity() {
  const rows=await fetchPage('/audit');
  document.querySelector('#content').innerHTML=`${pageHeading('activity')}${tableMarkup({rows,page:state.page,emptyTitle:'No workspace activity yet',emptyCopy:'Important changes such as new properties, leases, invoices, and payments are recorded here.',columns:[{label:'Activity',render:r=>`<div class="cell-primary">${escapeHtml(r.action.replaceAll('.',' ').replaceAll('_',' '))}</div><div class="cell-secondary">${escapeHtml(r.entity_type)} · ${escapeHtml(r.entity_id.slice(0,8))}</div>`},{label:'By',key:'actor_name'},{label:'When',render:r=>new Intl.DateTimeFormat('en-KE',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Nairobi'}).format(new Date(r.created_at))}],search:false,exportable:false})}`;
}

async function renderSettings() {
  const settings=await api('/settings');
  document.querySelector('#content').innerHTML=`${pageHeading('settings')}
    <div class="settings-grid"><form id="settings-form" class="form-card"><div class="panel-head"><div><h2 class="panel-title">Business details</h2><p class="panel-note">Your default market settings are configured for Kenya.</p></div></div><div class="form-grid"><div class="field full"><label for="businessName">Business name</label><input id="businessName" name="name" required maxlength="120" value="${escapeHtml(settings.name)}" ${can('manage_settings')?'':'disabled'}></div><div class="field"><label>Default currency</label><input value="${escapeHtml(settings.currency)}" disabled></div><div class="field"><label>Business timezone</label><input value="${escapeHtml(settings.timezone)}" disabled></div><div class="field"><label for="approvalThreshold">Expense approval threshold (KES)</label><input id="approvalThreshold" name="expenseApprovalThreshold" type="number" min="0" step="0.01" value="${(settings.expense_approval_threshold_cents/100).toFixed(2)}" ${can('manage_settings')?'':'disabled'}><small>Expenses above this amount wait for an owner’s approval.</small></div><div class="field"><label>Current plan</label><input value="${escapeHtml(settings.plan_id[0].toUpperCase()+settings.plan_id.slice(1))}" disabled></div></div>${can('manage_settings')?'<div class="form-actions"><button class="button" type="submit">Save settings</button></div>':''}</form>
    <aside class="panel"><div class="panel-head"><div><h2 class="panel-title">Workspace details</h2><p class="panel-note">Configuration and current plan allowance</p></div></div><div class="setting-row"><span class="setting-label">Workspace started</span><strong>${dateLabel(settings.created_at.slice(0,10))}</strong></div><div class="setting-row"><span class="setting-label">Plan</span><strong>${escapeHtml(settings.plan_id[0].toUpperCase()+settings.plan_id.slice(1))}</strong></div><div class="setting-row"><span class="setting-label">Timezone</span><strong>${escapeHtml(settings.timezone)}</strong></div><div class="callout gold settings-callout">Subscription billing is not connected. This local workspace does not charge a subscription fee.</div></aside></div>`;
}

async function tenantShell(){
  app.innerHTML=`<div class="tenant-shell"><header class="tenant-topbar"><div class="brand tenant-brand"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Tenant portal</div></div></div><div class="top-actions"><span class="tenant-greeting">${escapeHtml(state.session.user.fullName)}</span><button class="button ghost small" data-action="logout">Sign out</button></div></header><main class="tenant-content" id="tenant-content"><div class="boot">Loading your tenancy…</div></main></div>`;
  await renderTenantPortal();
}

async function caretakerShell(){
  app.innerHTML=`<div class="tenant-shell"><header class="tenant-topbar"><div class="brand tenant-brand"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Caretaker workspace</div></div></div><div class="top-actions"><span class="tenant-greeting">${escapeHtml(state.session.user.fullName)}</span><button class="button ghost small" data-action="logout">Sign out</button></div></header><main class="tenant-content" id="caretaker-content"><div class="boot">Loading assigned properties…</div></main></div>`;
  await renderCaretakerPortal();
}

async function renderCaretakerPortal(){
  const [overview,unitsResult,ticketResult]=await Promise.all([api('/caretaker/overview'),api('/caretaker/units?limit=12&offset=0'),api('/caretaker/maintenance?limit=12&offset=0')]);
  const content=document.querySelector('#caretaker-content');if(!content)return;state.data=unitsResult.data;
  const properties=overview.properties.map(property=>`<div class="attention-item"><span class="attention-icon">⌂</span><div class="attention-copy-wrap"><div class="attention-title">${escapeHtml(property.name)}</div><div class="attention-copy">${escapeHtml(property.town||property.county||'Location not supplied')} · ${property.occupied_count}/${property.unit_count} occupied</div></div></div>`).join('');
  const units=unitsResult.data.map(unit=>`<tr><td><div class="cell-primary">${escapeHtml(unit.unit_number)}</div><div class="cell-secondary">${escapeHtml(unit.property_name)}</div></td><td>${escapeHtml(unit.category)}</td><td>${badge(unit.status)}</td></tr>`).join('');
  const tickets=ticketResult.data.map(ticket=>`<tr><td><div class="cell-primary">${escapeHtml(ticket.title)}</div><div class="cell-secondary">${escapeHtml(ticket.description)}</div></td><td><div class="cell-primary">${escapeHtml(ticket.property_name)}</div><div class="cell-secondary">Unit ${escapeHtml(ticket.unit_number)}</div></td><td>${badge(ticket.priority)}</td><td><select class="status-select" data-ticket-status="${ticket.id}" aria-label="Update maintenance status"><option value="${ticket.status}" selected>${escapeHtml(ticket.status.replaceAll('_',' '))}</option>${['assigned','in_progress','resolved'].filter(value=>value!==ticket.status).map(value=>`<option value="${value}">${escapeHtml(value.replaceAll('_',' '))}</option>`).join('')}</select></td></tr>`).join('');
  content.innerHTML=`<div class="tenant-heading"><div><p class="eyebrow">${escapeHtml(state.session.organization.name)}</p><h1>Good day, ${escapeHtml(state.session.user.fullName.split(' ')[0])}</h1><p class="subheading">Your assigned buildings and maintenance work.</p></div><button class="button" data-action="caretaker-maintenance">＋ Report an issue</button></div>
    <section class="grid tenant-metrics caretaker-metrics"><article class="metric-card"><div class="metric-top"><span>Assigned properties</span><span class="metric-icon">⌂</span></div><div class="metric-value">${overview.properties.length}</div><div class="metric-foot">Only buildings assigned to you</div></article><article class="metric-card"><div class="metric-top"><span>Assigned units</span><span class="metric-icon">▦</span></div><div class="metric-value">${unitsResult.page.total}</div><div class="metric-foot">Across your assigned properties</div></article><article class="metric-card"><div class="metric-top"><span>Open maintenance</span><span class="metric-icon">⌁</span></div><div class="metric-value">${overview.openTickets}</div><div class="metric-foot">Requests needing action</div></article></section>
    <section class="tenant-grid"><article class="panel"><div class="panel-head"><div><h2 class="panel-title">My properties</h2><p class="panel-note">Availability at your assigned buildings</p></div></div><div class="attention-list">${properties||'<p class="panel-note">No properties are assigned to this account.</p>'}</div></article><article class="panel"><div class="panel-head"><div><h2 class="panel-title">Units</h2><p class="panel-note">Assigned unit status</p></div></div><div class="table-scroll"><table><thead><tr><th>Unit</th><th>Category</th><th>Status</th></tr></thead><tbody>${units||'<tr><td colspan="3">No units found.</td></tr>'}</tbody></table></div></article><article class="panel tenant-span"><div class="panel-head"><div><h2 class="panel-title">Maintenance work</h2><p class="panel-note">Update assigned requests as they progress</p></div></div><div class="table-scroll"><table><thead><tr><th>Request</th><th>Location</th><th>Priority</th><th>Status</th></tr></thead><tbody>${tickets||'<tr><td colspan="4">No maintenance requests found.</td></tr>'}</tbody></table></div></article></section>`;
}

function acceptStaffInvitationScreen(token,error=''){
  app.innerHTML=`<main class="auth-page"><aside class="auth-aside"><div class="auth-brand"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Property, made clearer</div></div></div><div class="auth-copy"><p class="eyebrow auth-highlight">TEAM INVITATION</p><h1>Set up your Makazi account.</h1><p>Choose a password to join your property team's workspace.</p></div><div class="auth-footer">A clear view of the work behind every home.</div></aside><section class="auth-main"><div class="auth-form-wrap"><div class="auth-brand auth-brand-mobile"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Property, made clearer</div></div></div><p class="eyebrow">INVITATION</p><h2>Accept your team invite</h2><p class="auth-subtitle">Your role and property access were set by the workspace owner.</p><form id="accept-staff-invite-form" class="auth-fields"><input type="hidden" name="token" value="${escapeHtml(token)}"><div class="field"><label for="staffFullName">Your full name</label><input id="staffFullName" name="fullName" required maxlength="120" autocomplete="name"></div><div class="field"><label for="staffInvitePassword">Password</label><input id="staffInvitePassword" name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password" placeholder="At least 12 characters"></div><div class="auth-error" role="alert">${escapeHtml(error)}</div><button type="submit" class="button auth-submit">Join workspace <span>→</span></button></form><p class="auth-switch">Already set up? <button class="text-button" data-action="auth-switch" data-mode="login">Sign in</button></p></div></section></main>`;
}

async function renderTenantPortal(){
  const result=await api('/tenant/portal');const content=document.querySelector('#tenant-content');if(!content)return;
  const lease=result.lease;
  const cards=[
    {label:'Outstanding balance',value:money(result.balance),foot:result.overdueCount?`${result.overdueCount} overdue invoice${result.overdueCount===1?'':'s'}`:'Across your invoices',icon:'◷'},
    {label:'Monthly rent',value:lease?money(lease.monthly_rent_cents):'—',foot:lease?`Due on day ${lease.due_day}`:'No active lease',icon:'▧'},
    {label:'Deposit ledger',value:money(result.depositHeldCents),foot:'Recorded separately from rent',icon:'◇'},
    {label:'Current home',value:lease?escapeHtml(lease.unit_number):'—',foot:lease?`${escapeHtml(lease.property_name)}${lease.town?` · ${escapeHtml(lease.town)}`:''}`:'Contact your property manager',icon:'⌂'}
  ];
  const invoiceRows=result.invoices.map(r=>`<tr><td><div class="cell-primary">${escapeHtml(r.invoice_number)}</div><div class="cell-secondary">${escapeHtml(r.period)}</div></td><td>${dateLabel(r.due_date)}</td><td class="currency">${money(r.total_cents)}</td><td class="currency">${money(r.balance_cents)}</td><td>${badge(r.status)}</td></tr>`).join('');
  const paymentRows=result.payments.map(r=>`<tr><td>${dateLabel(r.received_date)}</td><td>${badge(r.method)}</td><td>${escapeHtml(r.reference||'—')}</td><td class="currency">${money(r.amount_cents)}</td></tr>`).join('');
  const requests=result.maintenance.map(r=>`<div class="attention-item"><span class="attention-icon">⌁</span><div class="attention-copy-wrap"><div class="attention-title">${escapeHtml(r.title)}</div><div class="attention-copy">${escapeHtml(r.category)} · ${dateLabel(r.created_at.slice(0,10))}</div></div>${badge(r.status)}</div>`).join('');
  content.innerHTML=`<div class="tenant-heading"><div><p class="eyebrow">${escapeHtml(state.session.organization.name)}</p><h1>Hello, ${escapeHtml(result.tenant.full_name.split(' ')[0])}</h1><p class="subheading">Your home, rent, and requests in one place.</p></div><button class="button" data-action="tenant-maintenance">＋ Report an issue</button></div>
    <section class="grid tenant-metrics">${cards.map(card=>`<article class="metric-card"><div class="metric-top"><span>${card.label}</span><span class="metric-icon">${card.icon}</span></div><div class="metric-value">${card.value}</div><div class="metric-foot">${card.foot}</div></article>`).join('')}</section>
    <div class="callout gold spaced-bottom">Deposit amounts are shown from workspace records. Makazi is a recordkeeping tool and does not hold funds.</div>
    <section class="tenant-grid"><article class="panel tenant-span"><div class="panel-head"><div><h2 class="panel-title">Your invoices</h2><p class="panel-note">Recent rent charges and outstanding balances</p></div></div>${invoiceRows?`<div class="table-scroll"><table><thead><tr><th>Invoice</th><th>Due</th><th>Amount</th><th>Balance</th><th>Status</th></tr></thead><tbody>${invoiceRows}</tbody></table></div>`:`<div class="empty empty-compact"><span class="empty-icon">▧</span><h3>No invoices yet</h3><p>Your property manager will share rent invoices here.</p></div>`}</article>
    <article class="panel"><div class="panel-head"><div><h2 class="panel-title">Maintenance requests</h2><p class="panel-note">Track the latest updates</p></div></div><div class="attention-list">${requests||'<p class="panel-note">No requests submitted.</p>'}</div><button class="panel-link tenant-link" data-action="tenant-maintenance">Report a repair →</button></article>
    <article class="panel"><div class="panel-head"><div><h2 class="panel-title">Payment history</h2><p class="panel-note">Confirmed receipts in your tenant ledger</p></div></div>${paymentRows?`<div class="table-scroll"><table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${paymentRows}</tbody></table></div>`:'<p class="panel-note">No confirmed payments are recorded yet.</p>'}</article>
    <article class="panel"><div class="panel-head"><div><h2 class="panel-title">Your contact details</h2><p class="panel-note">Keep your property manager up to date</p></div></div><form id="tenant-profile-form"><div class="form-grid tenant-form-grid"><div class="field"><label for="tenantPhone">Phone number</label><input id="tenantPhone" name="phone" required maxlength="40" value="${escapeHtml(result.tenant.phone)}"></div><div class="field"><label for="tenantEmail">Email address</label><input id="tenantEmail" name="email" type="email" maxlength="254" value="${escapeHtml(result.tenant.email)}"></div></div><div class="form-actions"><button class="button secondary small" type="submit">Save contact details</button></div></form></article></section>`;
}

function acceptInvitationScreen(token,error=''){
  app.innerHTML=`<main class="auth-page"><aside class="auth-aside"><div class="auth-brand"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Property, made clearer</div></div></div><div class="auth-copy"><p class="eyebrow auth-highlight">TENANT PORTAL</p><h1>Your tenancy, all in one place.</h1><p>View rent records, confirmed payments, and maintenance requests from your property manager.</p></div><div class="auth-footer">A clear view of the work behind every home.</div></aside><section class="auth-main"><div class="auth-form-wrap"><div class="auth-brand auth-brand-mobile"><span class="brand-mark">M</span><div><div class="brand-name">Makazi</div><div class="brand-caption">Property, made clearer</div></div></div><p class="eyebrow">INVITATION</p><h2>Set up your tenant portal</h2><p class="auth-subtitle">Choose a password to access your tenancy details.</p><form id="accept-invite-form" class="auth-fields"><input type="hidden" name="token" value="${escapeHtml(token)}"><div class="field"><label for="invitePassword">Password</label><input id="invitePassword" name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password" placeholder="At least 12 characters"></div><div class="auth-error" role="alert">${escapeHtml(error)}</div><button type="submit" class="button auth-submit">Create portal account <span>→</span></button></form><p class="auth-switch">Already set up? <button class="text-button" data-action="auth-switch" data-mode="login">Sign in</button></p></div></section></main>`;
}

async function openTenantMaintenance(){
  openDialog('Report a maintenance issue','Your request will be linked to your current home.',`<form id="tenant-maintenance-form"><div class="form-grid">${field({name:'title',label:'Request title',placeholder:'e.g. Kitchen tap leaking'})}${field({name:'category',label:'Category',options:['Plumbing','Electrical','Cleaning','Security','Appliance','General','Other'].map(x=>({value:x,label:x}))})}${field({name:'priority',label:'Priority',options:['low','normal','high'].map(x=>({value:x,label:x[0].toUpperCase()+x.slice(1)})),value:'normal'})}${field({name:'description',label:'Describe the issue',type:'textarea',full:true})}</div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button">Send request</button></div></form>`);
}

async function openTenantInvite(tenantId){
  try{
    const result=await api('/tenant-invitations',{method:'POST',body:{tenantId}});
    const inviteUrl=new URL(result.invitationPath,window.location.origin).toString();
    openDialog('Tenant invite link','Share this one-time setup link with the tenant. It expires in 24 hours.',`<div class="field"><label for="inviteLink">One-time invitation link</label><input id="inviteLink" readonly value="${escapeHtml(inviteUrl)}"><small>This workspace does not send email. Share the link through your own trusted channel.</small></div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Close</button><button type="button" class="button" data-action="copy-invite">Copy link</button></div>`);
  }catch(error){toast(error.message,'error');}
}

async function openStaffInvite(){
  try{
    const result=await api('/properties?limit=100&offset=0');const properties=result.data.filter(row=>row.status==='active');
    openDialog('Invite a staff member','Choose a role. Caretakers are limited to the properties you assign.',`<form id="staff-invite-form"><div class="form-grid">${field({name:'email',label:'Work email',type:'email',placeholder:'teammate@example.com'})}${field({name:'role',label:'Role',options:[{value:'manager',label:'Property manager'},{value:'accountant',label:'Accountant'},{value:'caretaker',label:'Caretaker'}]})}<div class="field full"><label for="staffProperties">Caretaker properties</label><select id="staffProperties" name="propertyIds" multiple size="${Math.min(5,Math.max(2,properties.length))}" class="multi-select">${properties.map(row=>`<option value="${row.id}">${escapeHtml(row.name)}${row.town?` · ${escapeHtml(row.town)}`:''}</option>`).join('')}</select><small>Required for caretakers. Hold Ctrl while selecting more than one property.</small></div></div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button">Create invite link</button></div></form>`);
  }catch(error){toast(error.message,'error');}
}

async function submitStaffInvite(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Creating…';
  try{
    const body={email:form.elements.email.value.trim(),role:form.elements.role.value,propertyIds:[...form.elements.propertyIds.selectedOptions].map(option=>option.value)};
    const result=await api('/staff-invitations',{method:'POST',body});form.closest('dialog')?.close();
    const inviteUrl=new URL(result.invitationPath,window.location.origin).toString();
    openDialog('Staff invite link','Share this one-time link with your teammate. It expires in 24 hours.',`<div class="field"><label for="inviteLink">One-time invitation link</label><input id="inviteLink" readonly value="${escapeHtml(inviteUrl)}"><small>The link will not be sent by email. Share it through a trusted channel.</small></div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Close</button><button type="button" class="button" data-action="copy-invite">Copy link</button></div>`);
    renderView();
  }catch(error){button.disabled=false;button.textContent='Create invite link';toast(error.message,'error');}
}

async function openCaretakerMaintenance(){
  try{
    const result=await api('/caretaker/units?limit=100&offset=0');
    const options=result.data.map(unit=>({value:unit.id,label:`${unit.property_name} · ${unit.unit_number}`}));
    openDialog('Report a maintenance issue','The request will be linked to one of your assigned units.',`<form id="caretaker-maintenance-form"><div class="form-grid">${field({name:'unitId',label:'Assigned unit',options})}${field({name:'title',label:'Request title',placeholder:'e.g. Stairwell light out'})}${field({name:'category',label:'Category',options:['Plumbing','Electrical','Cleaning','Security','Appliance','General','Other'].map(x=>({value:x,label:x}))})}${field({name:'priority',label:'Priority',options:['low','normal','high'].map(x=>({value:x,label:x[0].toUpperCase()+x.slice(1)})),value:'normal'})}${field({name:'description',label:'Description',type:'textarea',full:true})}</div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button">Send request</button></div></form>`);
  }catch(error){toast(error.message,'error');}
}

async function submitStaffInvitation(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Joining…';
  try{
    const result=await api('/auth/accept-staff-invitation',{method:'POST',body:formData(form)});state.session={...result,organization:{...result.organization},user:{...result.user}};window.history.replaceState({},'', '/');
    if(result.role==='caretaker')await caretakerShell();else shell();
  }catch(error){button.disabled=false;button.textContent='Join workspace →';form.querySelector('.auth-error').textContent=error.message;}
}

async function submitCaretakerMaintenance(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Sending…';
  try{await api('/caretaker/maintenance',{method:'POST',body:formData(form)});form.closest('dialog')?.close();toast('Maintenance request created.');renderCaretakerPortal();}
  catch(error){button.disabled=false;button.textContent='Send request';toast(error.message,'error');}
}

async function openDepositLedger(leaseId){
  try{
    const result=await api(`/leases/${leaseId}/deposits`);const lease=result.lease;
    const rows=result.transactions.map(row=>`<tr><td>${dateLabel(row.created_at.slice(0,10))}</td><td>${badge(row.transaction_type)}</td><td>${badge(row.method)}</td><td>${escapeHtml(row.reference||'—')}</td><td class="currency">${money(row.amount_cents)}</td></tr>`).join('');
    const form=can('manage_finance')?`<form id="deposit-form" data-lease-id="${leaseId}"><div class="form-grid">${field({name:'type',label:'Deposit action',options:[{value:'received',label:'Record deposit received'},{value:'refunded',label:'Record deposit refunded'}]})}${field({name:'amount',label:'Amount (KES)',type:'number',min:'0.01',step:'0.01'})}${field({name:'method',label:'Confirmed method',options:[{value:'cash',label:'Cash'},{value:'bank',label:'Bank transfer'},{value:'other',label:'Other confirmed receipt'}]})}${field({name:'reference',label:'Reference',required:false})}</div><div class="form-actions"><button type="submit" class="button">Save deposit entry</button></div></form>`:'';
    openDialog('Deposit ledger',`${lease.property_name} · ${lease.unit_number} · ${lease.tenant_name}`,`<div class="grid deposit-summary"><div class="aging-card"><span>Required</span><strong>${money(result.expectedCents)}</strong></div><div class="aging-card"><span>Received</span><strong>${money(result.received_cents)}</strong></div><div class="aging-card"><span>Refunded</span><strong>${money(result.refunded_cents)}</strong></div><div class="aging-card"><span>Currently recorded</span><strong>${money(result.held_cents)}</strong></div></div><div class="table-scroll deposit-history"><table><thead><tr><th>Date</th><th>Action</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${rows||'<tr><td colspan="5">No deposit transactions recorded.</td></tr>'}</tbody></table></div>${form}<div class="callout gold settings-callout">This ledger records confirmed deposit receipts and refunds. It does not represent a bank account or custody of funds.</div>`);
  }catch(error){toast(error.message,'error');}
}

function openLeaseAmendment(leaseId){
  const lease=state.data.find(row=>row.id===leaseId);if(!lease){toast('Refresh the lease list and try again.','error');return;}
  openDialog('Amend lease terms',`${lease.tenant_name} · ${lease.property_name} · ${lease.unit_number}`,`<form id="lease-amend-form" data-lease-id="${leaseId}"><div class="form-grid">${field({name:'monthlyRent',label:'Monthly rent (KES)',type:'number',min:'0.01',step:'0.01',value:(lease.monthly_rent_cents/100).toFixed(2)})}${field({name:'deposit',label:'Deposit requirement (KES)',type:'number',min:'0',step:'0.01',value:(lease.deposit_cents/100).toFixed(2)})}${field({name:'dueDay',label:'Due day',type:'number',min:'1',max:'28',value:lease.due_day})}</div><div class="callout gold settings-callout">Existing invoices and prior lease terms stay in the history.</div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button">Save amendment</button></div></form>`);
}

function openLeaseEnd(leaseId){
  const lease=state.data.find(row=>row.id===leaseId);if(!lease){toast('Refresh the lease list and try again.','error');return;}
  openDialog('End this lease?',`${lease.tenant_name} · ${lease.property_name} · ${lease.unit_number}`,`<form id="lease-end-form" data-lease-id="${leaseId}"><div class="callout gold">This closes the tenancy, preserves its financial history, and makes the unit available for a new lease.</div><div class="form-grid lease-end-date">${field({name:'endDate',label:'Move-out date',type:'date',value:today})}</div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Keep lease open</button><button type="submit" class="button danger">End lease</button></div></form>`);
}

async function submitInvitation(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Creating…';
  try{const result=await api('/auth/accept-invitation',{method:'POST',body:formData(form)});state.session={...result,organization:{...result.organization},user:{...result.user}};window.history.replaceState({},'', '/');await tenantShell();}
  catch(error){button.disabled=false;button.textContent='Create portal account →';form.querySelector('.auth-error').textContent=error.message;}
}

function field({name,label,type='text',required=true,placeholder='',value='',options=null,help='',min='',max='',step='',full=false}) {
  const attrs=`name="${name}" id="${name}" ${required?'required':''} ${min?`min="${min}"`:''} ${max?`max="${max}"`:''} ${step?`step="${step}"`:''}`;
  const control=options?`<select ${attrs}><option value="">Choose ${escapeHtml(label.toLowerCase())}</option>${options.map(o=>`<option value="${escapeHtml(o.value)}" ${String(o.value)===String(value)?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}</select>`:type==='textarea'?`<textarea ${attrs} placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`:`<input ${attrs} type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
  return `<div class="field ${full?'full':''}"><label for="${name}">${escapeHtml(label)}${required?'':' <span class="optional-label">(optional)</span>'}</label>${control}${help?`<small>${escapeHtml(help)}</small>`:''}</div>`;
}

function openDialog(title, subtitle, content, formId) {
  let dialog=document.querySelector('#workspace-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='workspace-dialog';document.body.append(dialog);}
  if(dialog.open)dialog.close();
  dialog.innerHTML=`<div class="dialog-head"><div><h2>${escapeHtml(title)}</h2><p class="panel-note">${escapeHtml(subtitle)}</p></div><button class="dialog-close" data-action="close-dialog" aria-label="Close dialog">×</button></div><div class="dialog-body">${content}</div>`;
  dialog.showModal();
  dialog.querySelector('form')?.querySelector('input,select,textarea')?.focus();
}

async function openForm(kind) {
  try {
    const props=kind==='unit'||kind==='expense'?await api('/properties?limit=100&offset=0'):null;
    const units=kind==='lease'||kind==='maintenance'||kind==='expense'?await api('/units?limit=100&offset=0'):null;
    const tenants=kind==='lease'||kind==='payment'||kind==='maintenance'?await api('/tenants?limit=100&offset=0'):null;
    const propertyOptions=(props?.data||[]).filter(p=>p.status==='active').map(p=>({value:p.id,label:`${p.name}${p.town?` · ${p.town}`:''}`}));
    const unitOptions=(units?.data||[]).filter(u=>kind==='lease'?u.status==='vacant':u.status!=='archived').map(u=>({value:u.id,label:`${u.property_name} · ${u.unit_number}${kind==='lease'?` — ${money(u.rent_cents)}/mo`:''}`}));
    const tenantOptions=(tenants?.data||[]).filter(t=>t.status==='active').map(t=>({value:t.id,label:`${t.full_name} · ${t.phone}`}));
    const definitions={
      property:{title:'Add a property',subtitle:'Start a record for a building or rental property.',endpoint:'/properties',fields:[field({name:'name',label:'Property name',placeholder:'e.g. Kijani Court'}),field({name:'propertyType',label:'Property type',options:['Apartment building','Residential estate','Bedsitter / rooms','House','Commercial','Mixed use','Other'].map(x=>({value:x,label:x}))}),field({name:'address',label:'Physical address',required:false,placeholder:'Street or area'}),field({name:'county',label:'County',required:false,placeholder:'e.g. Kiambu'}),field({name:'town',label:'Town or city',required:false,placeholder:'e.g. Thika'}),field({name:'description',label:'Description',type:'textarea',required:false,full:true})]},
      unit:{title:'Add a unit',subtitle:'Give each rentable space its own record.',endpoint:'/units',fields:[field({name:'propertyId',label:'Property',options:propertyOptions}),field({name:'unitNumber',label:'Unit number',placeholder:'e.g. B-04'}),field({name:'category',label:'Category',options:['Apartment','Bedsitter','Single room','House','Shop','Office','Parking','Other'].map(x=>({value:x,label:x}))}),field({name:'floor',label:'Floor or block',required:false,placeholder:'e.g. Block B, 2nd floor'}),field({name:'monthlyRent',label:'Monthly rent (KES)',type:'number',min:'0',step:'0.01',placeholder:'0.00'}),field({name:'deposit',label:'Deposit requirement (KES)',type:'number',min:'0',step:'0.01',required:false,value:'0'}),field({name:'notes',label:'Notes',type:'textarea',required:false,full:true})]},
      tenant:{title:'Add a tenant',subtitle:'Only add the contact details needed to manage the tenancy.',endpoint:'/tenants',fields:[field({name:'fullName',label:'Full name',placeholder:'Tenant name'}),field({name:'phone',label:'Phone number',type:'tel',placeholder:'+254 7xx xxx xxx'}),field({name:'email',label:'Email address',type:'email',required:false,placeholder:'tenant@example.com'}),field({name:'notes',label:'Notes',type:'textarea',required:false,full:true})]},
      lease:{title:'Create a lease',subtitle:'Link an active tenant to a vacant unit.',endpoint:'/leases',fields:[field({name:'unitId',label:'Vacant unit',options:unitOptions}),field({name:'tenantId',label:'Tenant',options:tenantOptions}),field({name:'startDate',label:'Start date',type:'date',value:today}),field({name:'endDate',label:'End date',type:'date',required:false}),field({name:'monthlyRent',label:'Monthly rent (KES)',type:'number',min:'0.01',step:'0.01',placeholder:'0.00'}),field({name:'deposit',label:'Deposit due (KES)',type:'number',min:'0',step:'0.01',required:false,value:'0'}),field({name:'dueDay',label:'Rent due day',type:'number',min:'1',max:'28',value:'1',help:'Choose a day from 1 to 28 so every month has the same due date.'})]},
      payment:{title:'Record a payment',subtitle:'Record a confirmed receipt. The oldest open invoice is allocated first.',endpoint:'/payments',fields:[field({name:'tenantId',label:'Tenant',options:tenantOptions}),field({name:'amount',label:'Amount (KES)',type:'number',min:'0.01',step:'0.01'}),field({name:'method',label:'Payment method',options:[{value:'cash',label:'Cash'},{value:'bank',label:'Bank transfer'},{value:'other',label:'Other confirmed receipt'},{value:'mpesa_sandbox',label:'M-Pesa STK Push (sandbox)'}]}),field({name:'receivedDate',label:'Received date',type:'date',value:today}),field({name:'reference',label:'Receipt or transfer reference',required:false,placeholder:'e.g. bank reference'}),field({name:'phone',label:'M-Pesa phone number',type:'tel',required:false,placeholder:'+254 7xx xxx xxx',help:'Required only for a sandbox STK Push.'}),`<div class="field full"><div class="callout gold">Record cash and bank receipts only after you confirm them. An STK request stays pending until the server verifies its Daraja callback.</div></div>`]},
      expense:{title:'Add an expense',subtitle:'Record a cost against its property; larger expenses may need approval.',endpoint:'/expenses',fields:[field({name:'propertyId',label:'Property',options:propertyOptions}),field({name:'unitId',label:'Unit',required:false,options:[{value:'',label:'Property-wide'}].concat(unitOptions)}),field({name:'category',label:'Category',options:['Repairs and maintenance','Water','Electricity','Security','Cleaning','Caretaker wages','Management fees','Insurance','Taxes and statutory charges','Other'].map(x=>({value:x,label:x}))}),field({name:'amount',label:'Amount (KES)',type:'number',min:'0.01',step:'0.01'}),field({name:'spentOn',label:'Date',type:'date',value:today}),field({name:'supplier',label:'Supplier or payee',required:false}),field({name:'description',label:'Description',type:'textarea',full:true})]},
      maintenance:{title:'New maintenance request',subtitle:'Link a repair or service request to the property and unit.',endpoint:'/maintenance',fields:[field({name:'unitId',label:'Unit',options:unitOptions}),field({name:'tenantId',label:'Tenant',required:false,options:[{value:'',label:'Staff report'}].concat(tenantOptions)}),field({name:'title',label:'Request title',placeholder:'e.g. Kitchen tap leaking'}),field({name:'category',label:'Category',options:['Plumbing','Electrical','Cleaning','Security','Appliance','General','Other'].map(x=>({value:x,label:x}))}),field({name:'priority',label:'Priority',options:['low','normal','high','urgent'].map(x=>({value:x,label:x[0].toUpperCase()+x.slice(1)}))}),field({name:'estimate',label:'Estimated cost (KES)',type:'number',required:false,min:'0',step:'0.01',value:'0'}),field({name:'description',label:'What needs attention?',type:'textarea',full:true})]}
    };
    const definition=definitions[kind]; if(!definition)return;
    if((kind==='unit'&&propertyOptions.length===0)||(kind==='lease'&&(!unitOptions.length||!tenantOptions.length))||(kind==='payment'&&!tenantOptions.length)||(kind==='maintenance'&&!unitOptions.length)){
      toast('Add the related property, unit, or tenant first.', 'error');return;
    }
    openDialog(definition.title,definition.subtitle,`<form id="record-form" data-kind="${kind}" data-endpoint="${definition.endpoint}"><div class="form-grid">${definition.fields.join('')}</div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button">Save record</button></div></form>`);
  }catch(error){toast(error.message,'error');}
}

function formData(form) {
  const data=Object.fromEntries(new FormData(form).entries());
  for(const [key,value] of Object.entries(data))if(typeof value==='string')data[key]=value.trim();
  return data;
}

async function submitForm(form) {
  const submit=form.querySelector('[type="submit"]');
  if(submit){submit.disabled=true;submit.textContent='Saving…';}
  try{
    const kind=form.dataset.kind;
    if(kind==='settings'){
      await api('/settings',{method:'PATCH',body:formData(form)}); state.session.organization.name=form.elements.name.value.trim();
      toast('Workspace settings saved.');
    }else{
      let endpoint=form.dataset.endpoint; const body=formData(form); const headers={};
      if(kind==='payment'){
        headers['Idempotency-Key']=crypto.randomUUID();
        if(body.method==='mpesa_sandbox'){endpoint='/payments/mpesa/stk-push';delete body.method;delete body.receivedDate;delete body.reference;}
        else delete body.phone;
      }
      const result=await api(endpoint,{method:'POST',body,headers});
      if(kind==='payment'&&result.status==='pending')toast('STK Push requested. The payment stays pending until Daraja confirms it.');
      else if(kind==='payment')toast(result.unallocatedCents>0?`Payment recorded; ${money(result.unallocatedCents)} remains unallocated.`:'Payment recorded and allocated.');
      else if(kind==='expense')toast(result.status==='pending_approval'?'Expense saved for owner approval.':'Expense saved.');
      else if(kind==='lease')toast('Lease saved. Generate this month’s invoice from Rent & invoices.');
      else toast('Record saved.');
    }
    form.closest('dialog')?.close(); state.search='';state.offsets[state.view]=0; renderView();
  }catch(error){toast(error.message,'error');if(submit){submit.disabled=false;submit.textContent='Save record';}}
}

async function submitTenantProfile(form){
  try{await api('/tenant/profile',{method:'PATCH',body:formData(form)});toast('Contact details saved.');renderTenantPortal();}
  catch(error){toast(error.message,'error');}
}

async function submitTenantMaintenance(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Sending…';
  try{await api('/tenant/maintenance',{method:'POST',body:formData(form)});form.closest('dialog')?.close();toast('Maintenance request sent.');renderTenantPortal();}
  catch(error){button.disabled=false;button.textContent='Send request';toast(error.message,'error');}
}

async function submitDeposit(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Saving…';const leaseId=form.dataset.leaseId;
  try{await api(`/leases/${leaseId}/deposits`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:formData(form)});form.closest('dialog')?.close();toast('Deposit ledger updated.');await openDepositLedger(leaseId);}
  catch(error){button.disabled=false;button.textContent='Save deposit entry';toast(error.message,'error');}
}

async function submitLeaseAmendment(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Saving…';
  try{const result=await api(`/leases/${form.dataset.leaseId}`,{method:'PATCH',body:formData(form)});form.closest('dialog')?.close();toast(`${result.changedFields.length} lease term${result.changedFields.length===1?'':'s'} amended.`);renderView();}
  catch(error){button.disabled=false;button.textContent='Save amendment';toast(error.message,'error');}
}

async function submitLeaseEnd(form){
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Ending lease…';
  try{await api(`/leases/${form.dataset.leaseId}/end`,{method:'POST',body:formData(form)});form.closest('dialog')?.close();toast('Lease ended and unit released.');renderView();}
  catch(error){button.disabled=false;button.textContent='End lease';toast(error.message,'error');}
}

function downloadCsv() {
  if(!state.data.length)return;
  const fields=Object.keys(state.data[0]).filter(key=>!['organization_id','password_hash','metadata_json'].includes(key));
  const csvCell=value=>{let cell=String(value??'').replaceAll('"','""');if(/^[=+@\-\t\r]/.test(cell))cell=`'${cell}`;return `"${cell}"`;};
  const csv=[fields.map(csvCell).join(','),...state.data.map(row=>fields.map(key=>csvCell(row[key])).join(','))].join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}); const link=document.createElement('a');
  link.href=URL.createObjectURL(blob);link.download=`makazi-${state.view}-${today}.csv`;link.click();URL.revokeObjectURL(link.href);
  api('/exports',{method:'POST',body:{resource:state.view,rows:state.data.length}}).catch(()=>{});
  toast('Current page exported to CSV.');
}

async function doAction(action, el) {
  if(action==='navigate') {state.view=el.dataset.view;state.search='';state.offsets[state.view]=state.offsets[state.view]||0;closeMobileNav();renderView();return;}
  if(action==='menu'){document.querySelector('#sidebar')?.classList.add('open');document.querySelector('#mobile-shade')?.classList.add('show');return;}
  if(action==='refresh'){renderView();return;}
  if(action==='logout'){await api('/auth/logout',{method:'POST',body:{}});state.session=null;authScreen();return;}
  if(action==='auth-switch'){authScreen(el.dataset.mode);return;}
  if(action==='close-dialog'){document.querySelector('#workspace-dialog')?.close();return;}
  if(action==='add-property'){await openForm('property');return;}
  if(action==='add-unit'){await openForm('unit');return;}
  if(action==='add-tenant'){await openForm('tenant');return;}
  if(action==='add-lease'){await openForm('lease');return;}
  if(action==='add-payment'){await openForm('payment');return;}
  if(action==='add-expense'){await openForm('expense');return;}
  if(action==='add-maintenance'){await openForm('maintenance');return;}
  if(action==='add-staff'){await openStaffInvite();return;}
  if(action==='tenant-maintenance'){await openTenantMaintenance();return;}
  if(action==='caretaker-maintenance'){await openCaretakerMaintenance();return;}
  if(action==='invite-tenant'){await openTenantInvite(el.dataset.id);return;}
  if(action==='deposit-ledger'){await openDepositLedger(el.dataset.id);return;}
  if(action==='amend-lease'){openLeaseAmendment(el.dataset.id);return;}
  if(action==='end-lease'){openLeaseEnd(el.dataset.id);return;}
  if(action==='copy-invite'){
    const input=document.querySelector('#inviteLink');
    try{await navigator.clipboard.writeText(input.value);toast('Invite link copied.');}
    catch{input.select();toast('Select and copy the link.','error');}
    return;
  }
  if(action==='generate-invoices'){
    try{const result=await api('/billing/generate',{method:'POST',body:{period:today.slice(0,7)}});toast(`${result.created} invoice${result.created===1?'':'s'} generated; ${result.skipped} already existed.`);state.offsets.invoices=0;renderView();}catch(error){toast(error.message,'error');}return;
  }
  if(action==='approve-expense'){
    try{await api(`/expenses/${el.dataset.id}/approval`,{method:'PATCH',body:{status:el.dataset.status}});toast(`Expense ${el.dataset.status}.`);renderView();}catch(error){toast(error.message,'error');}return;
  }
  if(action==='page-next'||action==='page-prev'){
    const current=state.offsets[state.view]||0;const limit=state.page?.limit||12;
    state.offsets[state.view]=Math.max(0,current+(action==='page-next'?limit:-limit));renderView();return;
  }
  if(action==='export'){downloadCsv();return;}
}

function closeMobileNav(){document.querySelector('#sidebar')?.classList.remove('open');document.querySelector('#mobile-shade')?.classList.remove('show');}

document.addEventListener('click',event=>{
  const action=event.target.closest('[data-action]'); if(action){event.preventDefault();doAction(action.dataset.action,action).catch(error=>toast(error.message,'error'));}
  if(event.target.id==='mobile-shade')closeMobileNav();
});
document.addEventListener('submit',event=>{
  const form=event.target;
  if(form.id==='auth-form'){event.preventDefault();submitAuth(form).catch(error=>{const node=form.querySelector('.auth-error');if(node)node.textContent=error.message;});}
  else if(form.id==='record-form'||form.id==='settings-form'){event.preventDefault();if(form.id==='settings-form')form.dataset.kind='settings';submitForm(form);}
  else if(form.id==='accept-invite-form'){event.preventDefault();submitInvitation(form);}
  else if(form.id==='tenant-profile-form'){event.preventDefault();submitTenantProfile(form);}
  else if(form.id==='tenant-maintenance-form'){event.preventDefault();submitTenantMaintenance(form);}
  else if(form.id==='staff-invite-form'){event.preventDefault();submitStaffInvite(form);}
  else if(form.id==='accept-staff-invite-form'){event.preventDefault();submitStaffInvitation(form);}
  else if(form.id==='caretaker-maintenance-form'){event.preventDefault();submitCaretakerMaintenance(form);}
  else if(form.id==='deposit-form'){event.preventDefault();submitDeposit(form);}
  else if(form.id==='lease-amend-form'){event.preventDefault();submitLeaseAmendment(form);}
  else if(form.id==='lease-end-form'){event.preventDefault();submitLeaseEnd(form);}
});
document.addEventListener('input',event=>{
  if(event.target.id==='table-search'){
    state.search=event.target.value.trim();state.offsets[state.view]=0;
    window.clearTimeout(window.__makaziSearchTimer);window.__makaziSearchTimer=window.setTimeout(renderView,220);
  }
});
document.addEventListener('change',event=>{
  if(event.target.id==='method'){
    const phone=event.target.form?.elements.phone;
    if(phone)phone.required=event.target.value==='mpesa_sandbox';
    return;
  }
  const select=event.target.closest('[data-ticket-status]');if(!select)return;
  const endpoint=state.session?.role==='caretaker'?`/caretaker/maintenance/${select.dataset.ticketStatus}`:`/maintenance/${select.dataset.ticketStatus}`;
  api(endpoint,{method:'PATCH',body:{status:select.value}}).then(()=>toast('Request status updated.')).catch(error=>{toast(error.message,'error');state.session?.role==='caretaker'?renderCaretakerPortal():renderView();});
});

async function submitAuth(form) {
  const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Please wait…';
  const body=formData(form);const mode=form.dataset.mode;
  try{
    const result=await api(`/auth/${mode==='register'?'register':'login'}`,{method:'POST',body});
    state.session={...result,organization:{...result.organization},user:{...result.user}};state.view='dashboard';state.offsets={};
    if(result.role==='tenant')await tenantShell();else if(result.role==='caretaker')await caretakerShell();else shell();
  }catch(error){button.disabled=false;button.textContent=mode==='register'?'Create workspace':'Sign in →';const node=form.querySelector('.auth-error');if(node)node.textContent=error.message;}
}

async function boot(){
  if(window.location.pathname==='/invite'){
    const token=new URLSearchParams(window.location.search).get('token')||'';
    acceptInvitationScreen(token,token?'':'This invitation link is missing its token.');return;
  }
  if(window.location.pathname==='/staff-invite'){
    const token=new URLSearchParams(window.location.search).get('token')||'';
    acceptStaffInvitationScreen(token,token?'':'This invitation link is missing its token.');return;
  }
  try{state.session=await api('/session');if(state.session.role==='tenant')await tenantShell();else if(state.session.role==='caretaker')await caretakerShell();else shell();}
  catch{authScreen('login');}
}
boot();
