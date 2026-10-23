import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sqliteMigrationDir=resolve(projectRoot,'migrations');
const postgresMigrationDir=resolve(sqliteMigrationDir,'postgres');
const tableOrder=[
  'subscription_plans','organizations','users','organization_memberships','sessions',
  'properties','units','tenants','leases','invoices','invoice_lines','payments',
  'payment_allocations','expenses','maintenance_tickets','audit_logs','mpesa_transactions',
  'tenant_users','invitations','lease_revisions','deposit_transactions','staff_invitations',
  'staff_invitation_properties','staff_property_assignments'
];

function migrationVersions(directory){
  return readdirSync(directory).filter((name)=>name.endsWith('.sql')).sort();
}

function assertMigrationsApplied(client,versions,label){
  return client.query('SELECT version FROM schema_migrations').catch((error)=>{
    if(error.code==='42P01')throw new Error(`${label} database has no migration history. Start Makazi against PostgreSQL once to apply its migrations before importing.`);
    throw error;
  }).then(({rows})=>{
    const applied=new Set(rows.map((row)=>row.version));
    const missing=versions.filter((version)=>!applied.has(version));
    assert.equal(missing.length,0,`${label} database must have all migrations applied first. Missing: ${missing.join(', ')}`);
  });
}

function quoteIdentifier(identifier){
  if(!/^[a-z_][a-z0-9_]*$/.test(identifier))throw new Error(`Unexpected database identifier: ${identifier}`);
  return `"${identifier}"`;
}

export async function importSqliteToPostgres(sourcePath,targetClient){
  if(!existsSync(sourcePath))throw new Error(`SQLite source database was not found: ${sourcePath}`);
  const source=new DatabaseSync(sourcePath);
  let transactionStarted=false;
  try{
    source.exec('PRAGMA query_only=ON');
    const sqliteTables=new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row)=>row.name));
    if(!sqliteTables.has('schema_migrations'))throw new Error('SQLite source has no migration history. Start the app on SQLite before importing it.');
    await assertMigrationsApplied(targetClient,migrationVersions(postgresMigrationDir),'PostgreSQL target');
    const sqliteVersions=source.prepare('SELECT version FROM schema_migrations').all().map((row)=>row.version);
    const missingSqlite=migrationVersions(sqliteMigrationDir).filter((version)=>!sqliteVersions.includes(version));
    if(missingSqlite.length)throw new Error(`SQLite source must be fully migrated first. Missing: ${missingSqlite.join(', ')}`);
    for(const table of tableOrder){
      if(!sqliteTables.has(table))throw new Error(`SQLite source is missing the required table: ${table}`);
    }

    await targetClient.query('BEGIN');
    transactionStarted=true;
    await targetClient.query("SELECT set_config('makazi.authentication_lookup','true',true)");
    const existingOrganizations=Number((await targetClient.query('SELECT COUNT(*) AS count FROM organizations')).rows[0].count);
    if(existingOrganizations>0)throw new Error('PostgreSQL target already contains workspaces. Import only into a fresh PostgreSQL database.');

    const sourceRows=new Map();
    const sourceCounts=new Map();
    for(const table of tableOrder){
      const columns=source.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((column)=>column.name);
      const targetColumns=new Set((await targetClient.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',[table]
      )).rows.map((row)=>row.column_name));
      const missing=columns.filter((column)=>!targetColumns.has(column));
      if(missing.length)throw new Error(`PostgreSQL table ${table} is missing source columns: ${missing.join(', ')}. Update PostgreSQL migrations before importing.`);
      const rows=source.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
      sourceRows.set(table,{columns,rows});
      const perOrganization=new Map();
      for(const row of rows){
        if(row.organization_id)perOrganization.set(row.organization_id,(perOrganization.get(row.organization_id)||0)+1);
      }
      sourceCounts.set(table,perOrganization);
    }

    const imported={};
    for(const table of tableOrder){
      const {columns,rows}=sourceRows.get(table);
      const quotedColumns=columns.map(quoteIdentifier).join(',');
      const placeholders=columns.map((_,index)=>`$${index+1}`).join(',');
      let sql=`INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders})`;
      if(table==='subscription_plans'){
        const updates=columns.filter((column)=>column!=='id').map((column)=>`${quoteIdentifier(column)}=EXCLUDED.${quoteIdentifier(column)}`).join(',');
        sql+=` ON CONFLICT (${quoteIdentifier('id')}) DO UPDATE SET ${updates}`;
      }
      for(const row of rows){
        const organizationId=row.organization_id||(table==='organizations'?row.id:null);
        if(organizationId)await targetClient.query("SELECT set_config('makazi.organization_id',$1,true)",[organizationId]);
        const userId=row.user_id||(table==='users'?row.id:null);
        if(userId)await targetClient.query("SELECT set_config('makazi.user_id',$1,true)",[userId]);
        await targetClient.query(sql,columns.map((column)=>row[column]));
      }
      imported[table]=rows.length;
    }

    const organizationIds=(await targetClient.query('SELECT id FROM organizations ORDER BY id')).rows.map((row)=>row.id);
    for(const table of tableOrder){
      const {columns,rows}=sourceRows.get(table);
      const expectedByOrganization=sourceCounts.get(table);
      if(columns.includes('organization_id')){
        for(const organizationId of organizationIds){
          await targetClient.query("SELECT set_config('makazi.organization_id',$1,true)",[organizationId]);
          const actual=Number((await targetClient.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE organization_id=$1`,[organizationId])).rows[0].count);
          const expected=expectedByOrganization.get(organizationId)||0;
          assert.equal(actual,expected,`Imported row count for ${table} in workspace ${organizationId}`);
        }
      }else if(table!=='subscription_plans'){
        await targetClient.query("SELECT set_config('makazi.authentication_lookup','true',true)");
        const actual=Number((await targetClient.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)).rows[0].count);
        assert.equal(actual,rows.length,`Imported row count for ${table}`);
      }
    }
    await targetClient.query('COMMIT');
    transactionStarted=false;
    return imported;
  }catch(error){
    if(transactionStarted){try{await targetClient.query('ROLLBACK');}catch{}}
    throw error;
  }finally{
    source.close();
  }
}

async function main(){
  const targetUrl=process.env.MAKAZI_DATABASE_URL||process.env.SUPABASE_DATABASE_URL;
  if(!targetUrl||targetUrl==='pglite:memory')throw new Error('Set MAKAZI_DATABASE_URL or SUPABASE_DATABASE_URL to the fresh PostgreSQL target database first.');
  const sourceArg=process.argv.slice(2).find((argument)=>argument.startsWith('--source='));
  const sourcePath=resolve(sourceArg?sourceArg.slice('--source='.length):(process.env.DB_PATH||'./data/makazi.sqlite'));
  let pool,client;
  try{
    const {Pool}=await import('pg');
    const schema=process.env.MAKAZI_PG_SCHEMA;
    if(schema&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))throw new Error('MAKAZI_PG_SCHEMA must be a simple PostgreSQL identifier.');
    let connectionString=targetUrl;
    try{
      const parsed=new URL(targetUrl);
      const isSupabase=parsed.hostname.endsWith('.supabase.co')||parsed.hostname.endsWith('.supabase.com');
      if(isSupabase&&!parsed.searchParams.has('sslmode')&&!parsed.searchParams.has('ssl')){
        parsed.searchParams.set('sslmode','require');
        connectionString=parsed.toString();
      }
    }catch{}
    pool=new Pool({connectionString,max:1,application_name:'makazi_import',...(schema?{options:`-c search_path=${schema},public`}:{})});
    client=await pool.connect();
    const counts=await importSqliteToPostgres(sourcePath,client);
    console.log(`Imported ${counts.organizations||0} workspace(s) from SQLite into PostgreSQL.`);
    console.log(JSON.stringify(counts,null,2));
  }finally{
    client?.release();
    await pool?.end();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch((error)=>{console.error(`SQLite import failed: ${error.message}`);process.exitCode=1;});
}
