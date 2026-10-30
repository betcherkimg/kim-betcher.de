"""Signature capture and admin flow; all external authentication/mail APIs mocked."""
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from threading import Thread
import json
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
CODE='1'*49
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
 def log_message(self,*a):pass
 def send_error(self,code,message=None,explain=None):
  if code==404:
   self.send_response(404);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write((ROOT/'404.html').read_bytes())
  else:super().send_error(code,message,explain)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);Thread(target=server.serve_forever,daemon=True).start();BASE=f'http://127.0.0.1:{server.server_port}'
CLERK="""window.Clerk={session:{id:'test',getToken:async()=> 'mock'},user:{id:'owner'},load:async()=>{},mountUserButton:()=>{},mountSignIn:()=>{},addListener:()=>{}};"""
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in [390,1280]:
  state={'sent':False,'pending':False,'fail':True,'posts':[],'admin':[]};errors=[]
  ctx=browser.new_context(viewport={'width':width,'height':900},is_mobile=width==390,has_touch=True,service_workers='block')
  def external(route):
   req=route.request;url=req.url
   if 'clerk.browser.js' in url:return route.fulfill(content_type='application/javascript',body=CLERK)
   if 'ui.browser.js' in url:return route.fulfill(content_type='application/javascript',body='')
   if '/admin/signatures' in url:
    if req.method=='POST':state['admin'].append(req.post_data_json);data={'url':f'{BASE}/unterschriften/{CODE}','expires_at':'2026-11-06T12:00:00Z','id':1}
    else:data=[]
    return route.fulfill(content_type='application/json',body=json.dumps(data))
   if '/public/signatures/' in url:
    if req.method=='POST':
     state['posts'].append(req.post_data_json);state['pending']=True
     if state['fail']:return route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Mailversand hat noch nicht geklappt.'}))
     state['sent']=True;state['pending']=False;data={'sent':True}
    else:data={'customer_name':'Lena Muster','purpose':'Bausparantrag vom 30.10.2026 · Referenz 123','sent':state['sent'],'pending':state['pending']}
    return route.fulfill(content_type='application/json',body=json.dumps(data))
   return route.abort()
  ctx.route('https://**/*',external)
  page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(BASE+'/unterschriften/admin/');expect(page.locator('#app')).to_be_visible()
  page.locator('[name=customer_name]').fill('Lena Muster');page.locator('[name=purpose]').fill('Bausparantrag vom 30.10.2026 · Referenz 123');page.locator('#createButton').click();expect(page.locator('#result')).to_be_visible();assert len(state['admin'])==1
  page.goto(BASE+'/unterschriften/'+CODE);expect(page.locator('#form')).to_be_visible();assert page.url==BASE+'/unterschriften/'+CODE
  expect(page.locator('#send')).to_be_disabled();page.locator('#consent').check();expect(page.locator('#send')).to_be_disabled()
  box=page.locator('#signature').bounding_box();x=box['x']+25;y=box['y']+90
  # Trusted touch events exercise finger drawing and pointer capture, not just synthetic DOM events.
  touch=ctx.new_cdp_session(page)
  touch.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
  for dx,dy in [(30,-40),(45,40),(80,-25),(120,10),(160,-10)]:touch.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+dx,'y':y+dy}]})
  touch.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
  expect(page.locator('#send')).to_be_enabled()
  assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
  page.screenshot(path=f'/workspace/scratch/signature-{width}.png',full_page=True)
  before=page.locator('#signature').evaluate("c=>c.toDataURL()")
  page.set_viewport_size({'width':width-10,'height':800});assert page.locator('#signature').evaluate('c=>c.toDataURL()')==before
  page.locator('#send').click();expect(page.locator('#pending')).to_be_visible();assert state['posts'][0]['png'].startswith('data:image/png;base64,');assert state['posts'][0]['confirmed'] is True
  state['fail']=False;page.locator('#send').click();expect(page.locator('#done')).to_be_visible();assert 'png' not in state['posts'][1]
  page.reload();expect(page.locator('#done')).to_be_visible();expect(page.locator('#form')).not_to_be_visible()
  # A signature saved during a previous failed request can be retried after reopening the link.
  state['sent']=False;state['pending']=True;page.reload();expect(page.locator('#pending')).to_be_visible();expect(page.locator('#send')).to_be_enabled()
  assert not errors,errors
  ctx.close()
 browser.close()
server.shutdown()
print('Signature browser checks passed: admin, numeric link routing, touch, blank prevention, resize preservation, failure/retry and sent state on mobile/desktop.')
