import { Buffer } from 'node:buffer';

export class ProviderUnavailableError extends Error {
  constructor(message = 'Daraja sandbox is not configured.') { super(message); this.code = 'provider_unavailable'; }
}

function settings(env) {
  const required=['DARAJA_CONSUMER_KEY','DARAJA_CONSUMER_SECRET','DARAJA_SHORTCODE','DARAJA_PASSKEY','DARAJA_CALLBACK_URL'];
  if(env.DARAJA_ENVIRONMENT!=='sandbox'||required.some(key=>!env[key]))throw new ProviderUnavailableError();
  let callback;
  try{callback=new URL(env.DARAJA_CALLBACK_URL);}catch{throw new ProviderUnavailableError('Configure a valid public HTTPS callback URL for Daraja.');}
  if(callback.protocol!=='https:')throw new ProviderUnavailableError('The Daraja callback URL must use HTTPS.');
  return {base:'https://sandbox.safaricom.co.ke',key:env.DARAJA_CONSUMER_KEY,secret:env.DARAJA_CONSUMER_SECRET,shortcode:env.DARAJA_SHORTCODE,passkey:env.DARAJA_PASSKEY,callbackUrl:callback.toString()};
}

function timestamp() {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

export function normalizeKenyanPhone(value) {
  const digits=String(value||'').replace(/\D/g,'');
  if(/^0[17]\d{8}$/.test(digits))return `254${digits.slice(1)}`;
  if(/^254[17]\d{8}$/.test(digits))return digits;
  throw new Error('Enter a Kenyan mobile number beginning 07, 01, +2547, or +2541.');
}

export class DarajaSandboxProvider {
  constructor({env=process.env,fetchImpl=fetch}={}){this.config=settings(env);this.fetch=fetchImpl;}

  async accessToken(){
    const authorization=Buffer.from(`${this.config.key}:${this.config.secret}`).toString('base64');
    let response;
    try{response=await this.fetch(`${this.config.base}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${authorization}`},signal:AbortSignal.timeout(12000)});}catch{throw new ProviderUnavailableError('Daraja could not be reached. Retry the request later.');}
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||!payload.access_token)throw new ProviderUnavailableError('Daraja authorization failed. Check the sandbox configuration.');
    return payload.access_token;
  }

  async post(path,payload){
    const token=await this.accessToken();
    let response;
    try{response=await this.fetch(`${this.config.base}${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});}catch{throw new ProviderUnavailableError('Daraja could not be reached. Retry the request later.');}
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new ProviderUnavailableError(result.errorMessage||'Daraja rejected the request.');
    return result;
  }

  async initiate({phone,amountKes,accountReference,description='Rent payment'}){
    const msisdn=normalizeKenyanPhone(phone);const timestampValue=timestamp();
    const password=Buffer.from(`${this.config.shortcode}${this.config.passkey}${timestampValue}`).toString('base64');
    const payload=await this.post('/mpesa/stkpush/v1/processrequest',{
      BusinessShortCode:this.config.shortcode,Password:password,Timestamp:timestampValue,TransactionType:'CustomerPayBillOnline',
      Amount:Math.max(1,Math.ceil(amountKes)),PartyA:msisdn,PartyB:this.config.shortcode,PhoneNumber:msisdn,
      CallBackURL:this.config.callbackUrl,AccountReference:String(accountReference).slice(0,12),TransactionDesc:String(description).slice(0,13)
    });
    if(String(payload.ResponseCode)!=='0'||!payload.CheckoutRequestID)throw new ProviderUnavailableError(payload.ResponseDescription||'Daraja did not accept the payment request.');
    return {merchantRequestId:String(payload.MerchantRequestID||''),checkoutRequestId:String(payload.CheckoutRequestID),customerMessage:String(payload.CustomerMessage||'Payment request sent.')};
  }

  async verify(callback){
    const timestampValue=timestamp();
    const password=Buffer.from(`${this.config.shortcode}${this.config.passkey}${timestampValue}`).toString('base64');
    const result=await this.post('/mpesa/stkpushquery/v1/query',{
      BusinessShortCode:this.config.shortcode,Password:password,Timestamp:timestampValue,CheckoutRequestID:callback.checkoutRequestId
    });
    if(String(result.ResponseCode)!=='0')return {verified:false,successful:false};
    return {verified:true,successful:String(result.ResultCode)==='0'};
  }
}

export function parseDarajaCallback(payload){
  const callback=payload?.Body?.stkCallback;
  if(!callback||typeof callback!=='object'||!callback.CheckoutRequestID)return null;
  const items=Array.isArray(callback.CallbackMetadata?.Item)?callback.CallbackMetadata.Item:[];
  const meta=Object.fromEntries(items.filter(item=>item&&typeof item.Name==='string').map(item=>[item.Name,item.Value]));
  const amountNumber=Number(meta.Amount);
  return {
    checkoutRequestId:String(callback.CheckoutRequestID),
    merchantRequestId:String(callback.MerchantRequestID||''),
    resultCode:String(callback.ResultCode??''),
    amountCents:Number.isSafeInteger(Math.round(amountNumber*100))?Math.round(amountNumber*100):null,
    receiptNumber:typeof meta.MpesaReceiptNumber==='string'?meta.MpesaReceiptNumber:'',
    phoneNumber:meta.PhoneNumber===undefined?'':String(meta.PhoneNumber)
  };
}

export function resolveVerifiedCallback(callback,transaction,verification){
  if(!callback||!transaction)throw new Error('Callback could not be correlated to a payment request.');
  if(!verification?.verified)return {status:'pending',receiptNumber:''};
  if(verification.successful&&callback.resultCode==='0'&&callback.amountCents===transaction.amountCents&&/^[A-Z0-9]{8,16}$/.test(callback.receiptNumber)){
    return {status:'confirmed',receiptNumber:callback.receiptNumber};
  }
  if(!verification.successful&&callback.resultCode!=='0')return {status:'failed',receiptNumber:''};
  return {status:'pending',receiptNumber:''};
}
