# Browser regression: real XLSX parser, mocked authenticated Office and Sales data.
from pathlib import Path
import json
scope={"__file__":str(Path(__file__).with_name('office-browser-flows.py'))}
source=Path(scope['__file__']).read_text().split('with sync_playwright() as pw:')[0]
source=source.replace('xlsxLib};','xlsxLib,openPoolImport,readPoolImport,renderAdminCalls};')
exec(compile(source,scope['__file__'],'exec'),scope)
API=scope['API'];expect=scope['expect']
class HistoryAPI(API):
 def __init__(self):super().__init__();self.fail_history=False;self.history_pages=[]
 def route(self,route):
  req=route.request;p=scope['urlparse'](req.url).path
  contact={'id':42,'customer_name':'Muster, Lena','salutation':'Frau','phones':['07361 123456'],'topics':['zuteilung'],'branch_id':None,'teams':False,'briefing':'','attempts':2,'attempt_log':['2026-10-24 08:00:00'],'round_log':[],'rounds':1,'status':'R_TA_oT','protocol':'Altes Office-Gespräch: Rückruf gewünscht.','archived_at':'2026-10-24 09:00:00'}
  if p=='/admin/contact-history':
   if self.fail_history:return route.fulfill(status=503,content_type='application/json',body='{"error":"Verlauf nicht erreichbar"}')
   after=scope['urlparse'](req.url).query;self.history_pages.append(after)
   if after=='after=0':out={'items':[{'id':1,'source':'call','source_id':42,'event':'existing','recorded_at':'2026-10-24 09:00:00','contact':contact}],'next':1}
   else:out={'items':[{'id':2,'source':'call','source_id':42,'event':'updated','recorded_at':'2026-10-25 09:00:00','contact':dict(contact,protocol='Neuer Office-Vermerk: E-Mail folgt.')}],'next':None}
   return route.fulfill(content_type='application/json',body=json.dumps(out))
  if p=='/s5/pull':return route.fulfill(content_type='application/json',body=json.dumps({'items':[{'s':'auswertung','d':{'kunde':'Lena Muster','datum':'2026-10-20','status':'erledigt','protokoll':'Förderung ausführlich besprochen.\n<img src=x onerror=alert(1)>\nRückruf im November.'}},{'s':'termine','d':{'kunde':'Lena Muster','datum':'2026-11-01','status':'geplant','protokoll':''}}]}))
  return super().route(route)
with scope['sync_playwright']() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in [1280,390]:
  api=HistoryAPI();ctx,page,errors=scope['page_for'](browser,api,width,'2026-10-27T09:00:00Z')
  page.evaluate('''()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());__t.state.role='boss';document.body.dataset.officeRole='boss';__t.openPoolImport()}''')
  data=page.evaluate('''async()=>{const x=await __t.xlsxLib();const b=x.utils.book_new();x.utils.book_append_sheet(b,x.utils.aoa_to_sheet([['Anrede','Vorname','Nachname','Telnr. 1','Ansprachegrund'],['Frau','Lena','Muster','07361 123456','Zuteilung']]),'Kontakte');return Array.from(new Uint8Array(x.write(b,{type:'array',bookType:'xlsx'})))}''')
  page.locator('#poolImportFile').set_input_files({'name':'test.xlsx','mimeType':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','buffer':bytes(data)})
  expect(page.locator('#poolImportStatus')).to_contain_text('1 Zeilen gelesen')
  box=page.locator('[data-pi="0"]');expect(box).not_to_be_checked()
  sales=page.locator('.sales-history');sales.locator('summary').click();expect(sales).to_contain_text('Förderung ausführlich besprochen.');expect(sales).to_contain_text('<img src=x onerror=alert(1)>');assert sales.locator('img').count()==0
  expect(sales).to_contain_text('Kein Gesprächsprotokoll');expect(box).not_to_be_checked()
  history=page.locator('#poolImportRows .contact-history:not(.sales-history)');history.locator('summary').click();expect(history).to_contain_text('Altes Office-Gespräch');expect(history).to_contain_text('Neuer Office-Vermerk');expect(box).not_to_be_checked()
  assert api.history_pages[-2:]==['after=0','after=1'];scope['check_width'](page)
  page.screenshot(path=f'/tmp/office-contact-history-{width}.png',full_page=True)
  api.fail_history=True
  page.evaluate('async()=>{await __t.readPoolImport(new File([new Uint8Array([1])],"test.xlsx"))}')
  expect(page.locator('#poolImportGo')).to_be_disabled();assert page.locator('[data-pi]').count()==0
  assert not errors,errors
  ctx.close()
 browser.close()
scope['server'].shutdown()
print('Contact history / Sales protocols: desktop, mobile, pagination, escaping, selection and failed history checks passed.')
