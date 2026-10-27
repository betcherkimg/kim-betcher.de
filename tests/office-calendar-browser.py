# Browser checks use intercepted fixtures; no real employee data or signatures are changed.
from pathlib import Path
import json,copy,subprocess
ROOT=Path(__file__).resolve().parents[1]
base=(ROOT/'tests/office-browser-flows.py').read_text().split('with sync_playwright() as pw:')[0]
exec(compile(base,str(ROOT/'tests/office-browser-flows.py'),'exec'))
HOOK=HOOK.replace('window.__t={','window.__t={regularWeek,officeCalendar,loadCalendarPayroll,renderDashboardWidgets,renderMyStart,downloadAddendumPdf,')
node="const fs=require('fs');eval(fs.readFileSync('cloudflare/smartadm-office-api/worker.js','utf8').replace('export default {','const worker={')+';console.log(JSON.stringify(CALENDAR_ADDENDUM))')"
definition=json.loads(subprocess.check_output(['node','-e',node],cwd=ROOT))
class CalendarAPI(API):
 def __init__(self):
  super().__init__();self.plans=[{'id':i+1,'plan_date':d,'start_time':'16:00','note':'Geplante Dauer: 2:00 h','status':'planned'} for i,d in enumerate(['2026-10-26','2026-10-28','2026-10-30'])];self.signed=False;self.patterns=[];self.entries=[];self.requests=[];self.saved=[];self.submitted=False;self.signature=None
  self.doc={'version':definition['version'],'title':definition['title'],'sections':definition['sections'],'employee':{'name':'Saskia Test','street':'Testweg 1','zip_city':'89567 Sontheim','birth_date':'2000-01-01'},'employer':{'name':'Firma Test','street':'Testweg 2','zip_city':'89567 Sontheim'},'intro':['Vertrag im lokalen Browsertest'],'place':'Sontheim','place_employee':'Sontheim'}
 def addendum(self):return {'version':definition['version'],'doc':self.doc,'ready':True,'hash':'fixture-document-hash','complete':self.signed,'canDefer':False,'archive':[],'signatures':{'employee':{'signed_at':'2026-10-27 11:00:00','signer_name':'Saskia Test','signature':self.signature or 'data:image/png;base64,AA=='} if self.signed else None,'employer':{'signed_at':'2026-10-27 10:00:00','signer_name':'Firma Test','signature':self.signature or 'data:image/png;base64,AA=='}}}
 def calendar(self):return {'month':'2026-12','region':'BW','job':{'start_date':'2026-10-01'},'terms':[],'patterns':self.patterns,'accounts':[{'year':2026,'entitlement':3,'approved':0,'reserved':0,'remaining':3,'projected':3,'planningRemaining':3,'provisional':False,'waitingEnd':'2027-03-31'}],'holidays':[{'date':'2026-12-25','name':'1. Weihnachtstag'},{'date':'2027-01-06','name':'Heilige Drei Könige'}],'regularHolidays':[{'date':'2026-12-25','name':'1. Weihnachtstag','minutes':120,'status':'calculated'}] if self.patterns else [],'plans':[],'work':[],'absences':[],'requests':self.requests,'history':[],'audit':[],'rates':[{'year':2026,'rate':1390}],'closedMonths':[]}
 def week(self,week):
  active=bool(self.patterns and week>='2026-11-01');slots=[]
  import datetime
  start=datetime.date.fromisoformat(week)
  if active:
   for i in [0,2,4]:
    d=(start+datetime.timedelta(days=i)).isoformat();hol={'date':d,'name':'1. Weihnachtstag','minutes':120} if d=='2026-12-25' else None
    slots.append({'date':d,'weekday':i+1,'holiday':hol,'absence':None,'entries':[e for e in self.entries if e.get('regular_slot')==d]})
  mins=sum(e['work_minutes'] for e in self.entries);credit=120 if week=='2026-12-21' and active else 0
  return {'active':active,'week':week,'slots':slots,'entries':self.entries,'unassigned':[],'workMinutes':mins,'holidayMinutes':credit,'absenceMinutes':0,'targetMinutes':360-credit,'baseMinutes':360,'fulfilledMinutes':mins+credit,'missingMinutes':max(0,360-credit-mins),'overtimeMinutes':max(0,mins-360+credit),'actualWorkdays':len(self.entries),'overdue':[],'stateHash':'fixture-state','confirmed':self.submitted,'patterns':self.patterns}
 def route(self,route):
  req=route.request;parsed=urlparse(req.url);p=parsed.path;m=req.method;body=req.post_data_json if req.post_data else {};out=None
  from urllib.parse import parse_qs
  params=parse_qs(parsed.query)
  if p=='/addendum':out=self.addendum()
  elif p=='/addendum/sign':self.signed=True;self.signature=body['signature'];out=self.addendum();assert body['doc_hash']=='fixture-document-hash'
  elif p=='/regular-pattern':
   if m=='POST':self.patterns=[{'id':1,'weekdays':body['weekdays'],'valid_from':'2026-11-01','created_at':'2026-10-27 11:01:00','kind':'initial'}]
   out={'patterns':self.patterns,'current':self.patterns[0] if self.patterns else None,'needsInitial':self.signed and not self.patterns,'employeeSigned':self.signed,'nextChangeDate':'2027-02-01'}
  elif p=='/regular-week/complete':self.submitted=True;self.entries=[dict(e,entry_state='final',submission_id=1) for e in self.entries];out={'success':True}
  elif p=='/regular-week':out=self.week(params.get('week',['2026-10-26'])[0])
  elif p in ['/calendar','/admin/calendar']:out=self.calendar()
  elif p=='/entries':
   if m=='POST':
    self.saved.append(body);self.entries.append(dict(body,entry_state='draft',id=len(self.entries)+1,created_at='2026-12-22 10:00:00',updated_at='2026-12-22 10:00:00'));out={'success':True}
   else:out=self.entries
  elif p=='/leave-requests' and m=='POST':self.requests.append(dict(body,id=1,status='requested',revision=1,from_date=body['dates'][0],to_date=body['dates'][-1],created_at='2026-12-22 10:00:00'));out={'success':True}
  elif p=='/admin/regular-holidays':out=[]
  elif p=='/admin/leave-summary':out={'entitlement':3,'remaining':3,'taken':0,'averageWorkdaysPerWeek':3}
  elif p=='/admin/payroll-preparation':out={}
  if out is None:return super().route(route)
  route.fulfill(status=200,content_type='application/json',body=json.dumps(out))
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in [1280,390]:
  api=CalendarAPI();ctx,page,errors=page_for(browser,api,width,'2026-10-27T11:00:00Z')
  expect(page.locator('#whatsNew')).to_be_visible();page.screenshot(path=f'/workspace/scratch/calendar-intro-{width}.png');page.keyboard.press('Escape');expect(page.locator('#whatsNew')).to_be_visible()
  while not page.locator('#whatsNewCheck').is_visible():
   check_width(page);page.locator('#whatsNewOk').click()
  expect(page.locator('#whatsNewOk')).to_be_disabled();page.locator('#whatsNewCheck').check();page.locator('#whatsNewOk').click()
  expect(page.locator('#addendumDialog')).to_be_visible();expect(page.locator('#regularPatternDialog')).not_to_be_visible()
  page.locator('#signPad').scroll_into_view_if_needed();box=page.locator('#signPad').bounding_box();page.mouse.move(box['x']+25,box['y']+100);page.mouse.down()
  for x,y in [(100,30),(160,120),(230,20),(280,110)]:page.mouse.move(box['x']+min(x,box['width']-10),box['y']+y,steps=8)
  page.mouse.up();expect(page.locator('#signSubmit')).to_be_enabled();page.locator('#signSubmit').click()
  expect(page.locator('#regularPatternDialog')).to_be_visible();page.keyboard.press('Escape');expect(page.locator('#regularPatternDialog')).to_be_visible()
  for d in [1,3,5]:page.locator(f'#regularDayChoices input[value="{d}"]').check()
  page.locator('#regularPatternCheck').check();page.locator('#regularPatternSave').click();expect(page.locator('#regularPatternDialog')).not_to_be_visible()
  expect(page.locator('[data-my="kalender"]')).to_be_visible();page.locator('[data-my-act="kalender"]').click();expect(page.locator('#kalender')).to_have_class('page active')
  page.clock.set_fixed_time('2026-12-22T11:00:00Z');page.evaluate('async()=>{__t.showPage("zeiten");await __t.regularWeek.selectWeek("2026-12-21")}')
  expect(page.locator('#regularWeekCard')).to_be_visible();expect(page.locator('.regular-row')).to_have_count(3);holiday=page.locator('.regular-disabled');expect(holiday).to_contain_text('Feiertag · 2 Stunden gutgeschrieben');assert holiday.locator('input').count()==0
  page.locator('[data-slot-hours="2026-12-23"]').fill('1,5');page.locator('[data-slot-appts="2026-12-23"]').fill('3');page.locator('[data-regular-slot="2026-12-23"]').click()
  expect(page.locator('#entryManualHours')).to_have_value('1,5');expect(page.locator('#date')).to_have_value('2026-12-22');page.locator('#start').fill('08:00');page.locator('#end').fill('09:30');page.locator('#saveBtn').click()
  page.wait_for_function('window.__t.state.entries.length===1');assert api.saved[0]['work_date']=='2026-12-22' and api.saved[0]['regular_slot']=='2026-12-23' and api.saved[0]['work_minutes']==90
  check_width(page);page.screenshot(path=f'/workspace/scratch/calendar-week-{width}.png',full_page=True)
  with page.expect_download() as dl:
   page.evaluate('__t.downloadAddendumPdf(__t.state.addendum)')
  dl.value.save_as(f'/workspace/scratch/calendar-addendum-{width}.pdf')
  import fitz
  pdf=fitz.open(f'/workspace/scratch/calendar-addendum-{width}.pdf');assert len(pdf)>=3;assert 'Absenden' in ''.join(p.get_text() for p in pdf);pdf.close()
  page.on('dialog',lambda d:d.accept('Bitte die fehlenden Stunden prüfen.') if d.type=='prompt' else d.accept())
  page.clock.set_fixed_time('2026-12-25T11:00:00Z');page.evaluate('async()=>{await __t.regularWeek.selectWeek("2026-12-21")}');page.locator('#regularComplete').click();expect(page.locator('#regularComplete')).to_have_text('Abgesendet ✓');assert api.submitted
  page.evaluate('__t.showPage("kalender")');page.locator('#calendarMonth').fill('2026-12');page.locator('#calendarMonth').dispatch_event('change');page.locator('#calendarNewLeave').click();page.locator('#leaveFrom').fill('2027-01-04');page.locator('#leaveTo').fill('2027-01-10');page.locator('#leaveTo').dispatch_event('change')
  for d in ['05','06','07','09','10']:expect(page.locator(f'[data-leave-date="2027-01-{d}"]')).to_be_disabled()
  for d in ['04','08']:expect(page.locator(f'[data-leave-date="2027-01-{d}"]')).to_be_checked()
  page.locator('#leaveRequestClose').click();check_width(page)
  page.evaluate('''()=>{__t.state.role='boss';document.body.dataset.officeRole='boss';__t.state.selectedUserId='sasi';__t.state.employees=[{clerk_user_id:'sasi',display_name:'Saskia Test'}];__t.showPage('boss-dashboard');__t.renderDashboardWidgets()}''')
  expect(page.locator('[data-widget="kalender"]')).to_be_visible();assert not errors,errors
  print(f'PASS {width}: guided intro → real canvas signature → mandatory 3-day choice; both widgets; grey holiday; manual 1.5h actual Tuesday / Wednesday slot; vacation off-days blocked; multi-page signed PDF; Friday submit freezes drafts')
  ctx.close()
 browser.close();server.shutdown()
