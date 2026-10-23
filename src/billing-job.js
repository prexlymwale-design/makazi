import { randomUUID } from 'node:crypto';
import { db, transaction, audit } from './db.js';
import { dueDateForPeriod } from './domain.js';

const periodArg=process.argv.find((arg)=>arg.startsWith('--month='))?.split('=')[1];
const period=periodArg||new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi'}).format(new Date()).slice(0,7);
if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)){console.error('Use --month=YYYY-MM.');process.exit(1);}
const first=`${period}-01`;
const last=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);

async function main(){
  let created=0,leasesCount=0;
  const organizations=await db.prepare("SELECT id FROM organizations WHERE status='active'").all();
  for(const organization of organizations){
    await transaction(async()=>{
      const leases=await db.prepare(`SELECT l.id,l.organization_id,l.tenant_id,l.unit_id,l.monthly_rent_cents,l.due_day,u.unit_number,p.name AS property_name
        FROM leases l JOIN units u ON u.id=l.unit_id AND u.organization_id=l.organization_id JOIN properties p ON p.id=u.property_id AND p.organization_id=u.organization_id
        WHERE l.organization_id=? AND l.status='active' AND l.start_date<=? AND (l.end_date IS NULL OR l.end_date>=?)`).all(organization.id,last,first);
      leasesCount+=leases.length;
      for(const lease of leases){
        if(await db.prepare('SELECT id FROM invoices WHERE lease_id=? AND period=? AND organization_id=?').get(lease.id,period,lease.organization_id))continue;
        const id=randomUUID();const number=`MKZ-${period.replace('-','')}-${id.slice(0,8).toUpperCase()}`;
        await db.prepare(`INSERT INTO invoices(id,organization_id,lease_id,tenant_id,unit_id,period,invoice_number,issue_date,due_date,total_cents)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,lease.organization_id,lease.id,lease.tenant_id,lease.unit_id,period,number,first,dueDateForPeriod(period,lease.due_day),lease.monthly_rent_cents);
        await db.prepare('INSERT INTO invoice_lines(id,organization_id,invoice_id,description,amount_cents) VALUES(?,?,?,?,?)').run(randomUUID(),lease.organization_id,id,`Rent — ${lease.property_name} / ${lease.unit_number}`,lease.monthly_rent_cents);
        const owner=await db.prepare("SELECT user_id FROM organization_memberships WHERE organization_id=? AND role='owner' LIMIT 1").get(lease.organization_id);
        await audit({organizationId:lease.organization_id,actorId:owner?.user_id,action:'invoice.generated.job',entityType:'invoice',entityId:id,metadata:{period,leaseId:lease.id}});
        created++;
      }
    },organization.id);
  }
  console.log(JSON.stringify({period,leases:leasesCount,created,skipped:leasesCount-created}));
}

try{await main();}
finally{await db.close();}
