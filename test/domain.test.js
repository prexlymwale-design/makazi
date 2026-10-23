import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyToCents, centsToMoney, invoiceBalance, allocatePayment, prorateRent, ageInDays, arrearsBucket, can, dueDateForPeriod } from '../src/domain.js';
import { normalizeKenyanPhone, parseDarajaCallback, resolveVerifiedCallback } from '../src/providers/daraja.js';

test('money conversion keeps KES values in integer cents',()=>{
  assert.equal(moneyToCents('1,250.50'),125050);
  assert.equal(centsToMoney(125050),'1250.50');
  assert.throws(()=>moneyToCents('12.345'));
  assert.throws(()=>moneyToCents(-1));
});

test('invoice balance and payment allocation support partial receipts and overpayment',()=>{
  assert.equal(invoiceBalance(10000,2500),7500);
  const result=allocatePayment(13000,[
    {id:'later',dueDate:'2026-05-10',balanceCents:5000},
    {id:'earlier',dueDate:'2026-05-01',balanceCents:6000}
  ]);
  assert.deepEqual(result.allocations,[{invoiceId:'earlier',amountCents:6000},{invoiceId:'later',amountCents:5000}]);
  assert.equal(result.unallocatedCents,2000);
});

test('rent proration uses calendar days and rounds to the nearest cent',()=>{
  assert.equal(prorateRent(300000,'2026-04-16','2026-04-30'),150000);
  assert.equal(prorateRent(310000,'2026-01-31','2026-01-31'),10000);
  assert.throws(()=>prorateRent(10000,'2026-01-31','2026-02-01'));
});

test('arrears buckets and due dates have inclusive boundaries',()=>{
  assert.equal(ageInDays('2026-05-31','2026-05-01'),30);
  assert.equal(arrearsBucket(0),'not_overdue');
  assert.equal(arrearsBucket(30),'1_30');
  assert.equal(arrearsBucket(60),'31_60');
  assert.equal(arrearsBucket(90),'61_90');
  assert.equal(arrearsBucket(91),'90_plus');
  assert.equal(dueDateForPeriod('2026-02',28),'2026-02-28');
});

test('permissions are role-specific and M-Pesa phone values normalize safely',()=>{
  assert.equal(can('accountant','manage_finance'),true);
  assert.equal(can('accountant','manage_property'),false);
  assert.equal(can('caretaker','manage_finance'),false);
  assert.equal(normalizeKenyanPhone('0712 345 678'),'254712345678');
  assert.equal(normalizeKenyanPhone('+254 112 345 678'),'254112345678');
  assert.throws(()=>normalizeKenyanPhone('12345'));
});

test('M-Pesa callbacks require server verification, matching amount, phone, and receipt',()=>{
  const callback=parseDarajaCallback({Body:{stkCallback:{MerchantRequestID:'m1',CheckoutRequestID:'c1',ResultCode:0,CallbackMetadata:{Item:[{Name:'Amount',Value:2500},{Name:'MpesaReceiptNumber',Value:'QAZ12WSX34'},{Name:'PhoneNumber',Value:254712345678}]}}}});
  assert.deepEqual(callback,{checkoutRequestId:'c1',merchantRequestId:'m1',resultCode:'0',amountCents:250000,receiptNumber:'QAZ12WSX34',phoneNumber:'254712345678'});
  const transaction={amountCents:250000};
  assert.equal(resolveVerifiedCallback(callback,transaction,{verified:false,successful:false}).status,'pending');
  assert.equal(resolveVerifiedCallback(callback,transaction,{verified:true,successful:true}).status,'confirmed');
  assert.equal(resolveVerifiedCallback({...callback,amountCents:100},transaction,{verified:true,successful:true}).status,'pending');
  assert.equal(resolveVerifiedCallback({...callback,resultCode:'1032'},transaction,{verified:true,successful:false}).status,'failed');
});
