# Boss unterschreibt den Gehaltsnachweis direkt im Lohn-Bereich, sobald die Mitarbeiterin unterschrieben hat.
# Alle Clerk- und API-Aufrufe werden lokal abgefangen.
import json,re,threading
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{server.server_port}'
CLERK='''window.Clerk={user:{id:'kim',firstName:'Kim',lastName:'Betcher',primaryEmailAddress:{emailAddress:'kim@example.test'}},session:{getToken:async()=>'local-fixture'},load:async()=>{},mountSignIn:()=>{},mountUserButton:()=>{},addListener:()=>{},signOut:async()=>{}};'''
MONTH='2026-10'
SNAP={'month':MONTH,'monthLabel':'Oktober 2026','employeeName':'Saskia Test','employee':{'full_name':'Saskia Test','zip_city':'89518 Heidenheim'},'employer':{'name':'Kim Betcher','zip_city':'89518 Heidenheim'},'payroll':{'mins':1500,'eligible':20,'gross':519.7,'net':519.7}}
class API:
 def __init__(s):s.slip={'month':MONTH,'snapshot':SNAP,'hash':'h','signatures':{'employee':{'name':'Saskia Test','signed_at':'2026-11-02T10:00:00Z'},'employer':None}};s.signed=[]
 def route(s,route):
  req=route.request;p=urlparse(req.url).path;m=req.method;body=req.post_data_json if req.post_data else {}
  out=[]
  if p=='/me':out={'role':'boss'}
  elif p=='/admin/users':out=[{'clerk_user_id':'sasi','role':'employee','display_name':'Saskia Test','first_name':'Saskia','last_name':'Test','email':'s@example.test'}]
  elif p=='/admin/monthly-closings':out=[{'id':1,'payroll_month':MONTH,'closed_at':'2026-11-02T09:00:00Z','snapshot':SNAP,'work_minutes':1500,'gross':519.7,'net':519.7}]
  elif p=='/admin/payslips' and m=='GET':out=[s.slip]
  elif p=='/admin/payslips/sign':
   s.signed.append(body);s.slip['signatures']['employer']={'name':'Kim Betcher','signed_at':'2026-11-02T12:00:00Z'};out=s.slip
  elif p=='/admin/close-requests':out=[]
  elif p=='/notices/acks':out=[]
  elif p in('/settings','/me/prefs','/admin/employer','/admin/employee-profile','/admin/payroll-settings'):out={}
  elif m!='GET':out={'success':True}
  route.fulfill(status=200,content_type='application/json',body=json.dumps(out))
 def attach(s,ctx):
  def ext(route):
   if 'smartadm-office-api.betcherkimg.workers.dev' in route.request.url:return s.route(route)
   if 'clerk.browser.js' in route.request.url:return route.fulfill(content_type='application/javascript',body=CLERK)
   if route.request.resource_type=='script':return route.fulfill(content_type='application/javascript',body='')
   return route.fulfill(content_type='text/css',body='')
  ctx.route('https://**/*',ext)
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,args=['--no-sandbox']);api=API()
 ctx=b.new_context(viewport={'width':1280,'height':900},locale='de-DE',timezone_id='Europe/Berlin',service_workers='block');api.attach(ctx)
 pg=ctx.new_page();pg.clock.set_fixed_time('2026-11-02T12:00:00+01:00');errors=[];pg.on('pageerror',lambda e:errors.append(str(e)))
 pg.goto(BASE+'/smartadm/office/');pg.wait_for_timeout(1500)
 pg.evaluate("document.querySelector('[data-page=\"lohn\"]')?.click()");pg.wait_for_timeout(300)
 pg.evaluate(f"(()=>{{const i=document.getElementById('payrollMonth');i.value='{MONTH}';i.dispatchEvent(new Event('change',{{bubbles:true}}))}})()");pg.wait_for_timeout(1200)
 btn=pg.locator('#closeAskBtn')
 assert btn.inner_text()=='Unterschreiben',btn.inner_text()
 assert btn.is_enabled()
 assert 'hat unterschrieben' in pg.inner_text('#closeAskStatus')
 btn.click();pg.wait_for_selector('#addendumDialog[open]');assert pg.is_visible('#addendumSignBox')
 note=pg.locator('#signNote').text_content();assert 'bestätige ich die Abrechnung' in note,note
 pad=pg.locator('#addendumDialog canvas').first;bb=pad.bounding_box()
 pg.mouse.move(bb['x']+30,bb['y']+40);pg.mouse.down()
 for i in range(10):pg.mouse.move(bb['x']+40+i*20,bb['y']+30+(i%3)*15,steps=3)
 pg.mouse.up()
 pg.locator('#addendumDialog').get_by_role('button',name=re.compile('Unterschreiben|Unterschrift|Bestätigen',re.I)).last.click()
 pg.wait_for_timeout(800)
 assert len(api.signed)==1 and api.signed[0]['month']==MONTH and api.signed[0]['signature'],api.signed
 assert btn.inner_text()=='Unterschrieben ✓' and not btn.is_enabled(),btn.inner_text()
 assert 'Meine Unterlagen' in pg.inner_text('#closeAskStatus')
 assert not errors,errors
 print('Boss-Gegenzeichnung im Lohn-Bereich: Knopf erscheint nach Saskias Unterschrift, Unterschrift wird gespeichert, danach „Unterschrieben ✓“.')
 b.close()
