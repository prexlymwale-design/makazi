export function moneyToCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Enter a valid amount.');
  const normalized = String(value).trim().replaceAll(',', '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Enter a valid amount with up to two decimal places.');
  const [whole, decimal = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('Amount is too large.');
  return cents;
}

export function centsToMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('Amount must be an integer number of cents.');
  return (cents / 100).toFixed(2);
}

export function invoiceBalance(totalCents, allocatedCents) {
  if (![totalCents, allocatedCents].every(Number.isSafeInteger) || totalCents < 0 || allocatedCents < 0) {
    throw new Error('Invoice amounts must be non-negative integer cents.');
  }
  return Math.max(0, totalCents - allocatedCents);
}

export function allocatePayment(paymentCents, invoices) {
  if (!Number.isSafeInteger(paymentCents) || paymentCents < 0) throw new Error('Payment must be non-negative integer cents.');
  let remaining = paymentCents;
  const allocations = [];
  for (const invoice of [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))) {
    if (!Number.isSafeInteger(invoice.balanceCents) || invoice.balanceCents < 0) throw new Error('Invoice balance is invalid.');
    if (remaining === 0) break;
    const amountCents = Math.min(remaining, invoice.balanceCents);
    if (amountCents > 0) allocations.push({ invoiceId: invoice.id, amountCents });
    remaining -= amountCents;
  }
  return { allocations, unallocatedCents: remaining };
}

export function prorateRent(monthlyRentCents, startDate, endDate) {
  if (!Number.isSafeInteger(monthlyRentCents) || monthlyRentCents < 0) throw new Error('Rent must be non-negative integer cents.');
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || end < start || start.getUTCMonth() !== end.getUTCMonth() || start.getUTCFullYear() !== end.getUTCFullYear()) {
    throw new Error('Proration dates must be valid and within the same calendar month.');
  }
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const occupiedDays = Math.floor((end - start) / 86400000) + 1;
  return Math.round((monthlyRentCents * occupiedDays) / daysInMonth);
}

export function ageInDays(asOfDate, dueDate) {
  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (!Number.isFinite(asOf.valueOf()) || !Number.isFinite(due.valueOf())) throw new Error('Dates must use YYYY-MM-DD format.');
  return Math.max(0, Math.floor((asOf - due) / 86400000));
}

export function arrearsBucket(days) {
  if (days <= 0) return 'not_overdue';
  if (days <= 30) return '1_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}

export function can(role, action) {
  const permissions = {
    owner: ['read', 'manage_property', 'manage_tenancy', 'manage_finance', 'approve_expense', 'manage_staff', 'manage_settings', 'maintenance_update', 'view_audit'],
    manager: ['read', 'manage_property', 'manage_tenancy', 'manage_finance', 'maintenance_update', 'view_audit'],
    accountant: ['read', 'manage_finance', 'view_audit'],
    caretaker: ['read', 'maintenance_update'],
    tenant: ['read', 'submit_maintenance']
  };
  return Boolean(permissions[role]?.includes(action));
}

export function dueDateForPeriod(period, dueDay) {
  if (!/^\d{4}-\d{2}$/.test(period) || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) throw new Error('Invalid billing period or due day.');
  return `${period}-${String(dueDay).padStart(2, '0')}`;
}
