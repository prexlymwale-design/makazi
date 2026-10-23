import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root=process.env.MAKAZI_ROOT||process.env.LAMBDA_TASK_ROOT||resolve(dirname(fileURLToPath(import.meta.url)),'..');
const transactionContext=new AsyncLocalStorage();
const databaseUrl=process.env.MAKAZI_DATABASE_URL||process.env.SUPABASE_DATABASE_URL||process.env.NETLIFY_DB_URL||process.env.NETLIFY_DATABASE_URL;
const usePostgres=Boolean(databaseUrl);
let sqlite;
let pool;
let sqliteQueue=Promise.resolve();
let savepointSequence=0;

function sqliteMigrations(){
  const dbPath=resolve(root,process.env.DB_PATH||'./data/makazi.sqlite');
  mkdirSync(dirname(dbPath),{recursive:true});
  sqlite=new DatabaseSync(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  for(const migration of readdirSync(resolve(root,'migrations')).filter((name)=>name.endsWith('.sql')).sort()){
    if(sqlite.prepare('SELECT version FROM schema_migrations WHERE version=?').get(migration))continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try{
      sqlite.exec(readFileSync(resolve(root,'migrations',migration),'utf8'));
      sqlite.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(migration);
      sqlite.exec('COMMIT');
    }catch(error){sqlite.exec('ROLLBACK');throw error;}
  }
}

function postgresSql(sql){
  let index=0;
  return sql
    .replace(/strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/gi,'makazi_now()')
    .replace(/\s+COLLATE NOCASE\b/gi,'')
    .replace(/\?/g,()=>`$${++index}`);
}

async function initializePostgres(){
  if(databaseUrl==='pglite:memory'&&process.env.NODE_ENV==='test'){
    const {PGlite}=await import('@electric-sql/pglite');
    const embedded=await PGlite.create();
    await embedded.exec(`CREATE ROLE makazi_runtime_test LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT CREATE, USAGE ON SCHEMA public TO makazi_runtime_test;
      SET ROLE makazi_runtime_test;`);
    const query=async(sql,parameters=[])=>{
      if(!parameters.length&&sql.includes(';')){
        const results=await embedded.exec(sql);
        return results.at(-1)||{rows:[],rowCount:0};
      }
      return embedded.query(sql,parameters);
    };
    pool={connect:async()=>({query,release(){}}),query,end:()=>embedded.close()};
  }else{
    const {Pool,types}=await import('pg');
    types.setTypeParser(20,(value)=>Number(value));
    types.setTypeParser(1700,(value)=>Number(value));
    const schema=process.env.MAKAZI_PG_SCHEMA;
    if(schema&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))throw new Error('MAKAZI_PG_SCHEMA must be a simple PostgreSQL identifier.');
    let connectionString=databaseUrl;
    try{
      const parsed=new URL(databaseUrl);
      const isSupabase=parsed.hostname.endsWith('.supabase.co')||parsed.hostname.endsWith('.supabase.com');
      if(isSupabase&&!parsed.searchParams.has('sslmode')&&!parsed.searchParams.has('ssl')){
        parsed.searchParams.set('sslmode','require');
        connectionString=parsed.toString();
      }
    }catch{}
    const serverless=Boolean(process.env.LAMBDA_TASK_ROOT||process.env.NETLIFY);
    const defaultPoolMax=serverless?1:10;
    pool=new Pool({connectionString,max:Math.max(1,Math.min(50,Number(process.env.PG_POOL_MAX||defaultPoolMax))),application_name:'makazi',...(schema?{options:`-c search_path=${schema},public`}:{})});
  }
  const client=await pool.connect();
  try{
    if(process.env.NODE_ENV==='production'){
      const role=(await client.query('SELECT current_user AS role_name, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user')).rows[0];
      if(!role||role.rolsuper||role.rolbypassrls)throw new Error('Production requires a dedicated PostgreSQL role with NOBYPASSRLS and NOSUPERUSER so row-level security remains active.');
    }
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text))');
    const migrationDir=resolve(root,'migrations','postgres');
    for(const migration of readdirSync(migrationDir).filter((name)=>name.endsWith('.sql')).sort()){
      const alreadyApplied=await client.query('SELECT version FROM schema_migrations WHERE version=$1',[migration]);
      if(alreadyApplied.rowCount)continue;
      await client.query('BEGIN');
      try{
        await client.query(readFileSync(resolve(migrationDir,migration),'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT (version) DO NOTHING',[migration]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
    }
  }finally{client.release();}
}

if(process.env.NODE_ENV==='production'&&!usePostgres)throw new Error('Production requires a PostgreSQL URL in MAKAZI_DATABASE_URL, SUPABASE_DATABASE_URL, or a Netlify Database variable.');
if(usePostgres)await initializePostgres();
else sqliteMigrations();

function currentClient(){return transactionContext.getStore()?.client||null;}

function queryPostgres(sql,parameters,mode){
  const statement=postgresSql(sql);
  const client=currentClient();
  const query=client?client.query(statement,parameters):pool.query(statement,parameters);
  return query.then((result)=>{
    const numericFields=new Set((result.fields||[]).filter((field)=>[20,1700].includes(Number(field.dataTypeID))).map((field)=>field.name));
    const rows=(result.rows||[]).map((row)=>{
      if(!numericFields.size)return row;
      const normalized={...row};
      for(const field of numericFields){
        if(normalized[field]===null||normalized[field]===undefined)continue;
        const value=Number(normalized[field]);
        if(!Number.isFinite(value))throw new Error(`PostgreSQL returned a non-finite numeric value for ${field}.`);
        normalized[field]=value;
      }
      return normalized;
    });
    if(mode==='get')return rows[0];
    if(mode==='all')return rows;
    return {changes:result.rowCount||0};
  });
}

export const db={
  prepare(sql){
    if(usePostgres)return {
      get(...parameters){return queryPostgres(sql,parameters,'get');},
      all(...parameters){return queryPostgres(sql,parameters,'all');},
      run(...parameters){return queryPostgres(sql,parameters,'run');}
    };
    const statement=sqlite.prepare(sql);
    return {
      get(...parameters){return statement.get(...parameters);},
      all(...parameters){return statement.all(...parameters);},
      run(...parameters){return statement.run(...parameters);}
    };
  },
  async exec(sql){
    if(!usePostgres)return sqlite.exec(sql);
    const client=currentClient();
    return client?client.query(sql):pool.query(sql);
  },
  async close(){
    if(usePostgres)return pool.end();
    return sqlite.close();
  }
};

async function nestedTransaction(callback,context,organizationId,userId,authenticationLookup){
  const savepoint=`makazi_sp_${++savepointSequence}`;
  if(usePostgres){
    await context.client.query(`SAVEPOINT ${savepoint}`);
    if(organizationId)await context.client.query("SELECT set_config('makazi.organization_id',$1,true)",[organizationId]);
    if(userId)await context.client.query("SELECT set_config('makazi.user_id',$1,true)",[userId]);
    if(authenticationLookup)await context.client.query("SELECT set_config('makazi.authentication_lookup','true',true)");
  }else sqlite.exec(`SAVEPOINT ${savepoint}`);
  try{
    const result=await callback();
    if(usePostgres)await context.client.query(`RELEASE SAVEPOINT ${savepoint}`);
    else sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  }catch(error){
    if(usePostgres){await context.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);await context.client.query(`RELEASE SAVEPOINT ${savepoint}`);}
    else{sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);}
    throw error;
  }
}

export async function transaction(callback,organizationId=null,userId=null,authenticationLookup=false){
  const active=transactionContext.getStore();
  if(active)return nestedTransaction(callback,active,organizationId,userId,authenticationLookup);
  if(usePostgres){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      if(organizationId)await client.query("SELECT set_config('makazi.organization_id',$1,true)",[organizationId]);
      if(userId)await client.query("SELECT set_config('makazi.user_id',$1,true)",[userId]);
      if(authenticationLookup)await client.query("SELECT set_config('makazi.authentication_lookup','true',true)");
      const result=await transactionContext.run({client},callback);
      await client.query('COMMIT');
      return result;
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  }
  const previous=sqliteQueue;
  let release;
  sqliteQueue=new Promise((resolveQueue)=>{release=resolveQueue;});
  await previous;
  sqlite.exec('BEGIN IMMEDIATE');
  try{
    const result=await transactionContext.run({client:null},callback);
    sqlite.exec('COMMIT');
    return result;
  }catch(error){sqlite.exec('ROLLBACK');throw error;}
  finally{release();}
}

export async function withRequest(organizationId,userId,callback){
  return transaction(callback,organizationId,userId);
}

export async function withAuthLookup(callback){
  if(!usePostgres)return callback();
  const client=currentClient();
  if(!client)return transaction(()=>withAuthLookup(callback),null,null,true);
  const previous=(await client.query("SELECT current_setting('makazi.authentication_lookup',true) AS value")).rows[0]?.value||'';
  await client.query("SELECT set_config('makazi.authentication_lookup','true',true)");
  try{return await callback();}
  finally{await client.query("SELECT set_config('makazi.authentication_lookup',$1,true)",[previous]);}
}

export async function audit({organizationId,actorId,action,entityType,entityId,metadata={}}){
  return transaction(()=>db.prepare(`INSERT INTO audit_logs(id,organization_id,actor_id,action,entity_type,entity_id,metadata_json)
    VALUES(?,?,?,?,?,?,?)`).run(randomUUID(),organizationId,actorId,action,entityType,entityId,JSON.stringify(metadata)),organizationId);
}
