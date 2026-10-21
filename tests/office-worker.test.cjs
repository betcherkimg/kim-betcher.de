const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const os=require('node:os');
const path=require('node:path');
const P=require('../smartadm/office/week-planner.js');
const source=fs.readFileSync(path.join(__dirname,'../cloudflare/smartadm-office-api/worker.js'),'utf8');

function fixture(now='2026-10-23T08:00:00Z'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-worker-test-')),dbfile=path.join(dir,'db.sqlite');
 function query(sql,args=[]){
  const py=`import sqlite3,json,sys\nr=json.load(sys.stdin)\nc=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row\ncur=c.execute(r['sql'],r['args']);rows=[dict(x) for x in cur.fetchall()] if cur.description else []\nn=c.execute('SELECT changes()').fetchone()[0];last=cur.lastrowid;c.commit()\nprint(json.dumps({'results':rows,'meta':{'changes':n,'last_row_id':last}}))`;
  const result=spawnSync('python3',['-c',py,dbfile],{input:JSON.stringify({sql,args}),encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr+'\n'+sql);
  return JSON.parse(result.stdout);
 }
 const db={prepare(sql){let args=[];return {bind(...a){args=a;return this},async all(){return query(sql,args)},async first(){return query(sql,args).results[0]||null},async run(){return query(sql,args)}}},async batch(items){const results=[];for(const item of items)results.push(await item.run());return results}};
 for(const sql of [
  `CREATE TABLE office_tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,assigned_to TEXT,created_by TEXT,title TEXT,description TEXT,due_date TEXT,priority TEXT,status TEXT,completed_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE employee_profiles(clerk_user_id TEXT PRIMARY KEY,start_date TEXT,end_date TEXT)`,
  `CREATE TABLE office_members(clerk_user_id TEXT PRIMARY KEY,display_name TEXT,email TEXT)`,
  `CREATE TABLE office_calls(id INTEGER PRIMARY KEY,assigned_to TEXT,briefing TEXT,customer_name TEXT,hold_note TEXT,status TEXT,protocol TEXT,closed_at TEXT,updated_at TEXT)`
 ])query(sql);
 query('INSERT INTO employee_profiles VALUES (?,?,NULL)',['sasi','2026-10-01']);
 let time=Date.parse(now);class Clock extends Date {constructor(...args){super(...(args.length?args:[time]))}static now(){return time}}
 const pushes=[];
 const context=vm.createContext({console,Request,Response,Headers,URL,TextEncoder,TextDecoder,Date:Clock,Intl,crypto:globalThis.crypto,atob,btoa});
 vm.runInContext(source.replace('export default {','const worker = {')+`;globalThis.t={ensureHr,ensureWeekPlanningTask,confirmWeekPlanning,remindWeekPlanning,planningWeek,sundayReminderSlot,berlinParts,plannedMinutes,getOwnTasks,completeOwnTask,receiveContactDetails,closeCall,contactRequestName};notifyUser=async(env,userId,message)=>{globalThis.pushes.push({userId,...message});return [{status:201}]};`,context);
 context.pushes=pushes;
 const env={DB:db,BOSS_USER_ID:'boss-user'};
 return {t:context.t,env,query,pushes,setTime(value){time=Date.parse(value)},close(){fs.rmSync(dir,{recursive:true,force:true})}};
}
const body=value=>new Request('https://test.invalid',{method:'POST',body:JSON.stringify(value)});

test('Friday task persists once, cannot be dismissed as ordinary task, completes after an explained short week',async()=>{
 const f=fixture();try{
  await f.t.ensureWeekPlanningTask(f.env,'sasi');await f.t.ensureWeekPlanningTask(f.env,'sasi');
  const tasks=await (await f.t.getOwnTasks({env:f.env,userId:'sasi'})).json();
  assert.equal(tasks.length,1);assert.equal(tasks[0].weekPlanning,true);assert.equal(tasks[0].weekStart,'2026-10-26');
  assert.equal((await f.t.completeOwnTask({env:f.env,userId:'sasi',id:tasks[0].id})).status,404);
  for(const [date,minutes] of [['2026-10-26',180],['2026-10-28',120]])f.query('INSERT INTO work_plans(clerk_user_id,plan_date,start_time,note)VALUES(?,?,?,?)',['sasi',date,'18:00',P.encodeNote(minutes,'','Diese Woche nur fünf Stunden möglich.')]);
  const ctx={env:f.env,userId:'sasi',request:body({week_start:'2026-10-26'})};
  assert.equal((await f.t.confirmWeekPlanning(ctx)).status,400);
  const success=await f.t.confirmWeekPlanning({...ctx,request:body({week_start:'2026-10-26',reason:'Diese Woche nur fünf Stunden möglich.'})});
  assert.equal(success.status,200);assert.equal((await success.json()).minutes,300);
  await f.t.ensureWeekPlanningTask(f.env,'sasi');
  assert.equal(f.query('SELECT status FROM office_tasks').results[0].status,'completed');
 }finally{f.close()}
});

test('more than six hours requires a reason on the server and accepts all three selected days',async()=>{
 const f=fixture();try{
  await f.t.ensureHr(f.env);
  for(const date of ['2026-10-26','2026-10-27','2026-10-28'])f.query('INSERT INTO work_plans(clerk_user_id,plan_date,start_time,note)VALUES(?,?,?,?)',['sasi',date,'18:00',P.encodeNote(180,'','Nacharbeit aus der Vorwoche')]);
  const ctx={env:f.env,userId:'sasi'};
  assert.equal((await f.t.confirmWeekPlanning({...ctx,request:body({week_start:'2026-10-26'})})).status,400);
  const res=await f.t.confirmWeekPlanning({...ctx,request:body({week_start:'2026-10-26',reason:'Nacharbeit aus der Vorwoche'})});
  assert.equal((await res.json()).minutes,540);
 }finally{f.close()}
});

test('Sunday cron sends only one push per slot, uses Berlin time through DST, stops for a completed week',async()=>{
 const f=fixture('2026-10-25T06:45:00Z');try{
  await f.t.remindWeekPlanning(f.env);assert.equal(f.pushes.length,0);
  for(const utc of ['08:00','08:15','12:00','12:15','16:00','16:15']){f.setTime(`2026-10-25T${utc}:00Z`);await f.t.remindWeekPlanning(f.env)}
  assert.equal(f.pushes.length,3);assert.equal(new Set(f.pushes.map(x=>x.tag)).size,3);
  assert.equal(f.t.sundayReminderSlot(f.t.berlinParts(Date.parse('2026-10-18T07:00:00Z'))),'09:00');
  assert.equal(f.t.sundayReminderSlot(f.t.berlinParts(Date.parse('2026-10-25T08:00:00Z'))),'09:00');
  assert.equal(f.t.sundayReminderSlot({date:'2026-10-24',time:'17:00'}),null);
  f.query('INSERT INTO week_planning(clerk_user_id,week_start,completed_at)VALUES(?,?,CURRENT_TIMESTAMP)',['sasi','2026-10-26']);
  f.query('DELETE FROM hr_flags');await f.t.remindWeekPlanning(f.env);assert.equal(f.pushes.length,3);
 }finally{f.close()}
});

test('six-hour legacy plans avoid reminders; one unconfirmed day does not',async()=>{
 const f=fixture('2026-10-25T08:00:00Z');try{
  await f.t.ensureHr(f.env);
  f.query('INSERT INTO work_plans(clerk_user_id,plan_date,start_time,note)VALUES(?,?,?,?)',['sasi','2026-10-26','18:00','']);
  await f.t.remindWeekPlanning(f.env);assert.equal(f.pushes.length,1);
  for(const date of ['2026-10-28','2026-10-30'])f.query('INSERT INTO work_plans(clerk_user_id,plan_date,start_time,note)VALUES(?,?,?,?)',['sasi',date,'18:00','']);
  f.setTime('2026-10-25T12:00:00Z');await f.t.remindWeekPlanning(f.env);assert.equal(f.pushes.length,1);
 }finally{f.close()}
});

test('request mode rejects appointment results and accepts phone-only or email-only receipts with owner checks',async()=>{
 const f=fixture();try{
  const briefing='[SmartADM-Skript v1]\n'+JSON.stringify({version:1,contactRequest:{name:'Alexander Muster'}});
  for(const id of [1,2,3])f.query("INSERT INTO office_calls(id,assigned_to,briefing,customer_name,status)VALUES(?,?,?,?, 'open')",[id,'sasi',briefing,'Muster, Eva']);
  assert.equal((await f.t.closeCall({env:f.env,userId:'sasi',id:1,request:body({result:'R_TA_mT',protocol:'Termin'})})).status,400);
  for(const value of [{},{email:'ungueltig'},{phone:'abc'}])assert.equal((await f.t.receiveContactDetails({env:f.env,userId:'sasi',id:1,request:body(value)})).status,400);
  assert.equal((await f.t.receiveContactDetails({env:f.env,userId:'other',id:1,request:body({phone:'07361 123456'})})).status,404);
  assert.equal((await f.t.receiveContactDetails({env:f.env,userId:'sasi',id:1,request:body({phone:'07361 123456'})})).status,200);
  assert.equal((await f.t.receiveContactDetails({env:f.env,userId:'sasi',id:2,request:body({email:'alex@example.test'})})).status,200);
  const rows=f.query('SELECT status,protocol FROM office_calls WHERE id IN (1,2) ORDER BY id').results;
  assert.equal(rows[0].status,'R_TA_oT');assert.match(rows[0].protocol,/Kontaktdaten von Alexander Muster erhalten\nTelefon: 07361 123456/);
  assert.match(rows[1].protocol,/E-Mail: alex@example.test/);assert.equal(f.pushes.length,2);
  assert.equal((await f.t.receiveContactDetails({env:f.env,userId:'sasi',id:1,request:body({phone:'012345'})})).status,404);
 }finally{f.close()}
});
