const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'../cloudflare/smartadm-office-api/worker.js'),'utf8');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-history-')),dbfile=path.join(dir,'db.sqlite');
 function batch(items){
  const py=`import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row\nout=[]\nfor r in json.load(sys.stdin):\n cur=c.execute(r['sql'],r['args']);rows=[dict(x) for x in cur.fetchall()] if cur.description else [];n=c.execute('SELECT changes()').fetchone()[0];out.append({'results':rows,'meta':{'changes':n,'last_row_id':cur.lastrowid}})\nc.commit()\nprint(json.dumps(out))`;
  const result=spawnSync('python3',['-c',py,dbfile],{input:JSON.stringify(items),encoding:'utf8'});
  if(result.status)throw Error(result.stderr);return JSON.parse(result.stdout);
 }
 const query=(sql,args=[])=>batch([{sql,args}])[0];
 const db={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this},async all(){return query(sql,this.args)},async first(){return query(sql,this.args).results[0]||null},async run(){return query(sql,this.args)}}},async batch(items){return batch(items.map(({sql,args})=>({sql,args})))}};
 query(`CREATE TABLE office_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, assigned_to TEXT NOT NULL, customer_name TEXT NOT NULL, salutation TEXT, phones TEXT DEFAULT '[]', branch_id INTEGER, teams INTEGER DEFAULT 0, topics TEXT, briefing TEXT, attempts INTEGER DEFAULT 0, attempt_log TEXT DEFAULT '[]', bad_phones TEXT DEFAULT '[]', status TEXT DEFAULT 'open', protocol TEXT, closed_at TEXT, archived_at TEXT, hold_note TEXT, held_at TEXT, kk_state TEXT, kk_archived_at TEXT, rounds INTEGER DEFAULT 1, round_log TEXT DEFAULT '[]', fk_task_id INTEGER, created_by TEXT DEFAULT 'boss', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
 query('CREATE TABLE employee_profiles(clerk_user_id TEXT PRIMARY KEY)');
 query("INSERT INTO employee_profiles VALUES('employee')");
 query('CREATE TABLE office_members(clerk_user_id TEXT PRIMARY KEY, display_name TEXT, email TEXT)');
 query('CREATE TABLE office_branches(id INTEGER PRIMARY KEY,name TEXT,booking_url TEXT)');
 const ctx=vm.createContext({console,Request,Response,Headers,URL,TextEncoder,TextDecoder,crypto:globalThis.crypto,atob,btoa});
 vm.runInContext(source.replace('export default {','const worker = {')+`;globalThis.t={worker,ensureContactHistory,listContactHistory,deleteCall,finishKkCall,reopenCall,saveCallNote,deletePoolContact,clearPool,takeFromPool,listAdminPool,listAdminCalls};syncFkTask=async()=>{};notifyCalls=async()=>{};notifyUser=async()=>[];verifyClerkToken=async()=>({userId:'employee'});`,ctx);
 const env={DB:db,BOSS_USER_ID:'boss-user'};
 return {t:ctx.t,env,query,ctx,close(){fs.rmSync(dir,{recursive:true,force:true})}};
}
const req=x=>new Request('https://test.invalid',{method:'POST',body:JSON.stringify(x)});
function addCall(f,extra={}){const data={assigned_to:'sasi',customer_name:'Muster, Lena',phones:'["07361 123456"]',protocol:'Erstgespräch: Förderungen besprochen.',...extra};return f.query(`INSERT INTO office_calls (${Object.keys(data).join(',')}) VALUES (${Object.keys(data).map(()=>'?').join(',')})`,Object.values(data)).meta.last_row_id;}

test('initial stock, later notes, archive and reopened attempts remain available; physical deletion is blocked',async()=>{
 const f=fixture();try{
  const id=addCall(f,{attempts:2,attempt_log:'["2026-10-24 10:00:00","2026-10-25 10:00:00"]'});
  await f.t.ensureContactHistory(f.env);await f.t.ensureContactHistory(f.env);
  assert.equal(f.query('SELECT COUNT(*) n FROM office_contact_history').results[0].n,1);
  await f.t.saveCallNote({env:f.env,userId:'sasi',id,request:req({protocol:'Zweitgespräch: Kunde meldet sich.'})});
  assert.equal((await f.t.deleteCall({env:f.env,id})).status,200);
  let c=f.query('SELECT * FROM office_calls WHERE id=?',[id]).results[0];assert.ok(c.archived_at);assert.equal(c.protocol,'Zweitgespräch: Kunde meldet sich.');assert.equal(c.status,'archived');
  await f.t.reopenCall({env:f.env,id});c=f.query('SELECT * FROM office_calls WHERE id=?',[id]).results[0];
  assert.equal(c.attempts,0);assert.equal(JSON.parse(c.attempt_log).length,2);assert.equal(c.rounds,2);
  const h=await (await f.t.listContactHistory({env:f.env,url:new URL('https://test.invalid?source=call&source_id='+id)})).json();
  assert.equal(h.items.length,4);assert.match(h.items[0].contact.protocol,/Erstgespräch/);assert.match(h.items[1].contact.protocol,/Zweitgespräch/);assert.ok(h.items[2].contact.archived_at);
  assert.throws(()=>f.query('DELETE FROM office_calls WHERE id=?',[id]),/Kontakte bleiben im Archiv/);
 }finally{f.close()}
});

test('finishing unreachable contacts keeps the record and full protocol in the customer archive',async()=>{
 const f=fixture();try{
  const id=addCall(f,{status:'R_TA_kK',kk_state:'archived',kk_archived_at:'2026-10-26 09:00:00',attempts:5});await f.t.ensureContactHistory(f.env);
  assert.equal((await f.t.finishKkCall({env:f.env,id})).status,200);
  const a=await (await f.t.listAdminCalls({env:f.env,url:new URL('https://test.invalid?scope=archived')})).json();assert.equal(a.length,1);assert.match(a[0].protocol,/Förderungen/);
  const kk=await (await f.t.listAdminCalls({env:f.env,url:new URL('https://test.invalid?scope=kk')})).json();assert.equal(kk.length,0);
 }finally{f.close()}
});

test('clearing packages archives all rows, excludes them from active packages, and later transfers retain history',async()=>{
 const f=fixture();try{
  await f.t.ensureContactHistory(f.env);
  f.query("INSERT INTO office_call_pool(customer_name,phones,assigned_to)VALUES('Muster, Lena','[\"0123456789\"]','sasi'),('Muster, Tom','[\"0123456789\"]','sasi')");
  await f.t.clearPool({env:f.env,url:new URL('https://test.invalid?assigned_to=sasi')});
  assert.equal(f.query('SELECT COUNT(*) n FROM office_call_pool WHERE archived_at IS NOT NULL').results[0].n,2);
  assert.deepEqual(await (await f.t.listAdminPool({env:f.env})).json(),[]);
  f.query("INSERT INTO office_members VALUES('sasi','Saskia','sasi@example.test')");
  f.query("INSERT INTO office_call_pool(customer_name,phones,assigned_to)VALUES('Andere, Lea','[\"0987654321\"]','sasi')");
  const exec={waitUntil(p){p.catch(()=>{})}};
  const taken=await f.t.takeFromPool({env:f.env,userId:'sasi',request:req({mine:true}),exec});assert.equal(taken.status,200);
  assert.equal(f.query('SELECT COUNT(*) n FROM office_calls').results[0].n,1);
  assert.equal(f.query("SELECT COUNT(*) n FROM office_contact_history WHERE event='removed'").results[0].n,1);
  assert.equal(f.query('SELECT COUNT(*) n FROM office_call_pool').results[0].n,2);
 }finally{f.close()}
});

test('history pagination does not lose old contacts and employees cannot read the admin history endpoint',async()=>{
 const f=fixture();try{
  await f.t.ensureContactHistory(f.env);
  f.query(`INSERT INTO office_calls(assigned_to,customer_name) SELECT 'sasi','Kontakt '||value FROM json_each(?)`,[JSON.stringify(Array.from({length:260},(_,i)=>i))]);
  const page=await (await f.t.listContactHistory({env:f.env,url:new URL('https://test.invalid')})).json();assert.equal(page.items.length,250);assert.ok(page.next);
  const rest=await (await f.t.listContactHistory({env:f.env,url:new URL('https://test.invalid?after='+page.next)})).json();assert.equal(rest.items.length,10);assert.equal(rest.next,null);
  const r=await f.t.worker.fetch(new Request('https://test.invalid/admin/contact-history'),f.env,{waitUntil(p){p.catch(()=>{})}});
  // Office membership is checked before admin access; supply approved profile.
  assert.equal(r.status,403);
 }finally{f.close()}
});
