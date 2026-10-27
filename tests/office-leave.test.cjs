const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../cloudflare/smartadm-office-api/worker.js'),'utf8');
function fixture(now='2026-10-27T10:00:00Z'){
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(path.join(__dirname,'fixtures/office-leave-schema.sql'),'utf8'));
 function statement(sql){return {sql,args:[],bind(...a){this.args=a;return this},async first(){return db.prepare(sql).get(...this.args)||null},async all(){return {results:db.prepare(sql).all(...this.args)}},async run(){const s=db.prepare(sql);if(s.columns().length){const results=s.all(...this.args);return {results,meta:{changes:Number(db.prepare('SELECT changes() n').get().n)}}}const r=s.run(...this.args);return {results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 const DB={prepare:statement,async batch(items){db.exec('BEGIN');try{const out=[];for(const x of items)out.push(await x.run());db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}};
 let time=Date.parse(now);class Clock extends Date{constructor(...a){super(...(a.length?a:[time]))}static now(){return time}}
 const context=vm.createContext({console,Request,Response,Headers,URL,TextEncoder,TextDecoder,crypto:webcrypto,atob,btoa,AbortSignal,Date:Clock,Intl});
 vm.runInContext(source.replace('export default {','const worker={')+`;globalThis.t={worker,saveRegularSlot,autoCompleteRegularWeeks,groupLegacyRegularWeek,regularMonthInfo,yearRules,calculatePayroll,calculateMinijobContributions,reopenRegularWeek,regularReminderSlot,remindRegularSubmissions,prepareCalendarPayroll,confirmPayrollPreparation,createMonthlyClosing,ensureRegular,regularAt,regularActive,regularPatterns,chooseRegularPattern,getRegularPattern,getRegularWeek,completeRegularWeek,regularHolidayRows,getRegularHolidays,decideRegularHoliday,regularClosingError,regularEntryError,createEntry,updateEntry,getLeaveSummary,ensureAdjustments,ensureLeave,leaveYearValue,leaveWaitingEnd,leaveHolidays,leaveAccount,leaveContext,getLeaveCalendar,addLeaveRequest,previewLeaveDecision,decideLeaveRequest,withdrawLeaveRequest,transferLeave,adjustLeave,setLeaveRate,getOwnAddendum,signOwnAddendum,signAdminAddendum,addendumState,renderAddendum,addendumBundle,replayCalendarIntro,seedCalendarTest,TEST_LEAVE_USER_ID,CALENDAR_ADDENDUM,ADDENDUM};notifyUser=async()=>[];pushBoss=async()=>{};notifyCalls=async()=>{};`,context);
 db.prepare("INSERT INTO office_employer(id,name,street,zip_city) VALUES(1,'Firma Test','Musterweg 1','89518 Heidenheim')").run();
 for(const [id,name,email] of [['sasi','Saskia Test','schreitersaskia@gmail.com'],[context.t.TEST_LEAVE_USER_ID,'Kim Test','betcherkimg@gmail.com'],['other','Andere Person','other@example.test']]){
  db.prepare('INSERT INTO employee_profiles(clerk_user_id,full_name,street,zip_city,birth_date,start_date)VALUES(?,?,?,?,?,?)').run(id,name,'Testweg 1','89567 Sontheim','2000-01-01','2026-10-01');
  db.prepare('INSERT INTO office_members(clerk_user_id,display_name,email) VALUES(?,?,?)').run(id,name,email);
 }
 const env={DB,BOSS_USER_ID:'boss'},exec={waitUntil(p){p.catch(()=>{})}};
 return {db,t:context.t,context,env,exec,setTime(s){time=Date.parse(s)},request(value){return new Request('https://test.invalid',{method:'POST',body:JSON.stringify(value)})},close(){db.close()}};
}
const url=s=>new URL('https://test.invalid'+s);
const read=async r=>{const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body};
async function terms(f,owner='sasi',from='2026-11-01'){await f.t.ensureLeave(f.env);f.db.prepare("INSERT INTO leave_terms VALUES(?,?,360,3,120,'BW','test-version','test-hash')").run(owner,from);}
async function requestLeave(f,dates,kind='vacation',userId='sasi'){
 await read(await f.t.addLeaveRequest({env:f.env,exec:f.exec,userId,request:f.request({kind,dates,note:kind==='holiday'?'Ohne den Feiertag war dieser Einsatz vorgesehen.':''})}));return f.db.prepare('SELECT * FROM leave_requests WHERE clerk_user_id=? ORDER BY id DESC LIMIT 1').get(userId);
}
async function approve(f,r,extra={}){return f.t.decideLeaveRequest({env:f.env,exec:f.exec,owner:r.clerk_user_id,userId:'boss',id:r.id,request:f.request({action:'approve',revision:r.revision,confirmed:true,advance_confirmed:true,note:'Solltage und volle Vergütung geprüft.',days:JSON.parse(r.dates_json).map(date=>({date,minutes:120,amount_cents:4000})),...extra})});}

test('regional holiday dates, waiting period over New Year and future full-year entitlement',()=>{
 const f=fixture();try{
  assert.equal(f.t.leaveWaitingEnd('2026-10-01'),'2027-03-31');assert.equal(f.t.leaveWaitingEnd('2026-10-31'),'2027-04-30');
  assert.equal(f.t.leaveHolidays(2026,'BW')['2026-12-25'],'1. Weihnachtstag');assert.equal(f.t.leaveHolidays(2026,'BW')['2026-10-31'],undefined);assert.equal(f.t.leaveHolidays(2027,'BW')['2027-03-26'],'Karfreitag');
  const job={start_date:'2026-10-01'},terms=[{effective_from:'2026-10-01',workdays:3,source_version:'test'}];
  assert.equal(f.t.leaveYearValue({year:2026,asOf:'2026-10-31',job,terms}).entitlement,1);
  assert.equal(f.t.leaveYearValue({year:2026,asOf:'2026-12-31',job,terms}).entitlement,3);
  assert.equal(f.t.leaveYearValue({year:2027,asOf:'2027-01-31',job,terms}).entitlement,0);
  assert.equal(f.t.leaveYearValue({year:2027,asOf:'2027-04-01',job,terms}).entitlement,12);
  assert.equal(f.t.leaveYearValue({year:2028,asOf:'2028-01-01',job,terms}).entitlement,12);
  assert.equal(f.t.leaveYearValue({year:2027,asOf:'2027-12-31',job,terms:[...terms,{effective_from:'2027-07-01',workdays:2}]}).entitlement,10);
 }finally{f.close()}
});

test('requests reserve days but only approval creates paid credit; duplicate approval and overlapping requests fail',async()=>{
 const f=fixture();try{
  await terms(f);const r=await requestLeave(f,['2026-11-02','2026-11-04','2026-11-06']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM employee_absences').get().n,0);
  let c=await f.t.leaveContext(f.env,'sasi');assert.equal(f.t.leaveAccount(c,2026).reserved,3);
  assert.equal((await f.t.addLeaveRequest({env:f.env,userId:'sasi',request:f.request({dates:['2026-11-02']})})).status,400);
  assert.equal((await approve(f,r,{confirmed:false})).status,400);
  await read(await approve(f,r));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM employee_absences').get().n,3);
  assert.equal((await approve(f,r)).status,409);
  c=await f.t.leaveContext(f.env,'sasi');assert.equal(f.t.leaveAccount(c,2026).approved,3);assert.equal(f.t.leaveAccount(c,2026).reserved,0);
  const workInsert=()=>f.db.prepare("INSERT INTO work_entries(clerk_user_id,work_date,start_time,end_time,work_minutes)VALUES('sasi','2026-11-02','16:00','18:00',120)").run();assert.throws(workInsert,/Abwesenheit/);
  await read(await f.t.withdrawLeaveRequest({env:f.env,userId:'sasi',id:r.id,exec:f.exec}));c=await f.t.leaveContext(f.env,'sasi');assert.equal(f.t.leaveAccount(c,2026).approved,3);
  const cancelled=f.db.prepare('SELECT * FROM leave_requests WHERE id=?').get(r.id);
  await read(await f.t.decideLeaveRequest({env:f.env,owner:'sasi',userId:'boss',id:r.id,exec:f.exec,request:f.request({action:'cancel',revision:cancelled.revision,note:'Einvernehmlich storniert.'})}));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM employee_absences').get().n,0);assert.ok(f.db.prepare('SELECT COUNT(*) n FROM leave_audit').get().n>=4);
 }finally{f.close()}
});

test('holiday credit never consumes leave and owner checks isolate employee and test data',async()=>{
 const f=fixture();try{
  await terms(f);const r=await requestLeave(f,['2026-12-25'],'holiday');
  assert.equal((await f.t.previewLeaveDecision({env:f.env,owner:'other',id:r.id})).status,404);
  await read(await approve(f,r));const c=await f.t.leaveContext(f.env,'sasi');assert.equal(f.t.leaveAccount(c,2026).approved,0);
  const a=f.db.prepare('SELECT * FROM employee_absences').get();assert.equal(a.absence_type,'holiday');assert.equal(a.paid_minutes,120);
  assert.equal((await f.t.seedCalendarTest({env:f.env,userId:'sasi'})).status,403);
  assert.equal((await f.t.replayCalendarIntro({env:f.env,userId:'sasi'})).status,403);
  await read(await f.t.seedCalendarTest({env:f.env,userId:f.t.TEST_LEAVE_USER_ID}));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_plans WHERE clerk_user_id='sasi'").get().n,0);
  const own=await read(await f.t.getLeaveCalendar({env:f.env,userId:'other',url:url('/calendar?month=2026-12')}));assert.equal(own.requests.length,0);assert.equal(own.absences.length,0);
 }finally{f.close()}
});

test('new addendum freezes the reviewed text for both signatures, activates only after both, and preserves the first version',async()=>{
 const f=fixture();try{
  await f.t.ensureLeave(f.env);f.db.prepare("INSERT INTO addendum_targets(clerk_user_id)VALUES('sasi')").run();
  const old=await f.t.renderAddendum(f.env,'sasi',f.t.ADDENDUM.version);
  for(const role of ['employee','employer'])f.db.prepare("INSERT INTO addendum_signatures(clerk_user_id,version,role,signer_id,signature,doc_json,doc_hash,signed_at)VALUES('sasi',?,?,?,'data:image/png;base64,AA==',?,?, '2026-10-14 10:00:00')").run(f.t.ADDENDUM.version,role,role,JSON.stringify(old.doc),old.hash);
  const before=await read(await f.t.getOwnAddendum({env:f.env,userId:'sasi'}));assert.equal(before.archive.length,1);assert.equal(before.complete,false);
  const signature='data:image/png;base64,AA==';
  const bad=await f.t.signOwnAddendum({env:f.env,userId:'sasi',exec:f.exec,request:f.request({version:before.version,doc_hash:'stale',signature})});assert.equal(bad.status,409);
  const first=await read(await f.t.signOwnAddendum({env:f.env,userId:'sasi',exec:f.exec,request:f.request({version:before.version,doc_hash:before.hash,signature})}));assert.equal(first.complete,false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM leave_terms WHERE clerk_user_id='sasi'").get().n,0);
  f.db.prepare("UPDATE employee_profiles SET street='Neue Teststraße' WHERE clerk_user_id='sasi'").run();
  const frozen=await f.t.addendumState(f.env,'sasi');assert.equal(frozen.hash,before.hash);assert.equal(frozen.doc.employee.street,'Testweg 1');
  const complete=await read(await f.t.signAdminAddendum({env:f.env,owner:'sasi',userId:'boss',exec:f.exec,request:f.request({version:before.version,doc_hash:frozen.hash,signature})}));assert.equal(complete.complete,true);assert.equal(complete.archive[0].hash,old.hash);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM leave_terms WHERE clerk_user_id='sasi'").get().n,0);
  await read(await f.t.chooseRegularPattern({env:f.env,userId:'sasi',exec:f.exec,request:f.request({weekdays:[1,3,5],confirmed:true})}));
  assert.equal(f.db.prepare("SELECT effective_from FROM leave_terms WHERE clerk_user_id='sasi'").get().effective_from,'2026-11-01');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM addendum_signatures').get().n,4);
  const test=await read(await f.t.getOwnAddendum({env:f.env,userId:f.t.TEST_LEAVE_USER_ID}));assert.equal(test.testAccount,true);assert.equal(test.doc.sections[0].heading,'TESTDOKUMENT');assert.notEqual(test.hash,complete.hash);
 }finally{f.close()}
});

test('carryover keeps origin year and illness corrections return days without extending leave automatically',async()=>{
 const f=fixture();try{
  await terms(f,'sasi','2026-10-01');await read(await f.t.transferLeave({env:f.env,userId:'sasi',request:f.request({year:2026})}));
  const r=await requestLeave(f,['2027-01-04']);await read(await approve(f,r));let snap=JSON.parse(f.db.prepare('SELECT snapshot_json FROM leave_requests').get().snapshot_json);assert.equal(snap.days[0].leave_year,2026);
  f.setTime('2027-01-05T10:00:00Z');const row=f.db.prepare('SELECT * FROM leave_requests').get();
  await read(await f.t.decideLeaveRequest({env:f.env,owner:'sasi',userId:'boss',exec:f.exec,id:r.id,request:f.request({action:'sick',revision:row.revision,date:'2027-01-04',medical_proof:true,amount_cents:4000,note:'Ärztlicher AU-Nachweis liegt vor.'})}));
  snap=JSON.parse(f.db.prepare('SELECT snapshot_json FROM leave_requests').get().snapshot_json);assert.equal(snap.days[0].units,0);assert.equal(f.db.prepare('SELECT absence_type FROM employee_absences').get().absence_type,'sick');
  const c=await f.t.leaveContext(f.env,'sasi');assert.equal(f.t.leaveAccount(c,2026,'2027-01-05').approved,0);
 }finally{f.close()}
});

async function signedRegular(f,weekdays=[1,3,5],owner='sasi'){
 await f.t.ensureRegular(f.env);f.db.prepare('INSERT OR IGNORE INTO addendum_targets(clerk_user_id)VALUES(?)').run(owner);
 const doc=await f.t.renderAddendum(f.env,owner,f.t.CALENDAR_ADDENDUM.version);
 for(const role of ['employee','employer'])f.db.prepare('INSERT OR IGNORE INTO addendum_signatures(clerk_user_id,version,role,signer_id,signature,doc_json,doc_hash,signed_at)VALUES(?,?,?,?,?,?,?,?)').run(owner,f.t.CALENDAR_ADDENDUM.version,role,role,'data:image/png;base64,AA==',JSON.stringify(doc.doc),doc.hash,'2026-10-27 10:00:00');
 await read(await f.t.chooseRegularPattern({env:f.env,userId:owner,exec:f.exec,request:f.request({weekdays,confirmed:true})}));
 return doc;
}
async function weekData(f,week,owner='sasi'){return read(await f.t.getRegularWeek({env:f.env,userId:owner,owner,url:url('/regular-week?week='+week)}));}
async function record(f,date,slot,appointments=3,start='08:00',end='10:00'){
 return f.t.createEntry({env:f.env,owner:'sasi',request:f.request({work_date:date,regular_slot:slot,start_time:start,end_time:end,break_minutes:0,appointments})});
}

test('initial days require employee consent, activate after both signatures, and changes take effect only in the month after next',async()=>{
 const f=fixture();try{
  await f.t.ensureRegular(f.env);f.db.prepare("INSERT INTO addendum_targets(clerk_user_id)VALUES('sasi')").run();
  const choose=days=>f.t.chooseRegularPattern({env:f.env,userId:'sasi',exec:f.exec,request:f.request({weekdays:days,confirmed:true,effective_from:'2020-01-01'})});
  assert.equal((await choose([1,3,5])).status,409);
  const doc=await f.t.renderAddendum(f.env,'sasi',f.t.CALENDAR_ADDENDUM.version);
  f.db.prepare("INSERT INTO addendum_signatures(clerk_user_id,version,role,signer_id,signature,doc_json,doc_hash,signed_at)VALUES('sasi',?,'employee','sasi','data:image/png;base64,AA==',?,?,'2026-10-27 10:00:00')").run(f.t.CALENDAR_ADDENDUM.version,JSON.stringify(doc.doc),doc.hash);
  assert.equal((await choose([1,3,6])).status,400);await read(await choose([1,3,5]));
  let ps=await f.t.regularPatterns(f.env,'sasi');assert.equal(ps[0].valid_from,null);assert.equal(await f.t.regularActive(f.env,'sasi','2026-12-25'),null);
  f.db.prepare("INSERT INTO addendum_signatures(clerk_user_id,version,role,signer_id,signature,doc_json,doc_hash,signed_at)VALUES('sasi',?,'employer','boss','data:image/png;base64,AA==',?,?,'2026-10-28 10:00:00')").run(f.t.CALENDAR_ADDENDUM.version,JSON.stringify(doc.doc),doc.hash);
  ps=await f.t.regularPatterns(f.env,'sasi');assert.equal(ps[0].valid_from,'2026-11-01');
  await read(await choose([2,3,4]));ps=await f.t.regularPatterns(f.env,'sasi');assert.equal(ps[1].valid_from,'2026-12-01');
  assert.deepEqual(Array.from(f.t.regularAt(ps,'2026-11-30').weekdays),[1,3,5]);assert.deepEqual(Array.from(f.t.regularAt(ps,'2026-12-01').weekdays),[2,3,4]);
  assert.throws(()=>f.db.prepare("UPDATE regular_patterns SET effective_from='2020-01-01'").run(),/Historie/);
  assert.equal((await f.t.regularPatterns(f.env,'other')).length,0);
 }finally{f.close()}
});

test('Christmas row is credited and blocked; early entry retains the actual Tuesday and the Wednesday reference slot',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-12-22T11:00:00Z');
  let w=await weekData(f,'2026-12-21');assert.equal(w.holidayMinutes,120);assert.equal(w.targetMinutes,240);assert.equal(w.slots[2].holiday.name,'1. Weihnachtstag');
  const res=await record(f,'2026-12-22','2026-12-23');assert.equal(res.status,201,JSON.stringify(await res.json()));
  w=await weekData(f,'2026-12-21');assert.equal(w.slots[1].entries[0].work_date,'2026-12-22');assert.equal(w.slots[1].entries[0].regular_slot,'2026-12-23');assert.equal(w.workMinutes,120);assert.equal(w.missingMinutes,120);
  assert.equal((await record(f,'2026-12-23','2026-12-23')).status,400,'future work is not actual work');
  assert.equal((await record(f,'2026-12-22','2026-12-25',1,'10:00','11:00')).status,400,'credited reference cannot also contain work');
  assert.equal((await record(f,'2026-12-22','2026-12-28',1,'10:00','11:00')).status,400,'cross-week slot forbidden');
  f.setTime('2026-12-25T11:00:00Z');assert.equal((await record(f,'2026-12-25','2026-12-23')).status,400,'holiday itself cannot be worked');
  f.setTime('2026-12-26T11:00:00Z');assert.equal((await record(f,'2026-12-26','2026-12-23')).status,400,'Saturday cannot be worked');
 }finally{f.close()}
});

test('zero, one, two and three credited regular-day holidays reduce only the actual work target',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-12-22T11:00:00Z');
  for(let n=0;n<=3;n++){
   const dates=['2026-12-21','2026-12-23','2026-12-25'].slice(0,n);f.context.holidayDates=dates;
   vm.runInContext("leaveHolidays=()=>Object.fromEntries(globalThis.holidayDates.map(d=>[d,'Testfeiertag']));",f.context);
   const w=await weekData(f,'2026-12-21');assert.equal(w.holidayMinutes,120*n);assert.equal(w.targetMinutes,360-120*n);assert.equal(w.fulfilledMinutes,120*n);
  }
 }finally{f.close()}
});

test('holiday approval records full pay separately; new work invalidates its quote without removing its hours',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-12-27T11:00:00Z');
  assert.equal((await record(f,'2026-12-22','2026-12-23')).status,201);
  const draft=await weekData(f,'2026-12-21');await read(await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week:'2026-12-21',state_hash:draft.stateHash,note:'Nur zwei Stunden, bitte prüfen.'})}));
  let rows=await read(await f.t.getRegularHolidays({env:f.env,owner:'sasi',url:url('/admin/regular-holidays?month=2026-12')})),h=rows[0];
  assert.equal(h.quote.base_cents,2780);assert.equal(h.quote.variable_cents,1500);
  assert.equal((await f.t.regularClosingError(f.env,'sasi','2026-12')).status,409);
  const approve=()=>f.t.decideRegularHoliday({env:f.env,owner:'sasi',userId:'boss',id:h.id,request:f.request({revision:h.revision,confirmed:true,note:'Voller Lohnausfall geprüft.',amount_cents:h.quote.suggested_cents})});
  await read(await approve());assert.equal((await approve()).status,400);
  let w=await weekData(f,'2026-12-21');assert.equal(w.holidayMinutes,120);assert.equal(w.absenceMinutes,0);assert.equal(w.fulfilledMinutes,240);
  assert.equal(await f.t.regularClosingError(f.env,'sasi','2026-12'),null);
  await read(await f.t.reopenRegularWeek({env:f.env,owner:'sasi',userId:'boss',exec:f.exec,request:f.request({week:'2026-12-21',note:'Eintrag ergänzen.'})}));
  assert.equal((await record(f,'2026-12-24','2026-12-21',1)).status,201);
  const corrected=await weekData(f,'2026-12-21');await read(await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week:'2026-12-21',state_hash:corrected.stateHash})}));
  assert.equal((await f.t.regularClosingError(f.env,'sasi','2026-12')).status,409);
  w=await weekData(f,'2026-12-21');assert.equal(w.holidayMinutes,120);assert.equal(w.targetMinutes,240);assert.equal(w.missingMinutes,0);
 }finally{f.close()}
});

test('Sunday completeness reminder accepts explained short weeks and reopens after entries change',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-12-24T11:00:00Z');let w=await weekData(f,'2026-12-21');
  const complete=(data,note='')=>f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week:'2026-12-21',state_hash:data.stateHash,note})});
  assert.equal((await complete(w,'Heute bestätigt')).status,400);
  f.setTime('2026-12-27T11:00:00Z');w=await weekData(f,'2026-12-21');assert.ok(w.overdue.includes('2026-12-21'));
  assert.equal((await complete(w)).status,400);await read(await complete(w,'Weniger Stunden, bitte prüfen.'));
  w=await weekData(f,'2026-12-21');assert.equal(w.confirmed,true);
  assert.equal((await record(f,'2026-12-24','2026-12-23')).status,409);
  await read(await f.t.reopenRegularWeek({env:f.env,owner:'sasi',userId:'boss',exec:f.exec,request:f.request({week:'2026-12-21',note:'Nachtrag ermöglichen.'})}));
  assert.equal((await record(f,'2026-12-24','2026-12-23')).status,201);w=await weekData(f,'2026-12-21');assert.equal(w.confirmed,false);
 }finally{f.close()}
});

test('vacation can only be requested on a regular non-holiday workday, including after a future change',async()=>{
 const f=fixture();try{
  await signedRegular(f);
  const request=dates=>f.t.addLeaveRequest({env:f.env,userId:'sasi',exec:f.exec,request:f.request({dates,kind:'vacation'})});
  for(const date of ['2026-11-03','2026-11-05','2026-11-07','2026-11-08','2026-12-25'])assert.equal((await request([date])).status,400,date);
  assert.equal((await request(['2026-11-02'])).status,200);
  await read(await f.t.chooseRegularPattern({env:f.env,userId:'sasi',exec:f.exec,request:f.request({weekdays:[2,3,4],confirmed:true})}));
  assert.equal((await request(['2026-12-04'])).status,400);assert.equal((await request(['2026-12-01'])).status,200);
 }finally{f.close()}
});

test('monthly preparation computes holiday and vacation pay, blocks unresolved issues and invalidates signoff after real changes',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2027-01-08T12:00:00Z');
  f.db.prepare("INSERT INTO payroll_settings(clerk_user_id)VALUES('sasi')").run();
  // Actual work remains in December even though its reference slot is later in the week.
  for(const date of ['2026-12-21','2026-12-23','2026-12-28','2026-12-30']){
   const row=f.db.prepare("INSERT INTO work_entries(clerk_user_id,work_date,start_time,end_time,work_minutes,regular_slot)VALUES('sasi',?,'08:00','10:00',120,?)").run(date,date);
   f.db.prepare("INSERT INTO performance_entries(clerk_user_id,work_date,appointments,commissionable_appointments,work_entry_id)VALUES('sasi',?,3,3,?)").run(date,Number(row.lastInsertRowid));
  }
  for(const week of ['2026-11-30','2026-12-07','2026-12-14','2026-12-21','2026-12-28'])f.db.prepare("INSERT INTO week_reviews(clerk_user_id,week_start,result,note)VALUES('sasi',?,'excused','Abgestimmt')").run(week);
  for(const week of ['2026-11-30','2026-12-07','2026-12-14','2026-12-21','2026-12-28']){const w=await weekData(f,week);await read(await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week,state_hash:w.stateHash,note:'Abgestimmte Woche, tatsächliche Zeit vollständig.'})}));}
  let p=await f.t.prepareCalendarPayroll(f.env,'sasi','2026-12');assert.equal(p.blockers.length,0);assert.equal(p.items.length,1);assert.equal(p.cents.holidayPay,4280);assert.equal(p.checked,false);
  const confirm=body=>f.t.confirmPayrollPreparation({env:f.env,owner:'sasi',userId:'boss',request:f.request(body)});
  await read(await confirm({month:'2026-12',hash:p.hash,confirmed:true}));p=await f.t.prepareCalendarPayroll(f.env,'sasi','2026-12');assert.equal(p.checked,true);
  const a=f.db.prepare("SELECT * FROM employee_absences WHERE absence_type='holiday'").get();assert.equal(a.paid_amount_cents,4280);assert.equal(a.paid_minutes,120);
  assert.equal(p.cents.gross,480*1390/60+12*500+4280);
  f.db.prepare("INSERT INTO appointment_adjustments(clerk_user_id,payroll_month,delta,note,created_by)VALUES('sasi','2026-12',-1,'Kundenabsage','boss')").run();p=await f.t.prepareCalendarPayroll(f.env,'sasi','2026-12');assert.equal(p.checked,false);assert.equal(p.cents.holidayPay,4155);
  assert.equal((await confirm({month:'2026-12',hash:'old-hash',confirmed:true})).status,409);
  assert.equal((await f.t.createMonthlyClosing({env:f.env,owner:'sasi',userId:'boss',request:f.request({month:'2026-12'}),exec:f.exec})).status,409);
 }finally{f.close()}
});

test('draft hours and appointments enter payroll only after explicit Friday-to-Sunday submission, with immutable correction history',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-11-03T13:00:00Z');
  assert.equal((await record(f,'2026-11-03','2026-11-04',4)).status,201);
  assert.equal(f.db.prepare("SELECT entry_state FROM work_entries").get().entry_state,'draft');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payroll_work_entries').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payroll_performance_entries').get().n,0);
  let w=await weekData(f,'2026-11-02');
  assert.equal((await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week:w.week,state_hash:w.stateHash,note:'Zwei Stunden'})})).status,400);
  f.setTime('2026-11-06T13:00:00Z');w=await weekData(f,'2026-11-02');
  await read(await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week:w.week,state_hash:w.stateHash,note:'Fehlstunden bitte einordnen.'})}));
  assert.equal(f.db.prepare('SELECT SUM(work_minutes) n FROM payroll_work_entries').get().n,120);assert.equal(f.db.prepare('SELECT SUM(appointments) n FROM payroll_performance_entries').get().n,4);
  const e=f.db.prepare('SELECT * FROM work_entries').get();assert.ok(e.submission_id);
  assert.throws(()=>f.db.prepare("UPDATE work_entries SET work_minutes=130 WHERE id=?").run(e.id),/festgeschrieben/);
  assert.throws(()=>f.db.prepare("DELETE FROM work_entries WHERE id=?").run(e.id),/festgeschrieben/);
  assert.equal((await record(f,'2026-11-05','2026-11-06')).status,409);
  await read(await f.t.reopenRegularWeek({env:f.env,owner:'sasi',userId:'boss',exec:f.exec,request:f.request({week:w.week,note:'Kundentermin wurde vergessen.'})}));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payroll_work_entries').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM regular_submission_events').get().n,2);
  w=await weekData(f,'2026-11-02');assert.equal(w.confirmed,false);
 }finally{f.close()}
});

test('week reminder policy sends Saturday noon and exactly three Sunday slots, stops when sent, and uses Berlin DST',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.context.pushes=[];vm.runInContext("notifyUser=async(env,userId,payload)=>{globalThis.pushes.push({userId,...payload});return [{status:201}]}",f.context);
  for(const date of ['2026-11-06T14:00:00Z','2026-11-07T10:59:00Z']){f.setTime(date);await f.t.remindRegularSubmissions(f.env,f.exec)}assert.equal(f.context.pushes.length,0);
  for(const date of ['2026-11-07T11:00:00Z','2026-11-07T16:00:00Z','2026-11-08T08:00:00Z','2026-11-08T08:15:00Z','2026-11-08T12:00:00Z','2026-11-08T12:15:00Z','2026-11-08T16:00:00Z','2026-11-08T16:15:00Z']){f.setTime(date);await f.t.remindRegularSubmissions(f.env,f.exec)}
  assert.equal(f.context.pushes.length,4);assert.equal(new Set(f.context.pushes.map(x=>x.tag)).size,4);
  const w=await weekData(f,'2026-11-02');await read(await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week:w.week,state_hash:w.stateHash,note:'Bitte die fehlende Zeit prüfen.'})}));
  f.setTime('2026-11-08T17:00:00Z');await f.t.remindRegularSubmissions(f.env,f.exec);assert.equal(f.context.pushes.length,4);
  assert.equal(f.t.regularReminderSlot('2027-07-03','11:59'),null);assert.equal(f.t.regularReminderSlot('2027-07-03','12:00'),'sat-12');assert.equal(f.t.regularReminderSlot('2027-07-04','09:00'),'09:00');
 }finally{f.close()}
});

test('future calendar years retain 12 days and require explicit yearly payroll parameters instead of silently reusing 2027',async()=>{
 const f=fixture();try{
  await signedRegular(f);let c=await read(await f.t.getLeaveCalendar({env:f.env,userId:'sasi',url:url('/calendar?month=2028-04')}));assert.equal(c.accounts.find(a=>a.year===2028).annualProjected,12);assert.ok(c.rateReview);
  assert.equal(f.t.yearRules('2028-01').confirmed,false);
  const rules={limit:70000,rvMinBase:17500,kv:.13,rvEmployer:.15,rvFull:.186,u1:.01,u2:.0022,insolvency:.0015,flatTax:.02};
  await read(await f.t.setLeaveRate({env:f.env,owner:'sasi',userId:'boss',request:f.request({year:2028,rate_cents:1500,year_rules:rules,note:'Jahreswerte für die lokale Testabrechnung bestätigt.'})}));
  assert.equal(f.t.yearRules('2028-01').limit,70000);assert.equal(f.t.yearRules('2028-01').confirmed,true);
  const p=f.t.calculatePayroll({month:'2028-01',mins:120,days:1,appts:0,profile:{employeeRv:false,employerRv:true,u1:true}});assert.equal(p.cents.timePay,3000);assert.equal(p.cents.u1,30);assert.equal(p.cents.employeeRv,0);assert.equal(p.cents.employerRv,450);
 }finally{f.close()}
});

test('submitted vacation is automatically priced and all regular-day holiday credits enter the immutable monthly payroll snapshot',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-11-20T13:00:00Z');
  f.db.prepare("INSERT INTO payroll_settings(clerk_user_id)VALUES('sasi')").run();
  assert.equal((await record(f,'2026-11-19','2026-11-18',3)).status,201);
  let w=await weekData(f,'2026-11-16');await read(await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week:w.week,state_hash:w.stateHash,note:'Nur tatsächliche zwei Stunden.'})}));
  const r=await requestLeave(f,['2026-12-07']);const preview=await read(await f.t.previewLeaveDecision({env:f.env,owner:'sasi',id:r.id}));assert.equal(preview.days[0].suggested_cents,4280);
  await read(await approve(f,r,{days:[{date:'2026-12-07',minutes:120,amount_cents:4280}]}));
  f.setTime('2027-01-08T13:00:00Z');
  for(const week of ['2026-11-30','2026-12-07','2026-12-14','2026-12-21','2026-12-28']){
   f.db.prepare("INSERT INTO week_reviews(clerk_user_id,week_start,result,note)VALUES('sasi',?,'excused','Mit Kim abgestimmt.')").run(week);
   w=await weekData(f,week);await read(await f.t.completeRegularWeek({env:f.env,userId:'sasi',exec:f.exec,request:f.request({week,state_hash:w.stateHash,note:'Tatsächliche Zeit und Abwesenheiten vollständig.'})}));
  }
  let p=await f.t.prepareCalendarPayroll(f.env,'sasi','2026-12');assert.equal(p.blockers.length,0,JSON.stringify(p.blockers));assert.equal(p.items.find(i=>i.kind==='vacation').amount_cents,4280);assert.equal(p.items.find(i=>i.kind==='holiday').amount_cents,4280);
  await read(await f.t.confirmPayrollPreparation({env:f.env,owner:'sasi',userId:'boss',request:f.request({month:'2026-12',hash:p.hash,confirmed:true})}));
  const closed=await f.t.createMonthlyClosing({env:f.env,owner:'sasi',userId:'boss',exec:f.exec,request:f.request({month:'2026-12'})});assert.equal(closed.status,201);
  const row=f.db.prepare("SELECT * FROM monthly_closings WHERE payroll_month='2026-12'").get(),snap=JSON.parse(row.snapshot_json);assert.equal(snap.payroll.vacationPay,42.8);assert.equal(snap.payroll.holidayPay,42.8);assert.equal(snap.calendarCalculation.checked,true);assert.equal(row.gross_cents,8560);
  assert.throws(()=>f.db.prepare("UPDATE employee_absences SET paid_amount_cents=1 WHERE absence_date='2026-12-07'").run(),/abgeschlossen/);
 }finally{f.close()}
});

test('contract target scales with holiday credit and its paid release never invents worked hours',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-12-04T14:00:00Z');
  assert.equal((await record(f,'2026-12-02','2026-12-02',46)).status,201);
  const context=await f.t.leaveContext(f.env,'sasi'),patterns=await f.t.regularPatterns(f.env,'sasi'),info=await f.t.regularMonthInfo(f.env,'sasi','2026-12',patterns,context);
  assert.equal(info.baseMinutes,1560);assert.equal(info.holidayMinutes,120);assert.equal(info.cutAppointments,46);assert.equal(info.cutDate,'2026-12-02');assert.ok(info.releaseDays.length>0);assert.ok(!info.releaseDays.some(d=>d.date==='2026-12-25'));
  const w=await weekData(f,'2026-12-07');assert.equal(w.workMinutes,0);assert.equal(w.absenceMinutes,360);assert.equal(w.targetMinutes,0);
  const p=f.t.calculatePayroll({month:'2026-12',mins:1200,days:10,appts:46,profile:{employeeRv:false},targetAppointments:46,targetGrossCents:60000});assert.equal(p.cents.gross,60000);assert.equal(p.cents.targetBonus,9200);
 }finally{f.close()}
});

test('employee edits keep drafts out of payroll and an employer can explicitly permit a late correction',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-11-04T14:00:00Z');await record(f,'2026-11-03','2026-11-04',3);
  const id=f.db.prepare('SELECT id FROM work_entries').get().id;
  const update=()=>f.t.updateEntry({env:f.env,owner:'sasi',id,request:f.request({work_date:'2026-11-03',regular_slot:'2026-11-04',start_time:'08:00',end_time:'09:30',work_minutes:90,break_minutes:0,appointments:4})});
  await read(await update());assert.equal(f.db.prepare('SELECT work_minutes FROM work_entries').get().work_minutes,90);assert.equal(f.db.prepare('SELECT appointments FROM performance_entries').get().appointments,4);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payroll_work_entries').get().n,0);
  f.setTime('2026-11-12T14:00:00Z');assert.equal((await update()).status,400);
  await read(await f.t.reopenRegularWeek({env:f.env,owner:'sasi',userId:'boss',exec:f.exec,request:f.request({week:'2026-11-02',note:'Verspätete Korrektur abgestimmt.'})}));
  await read(await update());assert.equal(f.db.prepare("SELECT COUNT(*) n FROM regular_submission_events WHERE event='correction_allowed'").get().n,1);
 }finally{f.close()}
});


test('direct weekly values keep allocation provenance, update totals without duplication, and enter payroll only on submission',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-12-22T11:00:00Z');
  const save=(slot,minutes,appointments,note='')=>f.t.saveRegularSlot({env:f.env,userId:'sasi',request:f.request({slot,minutes,appointments,note})});
  await read(await save('2026-12-23',90,3,'Schon erledigt'));
  const row=f.db.prepare('SELECT * FROM work_entries').get();assert.equal(row.record_kind,'weekly_allocation');assert.equal(row.start_time,'');assert.equal(row.end_time,'');assert.equal(row.entry_note,'Schon erledigt');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payroll_work_entries').get().n,0);
  await read(await save('2026-12-23',120,4,'Korrigiert'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_entries').get().n,1);assert.equal((await weekData(f,'2026-12-21')).workMinutes,120);
  assert.equal((await save('2026-12-25',120,1)).status,409);assert.equal((await save('2026-12-28',120,1)).status,409);
  f.setTime('2026-12-28T00:15:00Z');await f.t.autoCompleteRegularWeeks(f.env,f.exec);
  const sent=await weekData(f,'2026-12-21');assert.equal(sent.confirmed,true);assert.equal(sent.workMinutes,120);assert.equal(sent.missingMinutes,120);
  const audit=f.db.prepare("SELECT * FROM regular_submission_events WHERE week_start='2026-12-21' AND event='submitted'").get();assert.equal(audit.actor,'system');assert.equal(JSON.parse(audit.detail_json).automatic,true);
  assert.equal(f.db.prepare('SELECT SUM(work_minutes) n FROM payroll_work_entries').get().n,120);
  const count=f.db.prepare('SELECT COUNT(*) n FROM regular_week_confirmations').get().n;await f.t.autoCompleteRegularWeeks(f.env,f.exec);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM regular_week_confirmations').get().n,count);
  assert.equal((await save('2026-12-23',180,5)).status,409);
 }finally{f.close()}
});

test('Sunday remains editable until the Berlin week boundary; empty weeks auto-submit zero without inventing work or an excuse',async()=>{
 const f=fixture();try{
  await signedRegular(f);f.setTime('2026-12-27T22:59:00Z');await f.t.autoCompleteRegularWeeks(f.env,f.exec);assert.equal((await weekData(f,'2026-12-21')).confirmed,false);
  f.setTime('2026-12-27T23:00:00Z');await f.t.autoCompleteRegularWeeks(f.env,f.exec);const data=await weekData(f,'2026-12-21');assert.equal(data.confirmed,true);assert.equal(data.workMinutes,0);assert.equal(data.entries.length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM week_reviews').get().n,0);
  await read(await f.t.reopenRegularWeek({env:f.env,userId:'boss',owner:'sasi',exec:f.exec,request:f.request({week:'2026-12-21',note:'Bitte nachtragen.'})}));await f.t.autoCompleteRegularWeeks(f.env,f.exec);assert.equal((await weekData(f,'2026-12-21')).confirmed,false);
 }finally{f.close()}
});

test('authorized grouping moves existing current-week totals to the first declared row without changing actual dates or pay',async()=>{
 const f=fixture();try{
  await signedRegular(f,[1,3,4]);f.setTime('2026-10-27T12:00:00Z');
  f.db.prepare("INSERT INTO work_entries(clerk_user_id,work_date,start_time,end_time,work_minutes)VALUES('sasi','2026-10-26','08:00','09:00',60),('sasi','2026-10-27','08:00','08:20',20)").run();
  for(const [id,date,appts] of [[1,'2026-10-26',2],[2,'2026-10-27',1]])f.db.prepare('INSERT INTO performance_entries(clerk_user_id,work_date,appointments,work_entry_id)VALUES(?,?,?,?)').run('sasi',date,appts,id);
  f.db.prepare("INSERT INTO regular_submission_events(clerk_user_id,week_start,event,actor,detail_json)VALUES('sasi','2026-10-26','group_pending','boss','{}')").run();
  const w=await weekData(f,'2026-10-26');assert.equal(w.active,true);assert.equal(w.slots.length,3);assert.equal(w.slots[0].entries.reduce((n,e)=>n+e.work_minutes,0),80);assert.equal(w.slots[0].entries.reduce((n,e)=>n+e.appointments,0),3);
  assert.equal(f.db.prepare('SELECT work_date FROM work_entries WHERE id=2').get().work_date,'2026-10-27');
  assert.equal(f.db.prepare('SELECT SUM(work_minutes) n FROM work_entries').get().n,80);
  await read(await f.t.saveRegularSlot({env:f.env,userId:'sasi',request:f.request({slot:'2026-10-26',minutes:100,appointments:4,note:'Ergänzt'})}));
  const next=await weekData(f,'2026-10-26');assert.equal(next.workMinutes,100);assert.equal(f.db.prepare('SELECT SUM(appointments) n FROM performance_entries').get().n,4);
 }finally{f.close()}
});


test('unused leave carries automatically across multiple years and approval uses oldest origin without a transfer request',async()=>{
 const f=fixture();try{
  await terms(f,'sasi','2026-10-01');f.setTime('2027-01-02T10:00:00Z');
  let c=await f.t.leaveContext(f.env,'sasi'),a=f.t.leaveAccount(c,2027);assert.equal(a.carried,3);assert.equal(a.remaining,3);assert.equal(a.projected,15);
  const r=await requestLeave(f,['2027-01-04']);await read(await approve(f,r,{advance_confirmed:false}));
  const snap=JSON.parse(f.db.prepare('SELECT snapshot_json FROM leave_requests WHERE id=?').get(r.id).snapshot_json);assert.equal(snap.days[0].leave_year,2026);
  c=await f.t.leaveContext(f.env,'sasi');a=f.t.leaveAccount(c,2027);assert.equal(a.remaining,2);assert.equal(a.approved,1);assert.equal(a.planningRemaining,14);
  const next=f.t.leaveAccount(c,2028,'2028-01-01');assert.equal(next.carried,14);assert.equal(next.projected,26);
  assert.equal(f.t.leaveAccount(c,2028,'2028-01-01').planningRemaining,26);

 }finally{f.close()}
});

test('fractional carryover is used first and cancellation restores its original bucket',async()=>{
 const f=fixture();try{
  await terms(f,'sasi','2026-10-01');await read(await f.t.adjustLeave({env:f.env,owner:'sasi',userId:'boss',request:f.request({year:2026,days:-2.5,note:'Geprüfter Altbestand'})}));f.setTime('2027-04-02T10:00:00Z');
  const r=await requestLeave(f,['2027-04-05']);await read(await approve(f,r));
  const saved=f.db.prepare('SELECT * FROM leave_requests WHERE id=?').get(r.id),d=JSON.parse(saved.snapshot_json).days[0];assert.deepEqual(d.leave_allocations,[{year:2026,units:.5},{year:2027,units:.5}]);
  let c=await f.t.leaveContext(f.env,'sasi');assert.equal(f.t.leaveAccount(c,2027).remaining,11.5);
  await read(await f.t.decideLeaveRequest({env:f.env,owner:'sasi',userId:'boss',id:r.id,exec:f.exec,request:f.request({action:'cancel',revision:saved.revision,note:'Einvernehmlich aufgehoben'})}));
  c=await f.t.leaveContext(f.env,'sasi');assert.equal(f.t.leaveAccount(c,2027).remaining,12.5);
 }finally{f.close()}
});
