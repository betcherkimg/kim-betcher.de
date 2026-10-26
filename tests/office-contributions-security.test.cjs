const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../cloudflare/smartadm-office-api/worker.js'),'utf8');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE payroll_settings(clerk_user_id TEXT PRIMARY KEY,employee_rv INTEGER,rv_min_base_applies INTEGER,flat_tax INTEGER,flat_tax_employee INTEGER,employer_kv INTEGER,employer_rv INTEGER,u1 INTEGER,u2 INTEGER,insolvency INTEGER,accident INTEGER,accident_rate REAL,accident_rate_estimate REAL,updated_at TEXT);
 CREATE TABLE employee_profiles(clerk_user_id TEXT PRIMARY KEY,start_date TEXT,end_date TEXT);
 CREATE TABLE monthly_closings(id INTEGER PRIMARY KEY,clerk_user_id TEXT,payroll_month TEXT,gross_cents INTEGER,snapshot_json TEXT);
 CREATE TABLE office_members(clerk_user_id TEXT PRIMARY KEY,email TEXT);
 CREATE TABLE office_tasks(id INTEGER PRIMARY KEY,assigned_to TEXT,created_by TEXT,title TEXT,description TEXT,priority TEXT,status TEXT,completed_at TEXT);
 INSERT INTO payroll_settings VALUES('sasi',0,1,1,0,1,1,1,1,1,0,0,0,NULL);
 INSERT INTO employee_profiles VALUES('sasi','2026-01-01',NULL);
 INSERT INTO office_members VALUES('sasi','sasi@example.test');`);
 const DB={prepare(sql){
  let args=[];
  return {
   bind(...a){args=a;return this},
   async first(){return db.prepare(sql).get(...args)||null},
   async all(){return {results:db.prepare(sql).all(...args)}},
   async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}
  };
 }};
 const pushes=[],pending=[];
 class Clock extends Date{constructor(...a){super(...(a.length?a:['2026-10-23T09:00:00Z']))}static now(){return Date.parse('2026-10-23T09:00:00Z')}}
 const context=vm.createContext({console:{error(){},warn(){}},Request,Response,Headers,URL,Date:Clock,Intl,TextEncoder,TextDecoder,crypto:webcrypto,atob,btoa,AbortSignal});
 vm.runInContext(source.replace('export default {','const worker={')+`;globalThis.t={worker,calculateMinijobContributions,contributionFields,contributionProfile,upsertContributionReport,updateContributionReport,previousContributionFields,ensureContributionReports,submissionConfirmed,validPushEndpoint,officeAllowed,securityCheckResult,monitorSecurity,verifyClerkToken,documentResponse,listOwnDocuments};notifyUser=async(env,id,message)=>{globalThis.pushes.push({id,...message});return [{status:201}]};`,context);
 context.pushes=pushes;
 const env={DB,BOSS_USER_ID:'boss'};
 const request=data=>new Request('https://api.test/admin/contribution-reports',{method:'PUT',body:JSON.stringify(data)});
 const save=data=>context.t.upsertContributionReport({env,userId:'boss',owner:'sasi',request:request({month:'2026-10',estimated_gross_cents:50000,...data})});
 return {db,t:context.t,env,context,pushes,save,request,pending,exec:{waitUntil(p){pending.push(p)}},close:()=>db.close()};
}
const json=r=>r.json();
test('Sasi RV exemption retains employer 15%, rounds each portal field and excludes BG',async()=>{
 const f=fixture();try{
  const p=await f.t.contributionProfile(f.env,'sasi');p.accident=true;p.accidentRate=5;
  const c=f.t.calculateMinijobContributions(50000,p);
  assert.equal(c.rv_employee_cents,0);assert.equal(c.rv_employer_cents,7500);assert.equal(c.total_cents,15585);
  const row=await json(await f.save({status:'draft'}));
  assert.equal(row.status,'draft');assert.equal(row.submitted_at,null);
  assert.equal(row.snapshot.portalFields['0100'],0);assert.equal(row.snapshot.portalFields['0500'],7500);
  assert.equal(Object.values(row.snapshot.portalFields).reduce((a,b)=>a+b,0),row.amount_due_cents);
 }finally{f.close()}
});
test('full RV and pro-rated minimum contribution map to 0100',async()=>{
 const f=fixture();try{
  const p={...await f.t.contributionProfile(f.env,'sasi'),employeeRv:true};
  assert.equal(f.t.calculateMinijobContributions(50000,p).rv_cents,9300);
  assert.equal(f.t.calculateMinijobContributions(5000,p,15).rv_employee_cents,878);
  const fields=f.t.contributionFields(f.t.calculateMinijobContributions(50000,p),p);
  assert.equal(fields['0100'],9300);assert.equal(fields['0500'],0);
 }finally{f.close()}
});
test('submission requires actual date, confirmation, matching reviewed fields; confirmed money stays frozen',async()=>{
 const f=fixture();try{
  const draft=await json(await f.save({status:'draft'}));const fields=draft.snapshot.portalFields;
  for(const data of [
   {status:'submitted'},
   {status:'submitted',submitted_date:'2026-10-23'},
   {status:'submitted',submission_confirmed:true,submitted_date:'2026-10-24',portal_fields:fields},
   {status:'submitted',submission_confirmed:true,submitted_date:'2026-10-23',portal_fields:{}}
  ])assert.ok((await f.save(data)).status>=400);
  let r=await f.save({status:'submitted',submission_confirmed:true,submitted_date:'2026-10-23',portal_fields:fields});assert.equal(r.status,200);
  const confirmed=await json(r);assert.equal(confirmed.status,'submitted');assert.equal(confirmed.snapshot.submissionConfirmation.confirmedBy,'boss');
  assert.equal((await f.save({status:'draft'})).status,409);
  assert.equal((await f.save({status:'submitted',submitted_date:'2026-10-23',estimated_gross_cents:51000})).status,409);
  assert.equal((await f.save({status:'paid',submitted_date:'2026-10-23',paid_date:'2026-10-22'})).status,400);
  f.db.exec('UPDATE payroll_settings SET employee_rv=1');
  const paid=await json(await f.save({status:'paid',submitted_date:'2026-10-23',paid_date:'2026-10-23'}));
  assert.equal(paid.snapshot.portalFields['0500'],7500);assert.equal(paid.snapshot.portalFields['0100'],0);
 }finally{f.close()}
});
test('prior month correction uses finalized snapshot per field, is not applied twice, and never uses a draft',async()=>{
 const f=fixture();try{
  const profile=await f.t.contributionProfile(f.env,'sasi');
  let draft=await json(await f.save({month:'2026-09',status:'draft'}));
  f.db.prepare('INSERT INTO monthly_closings VALUES(1,?,?,?,?)').run('sasi','2026-09',55000,JSON.stringify({profile,payroll:{svDays:30}}));
  assert.deepEqual(JSON.parse(JSON.stringify(await f.t.previousContributionFields(f.env,'sasi','2026-10'))),{});
  await f.save({month:'2026-09',status:'submitted',submission_confirmed:true,submitted_date:'2026-09-23',portal_fields:draft.snapshot.portalFields});
  const correction=await f.t.previousContributionFields(f.env,'sasi','2026-10');
  assert.equal(correction['6000'],650);assert.equal(correction['0500'],750);assert.equal(correction['0100'],0);
  draft=await json(await f.save({status:'draft'}));
  assert.equal(draft.snapshot.portalFields['6000'],7150);assert.equal(draft.snapshot.portalFields['0500'],8250);
  assert.equal(draft.prior_correction_cents,Object.values(correction).reduce((a,b)=>a+b,0));
  f.db.exec('UPDATE payroll_settings SET employee_rv=1');
  assert.equal((await f.t.previousContributionFields(f.env,'sasi','2026-10'))['0500'],750);
 }finally{f.close()}
});
test('open prior month blocks submission; negative correction remains a credit',async()=>{
 const f=fixture();try{
  const profile=await f.t.contributionProfile(f.env,'sasi');
  const d=await json(await f.save({month:'2026-09',status:'draft'}));
  await f.save({month:'2026-09',status:'submitted',submission_confirmed:true,submitted_date:'2026-09-23',portal_fields:d.snapshot.portalFields});
  assert.equal(await f.t.previousContributionFields(f.env,'sasi','2026-10'),null);
  assert.equal((await f.save({status:'submitted',submission_confirmed:true,submitted_date:'2026-10-23',portal_fields:{}})).status,409);
  f.db.prepare('INSERT INTO monthly_closings VALUES(1,?,?,?,?)').run('sasi','2026-09',40000,JSON.stringify({profile,payroll:{svDays:30}}));
  const c=await f.t.previousContributionFields(f.env,'sasi','2026-10');assert.equal(c['0500'],-1500);
 }finally{f.close()}
});
test('a registered login cannot enroll itself in Office and employees cannot access admin reports',async()=>{
 const f=fixture();try{
  assert.equal(await f.t.officeAllowed(f.env,'stranger'),false);
  vm.runInContext("verifyClerkToken=async()=>({userId:'stranger'})",f.context);
  const denied=await f.t.worker.fetch(f.request({display_name:'X'}),f.env,f.exec);assert.equal(denied.status,403);
  vm.runInContext("verifyClerkToken=async()=>({userId:'sasi'})",f.context);
  assert.equal((await f.t.worker.fetch(new Request('https://api.test/admin/contribution-reports'),f.env,f.exec)).status,403);
  assert.equal(await f.t.officeAllowed(f.env,'boss'),true);
  assert.equal(await f.t.officeAllowed(f.env,'sasi'),true);
  await Promise.all(f.pending);
 }finally{f.close()}
});
test('push rejects arbitrary destinations, embedded credentials and redirect targets',()=>{
 const f=fixture();try{
  for(const host of ['fcm.googleapis.com','web.push.apple.com','updates.push.services.mozilla.com','wns2-am3p.notify.windows.com'])assert.equal(f.t.validPushEndpoint('https://'+host+'/push'),true);
  for(const u of ['http://fcm.googleapis.com/a','https://evil.test/a','https://fcm.googleapis.com.evil.test/a','https://user:pass@fcm.googleapis.com/a','https://127.0.0.1/a','https://fcm.googleapis.com:444/a'])assert.equal(f.t.validPushEndpoint(u),false);
 }finally{f.close()}
});
test('monitor alerts only after two failed checks, deduplicates, and records recovery',async()=>{
 const f=fixture();try{
  await f.t.securityCheckResult(f.env,'/index.html',false,'SHA-256 mismatch');assert.equal(f.pushes.length,0);
  await f.t.securityCheckResult(f.env,'/index.html',false,'SHA-256 mismatch');assert.equal(f.pushes.length,1);
  await f.t.securityCheckResult(f.env,'/index.html',false,'SHA-256 mismatch');assert.equal(f.pushes.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM office_tasks').get().n,1);
  await f.t.securityCheckResult(f.env,'/index.html',true,'matches');assert.equal(f.pushes.length,2);assert.equal(f.db.prepare('SELECT status FROM office_tasks').get().status,'completed');
  await f.t.securityCheckResult(f.env,'/index.html',true,'matches');assert.equal(f.pushes.length,2);
 }finally{f.close()}
});
test('signed Clerk tokens without expiry are rejected; legitimate expiring token verifies',async()=>{
 const f=fixture();try{
  const key=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await webcrypto.subtle.exportKey('jwk',key.publicKey),kid:'test'};
  f.context.fetch=async()=>Response.json({keys:[jwk]});
  async function token(payload){const part=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const hp=part({alg:'RS256',kid:'test'})+'.'+part(payload);const sig=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,Buffer.from(hp));return hp+'.'+Buffer.from(sig).toString('base64url')}
  const claims={sub:'sasi',iss:'https://clerk.kim-betcher.de',azp:'https://kim-betcher.de'};
  const req=async p=>new Request('https://api.test/me',{headers:{Authorization:'Bearer '+await token(p)}});
  await assert.rejects(f.t.verifyClerkToken(await req(claims)),/TOKEN_EXPIRED/);
  assert.equal((await f.t.verifyClerkToken(await req({...claims,exp:Math.floor(Date.parse('2026-10-23T09:30:00Z')/1000)}))).userId,'sasi');
 }finally{f.close()}
});
test('a concurrent stale draft cannot overwrite a newly confirmed report',async()=>{
 const f=fixture();try{
  const draft=await json(await f.save({status:'draft'}));
  const original=f.env.DB.prepare.bind(f.env.DB);let armed=true,ready,release;
  const paused=new Promise(r=>ready=r),resume=new Promise(r=>release=r);
  f.env.DB.prepare=sql=>{const statement=original(sql);const first=statement.first.bind(statement);
   statement.first=async()=>{const row=await first();if(armed && /SELECT \*\s+FROM minijob_contribution_reports/.test(sql)){armed=false;ready();await resume}return row};return statement};
  const stale=f.save({status:'draft',estimated_gross_cents:60000});await paused;
  assert.equal((await f.save({status:'submitted',submission_confirmed:true,submitted_date:'2026-10-23',portal_fields:draft.snapshot.portalFields})).status,200);
  release();assert.equal((await stale).status,409);
  const row=f.db.prepare('SELECT status,estimated_gross_cents FROM minijob_contribution_reports').get();assert.equal(row.status,'submitted');assert.equal(row.estimated_gross_cents,50000);
 }finally{f.close()}
});
test('independent monitoring worker exposes no duplicate Office endpoints',async()=>{
 const f=fixture();try{
  for(const path of ['/health','/admin/users','/entries','/push/public-key']){
   const r=await f.t.worker.fetch(new Request('https://monitor.test'+path),{...f.env,SECURITY_MONITOR_ONLY:'true'},f.exec);assert.equal(r.status,404);
  }
 }finally{f.close()}
});

test('full independent monitor checks pinned assets, DB health, anonymous denial and metrics',async()=>{
 const f=fixture();try{
  const digest=Buffer.from(await webcrypto.subtle.digest('SHA-256',Buffer.from('trusted'))).toString('hex');
  f.context.digest=digest;vm.runInContext('for(const key of Object.keys(MONITORED_ASSETS)) MONITORED_ASSETS[key]=digest',f.context);
  f.context.fetch=async url=>String(url).endsWith('/health') ? Response.json({database:true}) : String(url).endsWith('/admin/users') ? Response.json({error:'denied'},{status:401,headers:{'Cache-Control':'private, no-store'}}) : new Response('trusted');
  await f.t.monitorSecurity(f.env);
  const checks=f.db.prepare('SELECT * FROM security_monitor_state').all();assert.equal(checks.length,12);assert.ok(checks.every(c=>!c.active&&!c.failures));assert.equal(f.pushes.length,0);
 }finally{f.close()}
});

test('private ZIP downloads belong to the signed-in owner and never appear for staff',async()=>{
 const f=fixture();try{
  vm.runInContext('ensureContracts=async()=>{}',f.context);
  f.db.exec(`CREATE TABLE employee_documents(id INTEGER PRIMARY KEY,clerk_user_id TEXT,title TEXT,file_name TEXT,mime TEXT,size INTEGER,chunks INTEGER,created_at TEXT);
   CREATE TABLE employee_document_chunks(document_id INTEGER,idx INTEGER,data TEXT);`);
  const bytes=Buffer.from('504b0304aabbccdd','hex');
  f.db.prepare('INSERT INTO employee_documents VALUES(1,?,?,?,?,?,?,?)').run('boss','Private ZIP','Office_Listen.zip','application/zip',bytes.length,1,'2026-10-26');
  f.db.prepare('INSERT INTO employee_document_chunks VALUES(1,0,?)').run(bytes.toString('base64'));
  vm.runInContext("verifyClerkToken=async()=>({userId:'boss'})",f.context);
  const response=await f.t.worker.fetch(new Request('https://api.test/documents/1'),f.env,f.exec);
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'application/zip');assert.match(response.headers.get('Content-Disposition'),/attachment; filename="Office_Listen.zip"/);
  assert.match(response.headers.get('Cache-Control'),/no-store/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  vm.runInContext("verifyClerkToken=async()=>({userId:'sasi'})",f.context);
  assert.equal((await f.t.worker.fetch(new Request('https://api.test/documents/1'),f.env,f.exec)).status,404);
  assert.deepEqual(await (await f.t.worker.fetch(new Request('https://api.test/documents'),f.env,f.exec)).json(),[]);
  assert.equal((await f.t.worker.fetch(new Request('https://api.test/admin/documents/1?user_id=boss'),f.env,f.exec)).status,403);
  await Promise.all(f.pending);
 }finally{f.close()}
});
