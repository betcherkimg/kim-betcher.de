// Harte Monatsgrenze für Minijob-Einträge + Kims Freigabe (max. 2 Monate je 12 Monate, bis zum Doppelten)
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../cloudflare/smartadm-office-api/worker.js'),'utf8');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE work_entries(id INTEGER PRIMARY KEY,clerk_user_id TEXT,work_date TEXT,work_minutes INTEGER);
 CREATE TABLE performance_entries(id INTEGER PRIMARY KEY,clerk_user_id TEXT,work_date TEXT,appointments INTEGER,work_entry_id INTEGER);
 CREATE TABLE employee_absences(clerk_user_id TEXT,absence_date TEXT,paid_amount_cents INTEGER);
 CREATE TABLE appointment_adjustments(clerk_user_id TEXT,payroll_month TEXT,delta INTEGER);
 CREATE TABLE monthly_closings(id INTEGER PRIMARY KEY,clerk_user_id TEXT,payroll_month TEXT,gross_cents INTEGER);
 CREATE TABLE office_members(clerk_user_id TEXT PRIMARY KEY,display_name TEXT,email TEXT);
 INSERT INTO office_members VALUES('sasi','Saskia','s@example.test');`);
 const DB={prepare(sql){let args=[];return{bind(...a){args=a;return this},async first(){return db.prepare(sql).get(...args)||null},async all(){return{results:db.prepare(sql).all(...args)}},async run(){const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}}}}}};
 const context=vm.createContext({console:{error(){},warn(){},log(){}},Request,Response,Headers,URL,Date,Intl,TextEncoder,TextDecoder,crypto:webcrypto,atob,btoa,AbortSignal});
 vm.runInContext(source.replace('export default {','const worker={')+';globalThis.t={monthLimitError,monthGrossCents,createLimitOverride,listLimitOverrides};',context);
 const env={DB,BOSS_USER_ID:'boss'};
 const add=(date,mins,appts)=>{const r=db.prepare('INSERT INTO work_entries(clerk_user_id,work_date,work_minutes) VALUES(?,?,?)').run('sasi',date,mins);db.prepare('INSERT INTO performance_entries(clerk_user_id,work_date,appointments,work_entry_id) VALUES(?,?,?,?)').run('sasi',date,appts,Number(r.lastInsertRowid));return Number(r.lastInsertRowid)};
 const override=(month,reason='Krankheitsvertretung Kollegin')=>context.t.createLimitOverride({env,owner:'sasi',userId:'boss',request:new Request('https://api.test/x',{method:'POST',body:JSON.stringify({month,reason})})});
 return {db,t:context.t,env,add,override,close:()=>db.close()};
}
test('Monatsbrutto: Stunden × Satz des Jahres + Termine × 5 €',async()=>{
 const f=fixture();try{
  f.add('2026-11-03',600,10);                      // 10 h × 13,90 + 10 × 5 = 189 €
  assert.equal(await f.t.monthGrossCents(f.env,'sasi','2026-11'),18900);
  f.add('2027-01-05',60,0);                        // 2027: 14,60 €
  assert.equal(await f.t.monthGrossCents(f.env,'sasi','2027-01'),1460);
 }finally{f.close()}
});
test('Stopp an der Monatsgrenze, Kim darf trotzdem korrigieren, weniger geht immer',async()=>{
 const f=fixture();try{
  const id=f.add('2026-11-03',2400,0);             // 40 h = 556 €
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2026-11-10',120,0),null);          // +27,80 = 583,80
  const r=await f.t.monthLimitError(f.env,'sasi','sasi','2026-11-10',120,5);                     // +27,80 +25 = 608,80
  assert.equal(r.status,409);assert.match((await r.json()).error,/Grenze von 603,00 €/);
  assert.equal(await f.t.monthLimitError(f.env,'sasi','boss','2026-11-10',600,0),null);          // Kim korrigiert
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2026-11-03',2300,0,[id]),null);    // Eintrag verkleinern
  // 2027 gilt 633 €
  f.add('2027-02-02',2580,0);                      // 43 h × 14,60 = 627,80
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2027-02-09',0,1),null);            // 632,80
  assert.equal((await f.t.monthLimitError(f.env,'sasi','sasi','2027-02-09',0,2)).status,409);    // 637,80
 }finally{f.close()}
});
test('Freigabe: bis zum Doppelten, Begründung Pflicht, höchstens 2 Monate in 12 Monaten',async()=>{
 const f=fixture();try{
  f.add('2026-11-03',2580,0);                      // 597,70
  assert.equal((await f.t.monthLimitError(f.env,'sasi','sasi','2026-11-20',600,0)).status,409);
  assert.equal((await f.override('2026-11','x')).status,400);
  assert.equal((await f.override('2026-11')).status,200);
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2026-11-20',600,0),null);          // 736,70 ≤ 1.206
  assert.equal((await f.t.monthLimitError(f.env,'sasi','sasi','2026-11-20',2700,0)).status,409); // 1.223,20 > 1.206
  assert.equal((await f.override('2026-11')).status,409);                                        // doppelt
  assert.equal((await f.override('2027-03')).status,200);
  assert.equal((await f.override('2027-08')).status,409);                                        // 3. im Fenster
  assert.equal((await f.override('2027-11')).status,200);                                        // Nov 26 fällt raus (Fenster 12/26–11/27)
  assert.equal((await f.override('2026-09')).status,409);                                        // rückwirkend: Fenster bis 08/27 hätte 3
 }finally{f.close()}
});
