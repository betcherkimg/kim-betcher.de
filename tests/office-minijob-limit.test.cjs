// Stopp an der Jahresgrenze für Minijob-Einträge + Kims Freigabe (max. 2 Monate je 12 Monate, bis zum Doppelten)
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
 CREATE TABLE employee_profiles(clerk_user_id TEXT PRIMARY KEY,start_date TEXT,end_date TEXT);
 INSERT INTO employee_profiles VALUES('sasi','2026-10-01',NULL);
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
test('Einzelne Monate dürfen über 603 € liegen – Stopp erst an der Jahresgrenze (3 × 603 + 9 × 633 = 7.506 €)',async()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO monthly_closings(clerk_user_id,payroll_month,gross_cents) VALUES('sasi','2026-10',51970)").run();
  f.add('2026-11-03',3000,0);                      // 50 h = 695 € > 603 € im Monat – erlaubt
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2026-11-10',120,0),null);
  // Jahr fast voll: Oktober 519,70 + November 695 + Rest bis knapp unter 7.506
  f.add('2027-03-02',25000,0);                     // 416,67 h × 14,60 = 6.083,33 €  → zusammen 7.298,03 €
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2027-04-06',600,0),null);          // +146 = 7.444,03
  const r=await f.t.monthLimitError(f.env,'sasi','sasi','2027-04-06',600,10);                    // +146 +50 = 7.494,03? noch drin
  assert.equal(r,null);
  const stop=await f.t.monthLimitError(f.env,'sasi','sasi','2027-04-06',900,0);                  // +219 = 7.517,03 > 7.506
  assert.equal(stop.status,409);assert.match((await stop.json()).error,/Jahresgrenze von 7\.506,00 € \(10\/2026–09\/2027\)/);
  assert.equal(await f.t.monthLimitError(f.env,'sasi','boss','2027-04-06',900,0),null);          // Kim korrigiert
  // Neues Beschäftigungsjahr (10/2027–09/2028) startet wieder bei 0
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2027-10-05',600,0),null);
 }finally{f.close()}
});
test('Ausnahme: +1 Monatsgrenze aufs Jahr, Monat höchstens doppelt, Begründung Pflicht, max. 2 in 12 Monaten',async()=>{
 const f=fixture();try{
  f.add('2026-10-06',30000,0);                     // 500 h × 13,90 = 6.950 €
  f.add('2027-01-12',2400,0);                      // 40 h × 14,60 = 584 € → 7.534 € > 7.506 (Kim hat korrigiert)
  assert.equal((await f.t.monthLimitError(f.env,'sasi','sasi','2027-01-20',60,0)).status,409);
  assert.equal((await f.override('2027-01','x')).status,400);
  assert.equal((await f.override('2027-01')).status,200);
  assert.equal(await f.t.monthLimitError(f.env,'sasi','sasi','2027-01-20',1800,0),null);         // Monat 1.022 € ≤ 1.266
  assert.equal((await f.t.monthLimitError(f.env,'sasi','sasi','2027-01-20',3000,0)).status,409); // Monat 1.314 € > 1.266
  assert.equal((await f.override('2027-01')).status,409);
  assert.equal((await f.override('2027-03')).status,200);
  assert.equal((await f.override('2027-08')).status,409);
  assert.equal((await f.override('2028-02')).status,200);
  assert.equal((await f.override('2026-11')).status,409);
 }finally{f.close()}
});
