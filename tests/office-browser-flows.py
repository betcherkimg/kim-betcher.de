# Local browser integration tests. Production Clerk and API requests are fully intercepted.
import json,re,threading,copy
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
HOOK='''window.__t={state,planner:weeklyPlanner,loadPlans,loadTasks,loadCalls,showPage,renderOwnCalls,renderTasks,renderHr,resetCallForm,fillCallForm,showCallForm,readCallScriptForm,encodeCallScript,callScriptData,conversationTemplate,renderConversation,adminCallHtml,openContactDetails,finalAnwenden,showWhatsNew,afterEmployeeNotices};'''
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
 def log_message(self,*a):pass
 def do_GET(self):
  if self.path.split('?')[0]=='/smartadm/office/':
   s=(ROOT/'smartadm/office/index.html').read_text().replace('  initStaticValues();',HOOK+'\n  initStaticValues();')
   raw=s.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(raw)
  else:super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{server.server_port}'
CLERK='''window.Clerk={user:{id:'sasi',firstName:'Saskia',lastName:'Test',primaryEmailAddress:{emailAddress:'sasi@example.test'}},session:{getToken:async()=> 'local-fixture'},load:async()=>{},mountSignIn:()=>{},mountUserButton:()=>{},addListener:()=>{}};'''
class API:
 def __init__(self):self.plans=[];self.prefs={};self.acks=[];self.calls=[];self.receipts=[];self.count=0;self.confirmed=[];self.fail_post=False
 def route(self,route):
  req=route.request;p=urlparse(req.url).path;m=req.method;body=req.post_data_json if req.post_data else {}
  out=[];code=200
  if p=='/me':out={'role':'employee'}
  elif p=='/me/prefs':
   if m=='PUT':self.prefs=copy.deepcopy(body['prefs'])
   out={'prefs':self.prefs}
  elif p=='/plans' and m=='GET':out=self.plans
  elif p=='/plans' and m=='POST':
   self.count+=1;self.plans.append(dict(body,id=self.count,status='planned'));out={'success':True}
   if self.fail_post:self.fail_post=False;route.abort('failed');return
  elif re.fullmatch(r'/plans/\d+',p):
   id=int(p.rsplit('/',1)[1]);row=next(x for x in self.plans if x['id']==id)
   if m=='PUT':row.update(body)
   if m=='DELETE':self.plans.remove(row)
   out={'success':True}
  elif p=='/plans/week/confirm':self.confirmed.append(body);out={'success':True}
  elif p=='/notices/acks':out=[{'version':v} for v in self.acks]
  elif p=='/notices/ack':self.acks.append(body['version']);out={'success':True}
  elif p=='/addendum':out={'available':False}
  elif p=='/week-account':out={}
  elif p=='/settings':out={}
  elif p=='/push/public-key':out={'publicKey':None}
  elif p=='/calls':out=[x for x in self.calls if x['status']=='open']
  elif re.fullmatch(r'/calls/\d+/contact-details',p):
   row=next(x for x in self.calls if x['id']==int(p.split('/')[2]));row['status']='R_TA_oT';self.receipts.append(body);out={'success':True}
  elif m!='GET':out={'success':True}
  route.fulfill(status=code,content_type='application/json',body=json.dumps(out))
 def attach(self,context):
  def external(route):
   if 'smartadm-office-api.betcherkimg.workers.dev' in route.request.url:return self.route(route)
   if 'clerk.browser.js' in route.request.url:return route.fulfill(content_type='application/javascript',body=CLERK)
   if route.request.resource_type=='script':return route.fulfill(content_type='application/javascript',body='')
   return route.fulfill(content_type='text/css',body='')
  context.route('https://**/*',external)

def page_for(browser,api,width,date):
 context=browser.new_context(viewport={'width':width,'height':900},locale='de-DE',timezone_id='Europe/Berlin',service_workers='block');api.attach(context)
 page=context.new_page();page.clock.set_fixed_time(date);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(BASE+'/smartadm/office/');page.wait_for_function('window.__t && window.__t.state.role==="employee"');return context,page,errors

def days(page,dates,hours):
 for i,(d,h) in enumerate(zip(dates,hours)):
  page.locator(f'#weekDay{i}').select_option(d)
  page.locator(f'#weekHours{i}').fill(str(h))

def check_width(page):
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'

with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in [1280,390]:
  api=API();ctx,page,errors=page_for(browser,api,width,'2026-10-23T08:00:00Z')
  expect(page.locator('#whatsNew')).to_be_visible();expect(page.locator('#planDialog')).not_to_be_visible();expect(page.locator('#whatsNewOk')).to_be_disabled()
  page.keyboard.press('Escape');expect(page.locator('#whatsNew')).to_be_visible()
  page.locator('#whatsNewCheck').check();page.locator('#whatsNewOk').click();expect(page.locator('#planDialog')).to_be_visible();expect(page.locator('#planSnoozeBtn')).to_be_visible()
  expect(page.locator('#weekHours0')).to_have_value('2');expect(page.locator('#weekHours2')).to_have_value('2')
  check_width(page)
  page.locator('#planSnoozeBtn').click();expect(page.locator('#planDialog')).not_to_be_visible();assert api.prefs['weekPlanning']['2026-10-26']['count']==1
  ctx.close()
  ctx,page,errors2=page_for(browser,api,width,'2026-10-23T15:00:00Z');page.wait_for_timeout(150);expect(page.locator('#whatsNew')).not_to_be_visible();expect(page.locator('#planDialog')).not_to_be_visible();ctx.close()
  ctx,page,errors3=page_for(browser,api,width,'2026-10-24T08:00:00Z');expect(page.locator('#planDialog')).to_be_visible();page.locator('#planSnoozeBtn').click();expect(page.locator('#planDialog')).not_to_be_visible();assert api.prefs['weekPlanning']['2026-10-26']['count']==2;ctx.close()
  ctx,page,errors4=page_for(browser,api,width,'2026-10-25T08:00:00Z');expect(page.locator('#planDialog')).to_be_visible();expect(page.locator('#planSnoozeBtn')).not_to_be_visible();expect(page.locator('#planDialogClose')).not_to_be_visible()
  page.keyboard.press('Escape');expect(page.locator('#planDialog')).to_be_visible()
  days(page,['2026-10-26','2026-10-28'],[3,2]);page.locator('#planSaveBtn').click();expect(page.locator('#planStatus')).to_contain_text('begründe');assert len(api.plans)==0
  page.locator('#planWeekReason').fill('Diese Woche nur fünf Stunden möglich.');page.locator('#planSaveBtn').click();expect(page.locator('#planDialog')).not_to_be_visible();assert len(api.plans)==2;assert api.confirmed[-1]['reason'];
  page.evaluate('__t.planner.open("2026-10-26")');expect(page.locator('#planDialog')).to_be_visible();expect(page.locator('#planWeekReason')).to_have_value('Diese Woche nur fünf Stunden möglich.')
  page.locator('#weekHours1').fill('3');expect(page.locator('#weekDay2')).to_be_enabled();expect(page.locator('#planWeekReasonField')).not_to_be_visible()
  page.locator('#weekDay2').select_option('2026-10-30');expect(page.locator('#planWeekReasonField')).to_be_visible();expect(page.locator('#planWeekReasonLabel')).to_contain_text('mehr')
  page.locator('#planWeekReason').fill('');page.locator('#planSaveBtn').click();expect(page.locator('#planStatus')).to_contain_text('begründe')
  page.locator('#planWeekReason').fill('Nacharbeit aus der Vorwoche');check_width(page)
  page.screenshot(path=f'/tmp/office-week-more-{width}.png',full_page=True)
  page.locator('#planSaveBtn').click();expect(page.locator('#planDialog')).not_to_be_visible();assert len(api.plans)==3;assert api.confirmed[-1]['reason']=='Nacharbeit aus der Vorwoche';assert sum(int(x['note'].split(': ')[1].split(':')[0])*60+int(x['note'].split(': ')[1].split(':')[1][:2]) for x in api.plans)==480
  # Boss configuration, script metadata round trip, and clean automatic request text.
  result=page.evaluate('''()=>{__t.resetCallForm();document.querySelector('#callRequestContact').checked=true;document.querySelector('#callRequestContact').dispatchEvent(new Event('change'));document.querySelector('#callRequestContactName').value='Alexander Muster';document.querySelector('#callRequestContactName').dispatchEvent(new Event('input'));const d=__t.readCallScriptForm();return {briefing:__t.encodeCallScript(d),script:__t.conversationTemplate(d)}}''')
  assert 'Alexander Muster' in result['script'] and '{terminfrage}' not in result['script'] and 'Termin vereinbaren' not in result['script']
  assert json.loads(result['briefing'].split('\n',1)[1])['contactRequest']['name']=='Alexander Muster'
  row={'id':25,'customer_name':'Muster, Eva','salutation':'Frau','phones':['07361 123456'],'bad_phones':[],'topics':[],'briefing':result['briefing'],'attempts':0,'attempt_log':[],'status':'open','rounds':1,'round_log':[],'branch_id':None,'teams':False,'hold_note':None,'protocol':''}
  api.calls=[row];page.evaluate('async()=>{__t.showPage("telefon");await __t.loadCalls();__t.state.callExpanded.add("25");__t.renderOwnCalls()}')
  card=page.locator('[data-call="25"]');expect(card.locator('[data-call-action="contact_details"]')).to_be_visible();assert card.locator('[data-call-action="R_TA_mT"]').count()==0;assert card.locator('[data-call-action="R_TA_oT"]').count()==0
  card.locator('[data-script-toggle]').click();expect(card.locator('.script-line').first).to_contain_text('Alexander Muster');assert card.locator('[data-script-booking]').count()==0
  card.locator('[data-call-action="contact_details"]').click();page.locator('#contactDetailsSend').click();expect(page.locator('#contactDetailsStatus')).to_contain_text('mindestens')
  page.locator('#contactDetailsPhone').fill('0176 12345678');page.locator('#contactDetailsClose').click();expect(page.locator('#contactDetailsDialog')).not_to_be_visible();assert not api.receipts
  # Last attempt retains contact-only action alongside Not reached; ordinary appointment actions stay hidden.
  page.evaluate('__t.state.finalDial.add("25");__t.finalAnwenden()');expect(page.locator('#finalBar .final-buttons [data-final-kind="R_TA_mT"]')).not_to_be_visible();expect(page.locator('#finalBar .final-buttons [data-final-kind="contact_details"]')).to_be_visible()
  page.locator('#finalBar .final-buttons [data-final-kind="contact_details"]').click();expect(page.locator('#contactDetailsPhone')).to_have_value('0176 12345678');check_width(page)
  page.screenshot(path=f'/tmp/office-contact-details-{width}.png',full_page=True)
  page.locator('#contactDetailsSend').click();expect(page.locator('#contactDetailsDialog')).not_to_be_visible();assert api.receipts==[{'phone':'0176 12345678','email':''}];expect(page.locator('#finalBar')).not_to_be_visible()
  receipt=dict(row,status='R_TA_oT',protocol='Kontaktdaten von Alexander Muster erhalten\nTelefon: 0176 12345678',closed_at='2026-10-25 09:00:00')
  html=page.evaluate('c=>__t.adminCallHtml(c,"returned")',receipt);assert 'Kontaktdaten erhalten' in html;assert 'Kontaktdaten von Alexander Muster erhalten' in html
  # A lost acknowledgement after a stored first day can be retried without duplicating it.
  page.evaluate('__t.planner.open("2026-11-02")');days(page,['2026-11-02','2026-11-04','2026-11-06'],[2,2,2]);api.fail_post=True
  page.locator('#planSaveBtn').click();expect(page.locator('#planStatus')).to_contain_text('erneut speichern');assert len([x for x in api.plans if x['plan_date']>='2026-11-02'])==1
  page.locator('#planSaveBtn').click();expect(page.locator('#planDialog')).not_to_be_visible();assert len([x for x in api.plans if x['plan_date']>='2026-11-02'])==3
  # An old, unplanned task opens as a reviewable week without trapping the user on past dates.
  page.evaluate("__t.state.tasks=[{id:99,weekPlanning:true,weekStart:'2026-10-19',title:'Bitte Folgewoche planen',status:'open',priority:'high',assigned_to:'sasi'}];__t.renderTasks();document.querySelector('#taskOpenList [data-task-action=planWeek]').click()")
  expect(page.locator('#planDialog')).to_be_visible();expect(page.locator('#planDialogClose')).to_be_visible();page.locator('#planDialogClose').click()
  assert not errors+errors2+errors3+errors4,errors+errors2+errors3+errors4
  ctx.close();print(f'PASS {width}: mandatory news, Friday/Saturday deferral, Sunday lock, 5h and 8h reasons, three enabled days, request script and contact-only fifth attempt, receipt')
 browser.close()
server.shutdown()
