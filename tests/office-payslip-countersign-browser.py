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
 def __init__(s):s.slip={'month':MONTH,'snapshot':SNAP,'hash':'h','signatures':{'employee':{'name':'Saskia Test','signed_at':'2026-11-02T10:00:00Z'},'employer':None}};s.signed=[];s.reports=[];s.saved=None
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
  elif p=='/admin/contribution-reports' and m=='PUT':
   s.reports.append(body)
   out={'id':1,'payroll_month':body['month'],'estimated_gross':body['estimated_gross'],'reported_total':sum(body['portal_fields'].values())/100,
        'status':body['status'],'submitted_at':body.get('submitted_date'),'paid_at':body.get('paid_date'),'note':body.get('note',''),
        'snapshot':{'submissionConfirmation':{'confirmedBy':'kim'} if body['status']!='draft' else None,'portalFields':body['portal_fields'],'baseFields':body['portal_fields'],'priorFields':{},'profile':{}}}
   s.saved=out
  elif p=='/admin/contribution-reports':out=[s.saved] if s.saved else []
  elif p=='/notices/acks':out=[]
  elif p=='/admin/employee-profile':out={'clerk_user_id':'sasi','start_date':'2026-10-01'}
  elif p in('/settings','/me/prefs','/admin/employer','/admin/payroll-settings'):out={}
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
 card=pg.locator('#monthFlow')
 assert card.is_visible() and 'Oktober 2026 · Saskia' in pg.inner_text('#mfTitle')
 assert not pg.is_visible('.lohn-tabs'),'Details sollen standardmäßig zu sein'
 # Beschäftigungsjahr: 3 × 603 € (2026) + 9 × 633 € (2027) = 7.506 €
 assert pg.is_visible('#mfYear'),'Jahresbox fehlt'
 assert '1. Beschäftigungsjahr · 10/2026–09/2027' in pg.inner_text('#mfYearTitle'),pg.inner_text('#mfYearTitle')
 T=lambda sel:pg.inner_text(sel).replace('\xa0',' ')
 assert T('#mfYearLimit')=='7.506,00 €',pg.inner_text('#mfYearLimit')
 assert T('#mfYearEarned')=='519,70 €',pg.inner_text('#mfYearEarned')
 assert T('#mfYearRest')=='6.986,30 €',pg.inner_text('#mfYearRest')
 hint=T('#mfYearHint');assert '11 Monate offen' in hint and '635,11 €' in hint and '14,60 €' in hint,hint
 steps=pg.locator('.mf-step')
 assert steps.count()==4,steps.count()
 assert 'hat unterschrieben – jetzt du' in steps.nth(3).inner_text()
 # 1) Beitragsnachweis melden
 pg.locator('[data-mf="report"]').click();pg.wait_for_selector('#mfReportDialog[open]')
 assert 'Summe' in pg.inner_text('#mfReportValues') and '6000' in pg.inner_text('#mfReportValues')
 pg.locator('#mfReportSave').click();pg.wait_for_timeout(300)
 assert 'bestätigen' in pg.inner_text('#mfReportStatus') and not api.reports
 pg.check('#mfSubmittedCheck');pg.locator('#mfReportSave').click();pg.wait_for_timeout(800)
 assert len(api.reports)==1 and api.reports[0]['status']=='submitted' and api.reports[0]['submission_confirmed'] is True,api.reports
 assert not pg.is_visible('#mfReportDialog')
 assert 'is-done' in steps.nth(0).get_attribute('class')
 # 2) bezahlt
 pg.locator('[data-mf="paid"]').click();pg.wait_for_timeout(800)
 assert api.reports[-1]['status']=='paid' and api.reports[-1]['paid_date']=='2026-11-02',api.reports[-1]
 assert 'is-done' in steps.nth(1).get_attribute('class')
 # 3) PDF Beitragsnachweis
 with pg.expect_download() as dl:pg.locator('#mfContribPdf').click()
 d=dl.value;assert d.suggested_filename=='Beitragsnachweis_2026-10.pdf',d.suggested_filename
 data=Path(d.path()).read_bytes();assert data[:4]==b'%PDF' and len(data)>3000,len(data)
 # 4) gegenzeichnen
 pg.locator('[data-mf="sign"]').click();pg.wait_for_selector('#addendumDialog[open]');assert pg.is_visible('#addendumSignBox')
 note=pg.locator('#signNote').text_content();assert 'bestätige ich die Abrechnung' in note,note
 pad=pg.locator('#addendumDialog canvas').first;bb=pad.bounding_box()
 pg.mouse.move(bb['x']+30,bb['y']+40);pg.mouse.down()
 for i in range(10):pg.mouse.move(bb['x']+40+i*20,bb['y']+30+(i%3)*15,steps=3)
 pg.mouse.up()
 pg.locator('#addendumDialog').get_by_role('button',name=re.compile('Unterschreiben|Unterschrift|Bestätigen',re.I)).last.click()
 pg.wait_for_timeout(800)
 assert len(api.signed)==1 and api.signed[0]['month']==MONTH and api.signed[0]['signature'],api.signed
 assert 'is-done' in steps.nth(3).get_attribute('class') and 'Meine Unterlagen' in steps.nth(3).inner_text()
 assert pg.locator('#closeAskBtn').inner_text()=='Unterschrieben ✓'
 # Details auf Wunsch
 pg.locator('#mfDetailsBtn').click();assert pg.is_visible('.lohn-tabs') and pg.inner_text('#mfDetailsBtn')=='Details ausblenden'
 pg.locator('#mfDetailsBtn').click();assert not pg.is_visible('.lohn-tabs')
 assert not errors,errors
 print('Monatskarte: melden, bezahlt, Beitragsnachweis-PDF, gegenzeichnen und Details funktionieren.')
 b.close()
