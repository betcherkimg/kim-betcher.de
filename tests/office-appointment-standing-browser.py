"""Monthly appointment visibility before/after autosave and submission, in real UI with intercepted APIs."""
from pathlib import Path
scope={'__file__':str(Path(__file__).with_name('office-calendar-browser.py'))}
source=Path(scope['__file__']).read_text().split('\nwith sync_playwright() as pw:')[0]
exec(compile(source,scope['__file__'],'exec'),scope)
scope['HOOK']=scope['HOOK'].replace('window.__t={','window.__t={calculatePayroll,renderEmployeeData,refreshEmployeeProgress,refreshOwnProgress,')
expect=scope['expect']
class ProgressAPI(scope['CalendarAPI']):
 def __init__(self):
  super().__init__();self.signed=True;self.acks=['2026-10-27-regeltage-v2'];self.patterns=[{'id':1,'weekdays':[1,3,5],'valid_from':'2026-11-01','kind':'initial'}]
  self.entries=[{'id':1,'work_date':'2026-12-04','regular_slot':'2026-12-04','record_kind':'weekly_allocation','work_minutes':120,'appointments':10,'start_time':'','end_time':'','entry_state':'final','submission_id':1}]
 def route(self,route):
  p=scope['urlparse'](route.request.url).path
  if p=='/admin/entries':return route.fulfill(content_type='application/json',body=scope['json'].dumps(self.entries))
  return super().route(route)
with scope['sync_playwright']() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in [390,1280]:
  api=ProgressAPI();ctx,page,errors=scope['page_for'](browser,api,width,'2026-12-11T10:00:00Z')
  page.wait_for_load_state('networkidle')
  page.evaluate("()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());__t.showPage('zeiten')}")
  card=page.locator('#zeiten [data-own-appointment-standing]');expect(card).to_contain_text('10');expect(card).to_contain_text('Bestätigt')
  for day,count in [('2026-12-07',4),('2026-12-09',3),('2026-12-11',2)]:
   page.locator(f'[data-slot-hours="{day}"]').fill('2:00');page.locator(f'[data-slot-appts="{day}"]').fill(str(count));page.locator(f'[data-slot-note="{day}"]').fill('Test')
  expect(card).to_contain_text('10 bestätigt + 9 vorläufig');expect(page.locator('#regularSummary')).to_contain_text('9 Termine')
  assert sum(e['appointments'] for e in api.entries)==19
  # Employer sees the same provisional total before submission, including its start-page widget.
  page.evaluate("()=>{__t.state.role='boss';__t.state.selectedUserId='sasi';document.body.dataset.officeRole='boss';__t.state.employeeDataError=false;document.getElementById('payrollMonth').value='2026-12';__t.state.employees=[{clerk_user_id:'sasi',display_name:'Saskia Test'}];__t.showPage('einsatz')}")
  page.evaluate('async()=>{await __t.refreshEmployeeProgress()}')
  expect(page.locator('#einsatz [data-boss-appointment-standing]')).to_contain_text('10 bestätigt + 9 vorläufig')
  expect(page.locator('#bossEmpAppointments')).to_have_text('19')
  assert page.evaluate("__t.calculatePayroll(__t.state.employeeEntries,{},'2026-12').appts")==10, 'Draft visibility must not silently turn drafts into payable confirmed commissions'
  page.screenshot(path=f'/workspace/scratch/appointment-boss-{width}.png',full_page=True)
  page.evaluate("()=>{__t.showPage('boss-dashboard')}")
  expect(page.locator('[data-widget-appts]')).to_have_text('19')
  expect(page.locator('[data-widget="mitarbeiter"]')).to_contain_text('vorläufig')
  page.evaluate("()=>{__t.state.role='employee';document.body.dataset.officeRole='employee';__t.showPage('zeiten')}")
  page.once('dialog',lambda dialog:dialog.accept());page.locator('#regularComplete').click()
  expect(card).to_contain_text('Bestätigt');expect(card).not_to_contain_text('vorläufig');expect(card).to_contain_text('19')
  assert sum(e['appointments'] for e in api.entries)==19
  # A new unsubmitted record makes the monthly total provisional again.
  api.entries.append({'id':9,'work_date':'2026-12-14','record_kind':'weekly_allocation','work_minutes':60,'appointments':2,'entry_state':'draft'})
  page.evaluate('async()=>{await __t.refreshOwnProgress()}');expect(card).to_contain_text('19 bestätigt + 2 vorläufig')
  scope['check_width'](page);assert not errors,errors
  ctx.close()
 browser.close()
scope['server'].shutdown()
print('Appointment progress passed on mobile/desktop: autosave, employee and boss totals, submission without duplication, new drafts.')
