/* Office calendar: shared schedule, explicit absence decisions, no parallel time ledger. */
(function(root){'use strict';
const labels={requested:'Beantragt',approved:'Genehmigt',rejected:'Abgelehnt',withdrawn:'Zurückgezogen',cancelled:'Storniert',cancellation_requested:'Stornierung angefragt'};
const kindLabel=k=>k==='holiday'?'Feiertagsausfall':k==='vacation'?'Urlaub':k==='sick'?'Krankheit':'Bezahlte Freistellung';
const add=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const monday=d=>add(d,-((new Date(d+'T12:00Z').getUTCDay()+6)%7));
const amount=v=>Math.round(Number(String(v||'').replace(',','.'))*100);
function create(b){
 const {$,esc,api,state}=b;let data=null,month=b.today().slice(0,7),selected=b.today(),mode='month',generation=0,review=null;
 let pickerMonth=month,pickerDays=new Set(),pickerCache=new Map(),pickerGeneration=0,pickerBusy=false,pickerSending=false;
 const boss=()=>state.role==='boss',owner=()=>boss()?state.selectedUserId:state.bootstrappedFor;
 const path=p=>boss()?'/admin'+p+'?user_id='+encodeURIComponent(owner()):p;
 const fmt=d=>new Date(d+'T12:00Z').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});
 const euro=c=>Number(c/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'});
 const days=n=>Number(n).toLocaleString('de-DE',{maximumFractionDigits:2})+' Tage';
 function status(text,error=false){$('calendarStatus').textContent=text||'';$('calendarStatus').classList.toggle('warn',error);}
 async function load(){
  const run=++generation,id=owner();if(!id){data=null;render();return;}
  status('Kalender wird geladen …');
  try{const result=await api(path('/calendar')+(boss()?'&':'?')+'month='+month);if(run!==generation||owner()!==id)return;
   if(!Array.isArray(result.accounts)||!Array.isArray(result.plans))throw Error('Kalenderdaten sind unvollständig. Bitte neu laden.');
   data=result;pickerCache.clear();state.calendarData=result;state.calendarDataOwner=id;state.payRates=result.rates||state.payRates;state.payrollYears=result.payrollYears||state.payrollYears;
   b.onAccounts?.(result,id);render();status('');
  }catch(error){if(run!==generation)return;data=null;render();status(error.message,true);}
 }
 function events(date){if(!data)return [];
  const out=[],holiday=data.holidays.find(h=>h.date===date);if(holiday)out.push({kind:'holiday',label:holiday.name});
  const absence=data.absences.find(a=>a.absence_date===date);
  if(absence)out.push({kind:absence.absence_type,label:kindLabel(absence.absence_type)+' · '+b.minutes(absence.paid_minutes)});
  const auto=data.regularHolidays?.find(h=>h.date===date);if(auto&&!absence){const existing=out.find(e=>e.kind==='holiday');if(existing)existing.label+=' · 2 h gutgeschrieben';else out.push({kind:'holiday',label:'Feiertag · 2 h gutgeschrieben'});}
  const ptn=regular(date);if(ptn&&ptn.weekdays.includes(new Date(date+'T12:00Z').getUTCDay())&&!holiday&&!absence)out.push({kind:'plan',label:'Regeltag · 2 h'});
  for(const p of data.plans.filter(p=>p.plan_date===date&&p.status!=='cancelled')){
   if(!absence)out.push({kind:holiday?'review':'plan',label:holiday?'Soll-Einsatz · Anspruch prüfen':p.start_time+' · '+b.minutes(p.minutes)});
  }
  const work=data.work.find(w=>w.work_date===date);if(work)out.push({kind:'work',label:(work.record_kind==='weekly_allocation'?'Wochenzuordnung · ':'Erfasst · ')+b.minutes(work.minutes)});
  for(const r of data.requests.filter(r=>['requested','cancellation_requested'].includes(r.status)&&r.dates.includes(date)))out.push({kind:'pending',label:kindLabel(r.kind)+' · '+labels[r.status]});
  return out;
 }
 function regular(date){return (data?.patterns||[]).filter(p=>p.valid_from&&p.valid_from<=date).sort((a,b)=>a.valid_from.localeCompare(b.valid_from)||a.id-b.id).at(-1);}
 function render(){
  $('calendarMonth').value=month;$('calendarOwnerField').hidden=!boss();$('calendarEmployeeActions').hidden=boss();$('calendarSettings').hidden=!boss();
  if(boss())$('calendarOwner').innerHTML=b.employeeOptions();
  if(boss()&&owner())$('calendarOwner').value=owner();
  $('calendarGrid').classList.toggle('week-mode',mode==='week');
  $('calendarViewMonth').setAttribute('aria-pressed',String(mode==='month'));$('calendarViewWeek').setAttribute('aria-pressed',String(mode==='week'));
  if(!data){$('calendarGrid').innerHTML='<p class="calendar-empty">'+esc(owner()?'Kalender derzeit nicht verfügbar.':'Bitte einen Mitarbeiter auswählen.')+'</p>';$('calendarAccount').innerHTML='';$('calendarRequests').innerHTML='';$('calendarDayDetails').innerHTML='';return;}
  const year=Number(month.slice(0,4)),account=data.accounts.find(a=>a.year===year);
  $('calendarAccount').innerHTML=account?`<div class="vacation-balance"><div class="vacation-balance-main"><span><span class="vacation-eyebrow">URLAUB ${year}</span>Verfügbar heute</span><strong>${esc(Number(Math.round((account.remaining-account.reserved)*100)/100).toLocaleString('de-DE',{maximumFractionDigits:2}))} <small>Tage</small></strong></div><div class="vacation-balance-stats"><div><span>Bis Jahresende planbar</span><b>${esc(days(account.planningRemaining))}</b></div><div><span>Genehmigt</span><b>${esc(days(account.approved))}</b></div><div><span>Beantragt</span><b>${esc(days(account.reserved))}</b></div></div></div><details class="vacation-account-notes"><summary>Wie setzt sich das zusammen?</summary><p class="calendar-hint">Jahresanspruch voraussichtlich ${esc(days(account.annualProjected??account.projected))}${account.carried?' plus '+esc(days(account.carried))+' automatisch übernommener Resturlaub':''}, abzüglich genehmigter Tage und offener Anträge. Bereits erworbener Anspruch: ${esc(days(account.entitlement))}; davon aktuell noch ${esc(days(account.remaining))} übrig. ${account.provisional?'Der Altbestand vor dem neuen Nachtrag ist vorläufig und wird von Kim geprüft.':''} ${b.today()<=account.waitingEnd?'Wartezeit bis '+fmt(account.waitingEnd)+'. Für Urlaub vor Ablauf muss Kim ausdrücklich zustimmen.':''}</p></details>`:'';
  if(account?.carryover?.length)$('calendarAccount').innerHTML+=`<p class="calendar-hint">Automatisch übernommen: ${esc(days(account.carried))} aus früheren Jahren. ${account.carryover.map(c=>esc(c.year+': '+days(c.remaining)+' noch offen')).join(' · ')}. Ältester Resturlaub wird zuerst verwendet.</p>`;
  $('calendarTransfer').hidden=true;
  const start=mode==='week'?monday(selected):monday(month+'-01');
  const last=new Date(Date.UTC(year,Number(month.slice(5)),0)).toISOString().slice(0,10);const count=mode==='week'?7:Math.ceil(((Date.parse(last)-Date.parse(start))/86400000+1)/7)*7;
  $('calendarGrid').innerHTML=['Mo','Di','Mi','Do','Fr','Sa','So'].map(d=>`<span class="calendar-weekday">${d}</span>`).join('')+Array.from({length:count},(_,i)=>{
   const date=add(start,i),es=events(date),day=Number(date.slice(-2)),other=date.slice(0,7)!==month;
   return `<button class="calendar-day${other?' other-month':''}${date===selected?' selected':''}${date===b.today()?' today':''}" type="button" data-cal-date="${date}" aria-pressed="${date===selected}" aria-label="${esc(fmt(date)+' '+es.map(e=>e.label).join(', '))}"><span class="calendar-date">${day}${mode==='week'?'<small>'+fmt(date).slice(3,5)+'.</small>':''}</span>${es.slice(0,3).map(e=>`<span class="calendar-event ${e.kind}" title="${esc(e.label)}">${esc(mode==='week'?e.label:({plan:'2 h',work:e.label.replace('Erfasst · ',''),holiday:'Feiertag',vacation:'Urlaub',pending:'Beantragt',sick:'Krank',paid_leave:'Frei'}[e.kind]||e.label))}</span>`).join('')}${es.length>3?'<small>+'+(es.length-3)+'</small>':''}</button>`;
  }).join('');
  renderDay();renderRequests();renderRegular();
  $('calendarRegion').value=data.region;$('calendarRegionFrom').min=b.today();if(!$('calendarRegionFrom').value)$('calendarRegionFrom').value=b.today();$('calendarRateYear').value=year;$('calendarRate').value=((data.rates||[]).find(r=>r.year===year)?.rate/100||'');
  $('calendarSettingsNote').textContent=[data.rateReview,data.regionalNote].filter(Boolean).join(' ');
  $('calendarAdjustmentYear').value=year;fillYearRules(year);
 }
 function fillYearRules(year){const yr=(data?.payrollYears||[]).find(r=>r.year===Number(year))||{};for(const el of document.querySelectorAll('[data-year-rule]')){const value=yr[el.dataset.yearRule];el.value=value===undefined?'':String(['limit','rvMinBase'].includes(el.dataset.yearRule)?value/100:value*100).replace('.',',');}}
 function renderDay(){
  const es=events(selected),ps=data.plans.filter(p=>p.plan_date===selected),history=data.history.filter(h=>h.snapshot?.plan_date===selected),holiday=data.holidays.find(h=>h.date===selected);
  $('calendarDayDetails').innerHTML=`<div class="card-head"><h3>${esc(fmt(selected))}</h3><p>${es.length?es.map(e=>esc(e.label)).join(' · '):'Keine Einträge.'}</p></div>${ps.map(p=>`<p>${esc(p.start_time)} · ${esc(b.minutes(p.minutes))} · ${esc({planned:'Geplant',started:'Begonnen',missed:'Ohne Aktivität',cancelled:'Abgesagt',late:'Verspätet begonnen'}[p.status]||p.status)}${p.cancel_reason?' · '+esc(p.cancel_reason):''}</p>`).join('')}
   ${!boss()?`<div class="btn-row"><button class="btn ghost" type="button" data-cal-regular>Zur Arbeitswoche</button>${!leaveBlocked(selected,'vacation',data)?'<button class="btn primary" type="button" data-cal-vacation>Für diesen Tag Urlaub beantragen</button>':''}</div>${leaveBlocked(selected,'vacation',data)?'<p class="calendar-hint">Kein Urlaub auswählbar: '+esc(leaveBlocked(selected,'vacation',data))+'.</p>':''}`:''}
   ${holiday?'<p class="calendar-hint">'+(regular(selected)?'Feiertag auf einem gültigen Regeltag: 2 Stunden Gutschrift, kein Urlaubstag und keine Nacharbeit. Auf einem anderen Wochentag gibt es keine zusätzliche Gutschrift.':'Für die Zeit vor der neuen Regelverteilung prüft Kim die damalige Grundlage des Feiertagsausfalls.')+'</p>':''}
   ${history.length?`<details class="contact-history"><summary>Planungsverlauf (${history.length})</summary>${history.map(h=>`<article><b>${esc(b.timestamp(h.created_at))}</b><p>${esc(h.event==='existing'?'Übernommener Planungsstand':h.event==='removed'?'Plan entfernt':h.event==='created'?'Einsatz eingetragen':'Plan geändert')} · ${esc(h.snapshot.plan_date)} ${esc(h.snapshot.start_time)} · ${esc(h.snapshot.status)}</p>${h.snapshot.note?'<small>'+esc(h.snapshot.note)+'</small>':''}</article>`).join('')}</details>`:''}`;
 }
 async function renderRegular(){
  const names=['So','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Sa'];
  const patterns=data.patterns||[];
  $('calendarPatterns').innerHTML=patterns.length?patterns.map(p=>`<p><b>${p.weekdays.map(d=>esc(names[d])).join(' · ')}</b> · jeweils 2 Stunden<br><small>Erklärt am ${esc(b.timestamp(p.created_at))} · ${p.valid_from?'gültig ab '+esc(fmt(p.valid_from)):'wartet auf beide Unterschriften'}</small></p>`).join(''):'<p>Noch keine neue Regelverteilung erklärt.</p>';
  if(!boss()){$('calendarRegularHolidays').innerHTML=(data.regularHolidays||[]).map(h=>`<p>${esc(fmt(h.date))} · ${esc(h.name)} · 2 Stunden gutgeschrieben${h.status==='calculated'?' · Vergütung wird von Kim geprüft':''}</p>`).join('');return;}
  const requestedMonth=month,requestedOwner=owner();
  try{
   const rows=await api(path('/regular-holidays')+'&month='+month);if(requestedMonth!==month||requestedOwner!==owner())return;
   $('calendarRegularHolidays').innerHTML=rows.length?rows.map(h=>{
    const stale=h.status==='approved'&&JSON.stringify(h.quote)!==JSON.stringify(h.snapshot?.quote),state=h.status==='calculated'?'Vergütung noch prüfen':h.status==='unpaid'?'Entgelt nach dokumentierter Prüfung nicht geschuldet':stale?'Berechnung geändert – erneut prüfen':'Vergütung freigegeben';
    return `<form class="regular-holiday" data-holiday-id="${h.id}" data-holiday-revision="${h.revision}"><b>${esc(fmt(h.date))} · ${esc(h.name)}</b><p>2 Stunden Gutschrift · ${esc(state)}</p><p class="calendar-hint">Grundlohn ${esc(euro(h.quote.base_cents))} + Provisionsschätzung ${esc(euro(h.quote.variable_cents))}. Grundlage ${esc(fmt(h.quote.from))}–${esc(fmt(h.quote.to))}: ${esc(b.minutes(h.quote.reference_minutes))}, ${h.quote.reference_appointments} Termine.${h.quote.provisional?' Vorläufig: Der Feiertagsmonat ist noch nicht beendet.':''}${h.quote.emptyReference?' Keine Referenzstunden vorhanden: angemessenen Provisionsausfall gesondert prüfen.':''}</p>${h.closed?'<p>Abgeschlossener Monat – gespeichert und unverändert.</p>':`<label>Geprüfte volle Bruttovergütung in €<input data-holiday-amount type="text" inputmode="decimal" required value="${Number((stale||h.status==='calculated'?h.quote.suggested_cents:h.amount_cents)/100).toFixed(2).replace('.',',')}"></label><label>Berechnungsgrundlage / Grund<textarea data-holiday-note required maxlength="1000">${esc(h.note||'')}</textarea></label><label class="check-row"><input data-holiday-confirm type="checkbox" required><span>Grundlohn und vollständigen variablen Lohnausfall geprüft.</span></label><details><summary>Sonderfall: unentschuldigtes Fehlen unmittelbar vor / nach dem Feiertag</summary><label class="check-row"><input data-holiday-unpaid type="checkbox"><span>Den gesetzlichen Entgeltausfall nach § 2 Abs. 3 EFZG habe ich anhand der angrenzenden tatsächlichen Arbeitstage geprüft und oben begründet. Die Stundengutschrift bleibt bestehen.</span></label></details><button class="btn primary" type="submit">Feiertagsvergütung bestätigen</button><p class="status-text" data-holiday-status aria-live="polite"></p>`}</form>`;
   }).join(''):'<p>In diesem Monat liegt kein Feiertag auf einem gültigen Regeltag.</p>';
  }catch(error){$('calendarRegularHolidays').textContent='Feiertagsvergütung konnte nicht geladen werden: '+error.message;}
 }
 function renderRequests(){
  const cards=data.requests.map(r=>{
   const approved=['approved','cancellation_requested'].includes(r.status),total=(r.snapshot?.days||[]).reduce((n,d)=>n+d.amount_cents,0);
   return `<article class="leave-request"><div><b>${esc(kindLabel(r.kind))} · ${esc(fmt(r.from_date))}${r.from_date!==r.to_date?' – '+esc(fmt(r.to_date)):''}</b><span class="chip ${r.status==='requested'?'warn':approved?'good':''}">${esc(labels[r.status]||r.status)}</span></div><small>${r.dates.length} Soll-Arbeitstag(e) · Antrag ${esc(b.timestamp(r.created_at))}</small>${r.note?'<p>'+esc(r.note)+'</p>':''}${r.decision_note?'<p><b>Entscheidung:</b> '+esc(r.decision_note)+'</p>':''}${approved?'<p>'+esc(euro(total))+' brutto · '+(r.paid_at?'Zahlung erfasst: '+esc(fmt(r.paid_at)):'Zahlung noch nicht als ausgeführt erfasst')+'</p>':''}
    <div class="btn-row">${boss()&&['requested','approved','cancellation_requested'].includes(r.status)?`<button class="btn primary" type="button" data-cal-review="${r.id}">${r.status==='requested'?'Prüfen & entscheiden':'Details / Zahlung / Korrektur'}</button>`:''}${!boss()&&['requested','approved'].includes(r.status)?`<button class="btn ghost" type="button" data-cal-withdraw="${r.id}">${r.status==='requested'?'Antrag zurückziehen':'Stornierung anfragen'}</button>`:''}</div>
    <details class="contact-history"><summary>Verlauf ansehen</summary>${data.audit.filter(a=>a.request_id===r.id).map(a=>`<p>${esc(b.timestamp(a.created_at))} · ${esc({requested:'Antrag gestellt',approved:'Genehmigt',rejected:'Abgelehnt',withdrawn:'Zurückgezogen',cancelled:'Storniert',cancellation_requested:'Stornierung angefragt',paid:'Zahlung erfasst',illness_correction:'AU-Korrektur'}[a.event]||a.event)} · ${a.actor===data.job.clerk_user_id?'Mitarbeiter':'Office'}</p>`).join('')||'<p>Noch keine weiteren Einträge.</p>'}</details></article>`;
  });
  const current=[],archive=[];data.requests.forEach((r,i)=>(['rejected','withdrawn','cancelled'].includes(r.status)||r.to_date<b.today()&&r.status==='approved'?archive:current).push(cards[i]));
  $('calendarRequests').innerHTML=(current.join('')||'<div class="calendar-request-empty"><b>Alles im Blick</b>Aktuell gibt es keine offenen oder bevorstehenden Anträge.</div>')+(archive.length?'<details class="calendar-request-archive"><summary>Frühere Anträge ('+archive.length+')</summary>'+archive.join('')+'</details>':'');
 }
 function leaveBlocked(date,kind='vacation',source=data){
  if(!source)return 'Kalender wird geladen';
  const weekday=new Date(date+'T12:00Z').getUTCDay(),holiday=source.holidays.find(h=>h.date===date);
  const ptn=(source.patterns||[]).filter(p=>p.valid_from&&p.valid_from<=date).sort((a,b)=>a.valid_from.localeCompare(b.valid_from)||a.id-b.id).at(-1);
  if(kind==='vacation'&&date<b.today())return 'Vergangen';
  if(date<source.job.start_date||source.job.end_date&&date>source.job.end_date)return 'Außerhalb des Arbeitsverhältnisses';
  if(![1,2,3,4,5].includes(weekday))return 'Wochenende';
  if(kind==='vacation'&&holiday)return holiday.name;
  if(kind==='vacation'&&ptn&&!ptn.weekdays.includes(weekday))return 'Kein Regeltag';
  if(kind==='holiday'&&!holiday)return 'Kein Feiertag';
  if(kind==='holiday'&&ptn)return 'Feiertag wird automatisch gutgeschrieben';
  if(source.closedMonths?.includes(date.slice(0,7)))return 'Monat abgeschlossen';
  if(source.work.some(w=>w.work_date===date))return 'Arbeitszeit vorhanden';
  const absence=source.absences.find(a=>a.absence_date===date);if(absence)return kindLabel(absence.absence_type)+' eingetragen';
  const request=source.requests.find(r=>['requested','approved','cancellation_requested'].includes(r.status)&&r.dates.includes(date));if(request)return request.status==='requested'?'Bereits beantragt':'Bereits genehmigt';
  return '';
 }
 async function pickerSource(value){
  if(pickerCache.has(value))return pickerCache.get(value);
  const id=owner(),result=await api(path('/calendar')+(boss()?'&':'?')+'month='+value);
  if(id!==owner())throw Error('Mitarbeiter wurde gewechselt. Bitte den Antrag neu öffnen.');
  pickerCache.set(value,result);return result;
 }
 function pickerSummary(){
  const dates=[...pickerDays].sort(),kind=$('leaveKind').value;
  $('leaveRequestSend').disabled=pickerBusy||pickerSending||!dates.length||dates.length>60;
  $('leaveRequestSend').textContent=dates.length?`${dates.length} ${dates.length===1?'Tag':'Tage'} beantragen`:'Antrag absenden';
  const accounts=[...pickerCache.values()].flatMap(x=>x.accounts||[]);
  const years=[...new Set(dates.map(d=>Number(d.slice(0,4))))];
  const info=years.map(year=>{const account=accounts.find(a=>a.year===year),n=dates.filter(d=>Number(d.slice(0,4))===year).length;
   return account?`${year}: ${days(Math.round((account.planningRemaining-n)*100)/100)} danach voraussichtlich noch planbar.${n>account.remaining-account.reserved?' Für diesen Antrag muss Kim einen Vorgriff auf den Urlaubsanspruch prüfen.':''}`:'';
  }).filter(Boolean).join(' ');
  $('leaveSelectionSummary').innerHTML=`<strong>${dates.length?dates.length+' '+(dates.length===1?'Tag ausgewählt':'Tage ausgewählt'):'Noch keine Tage ausgewählt'}</strong>${dates.length?'<span>'+esc(fmt(dates[0]))+(dates.length>1?' – '+esc(fmt(dates.at(-1))):'')+'</span>':'<span>Wähle deine gewünschten Arbeitstage oben im Kalender.</span>'}${dates.length?'<div class="leave-selection-dates">'+dates.map(d=>`<button type="button" data-leave-remove="${d}" aria-label="${esc(fmt(d))} abwählen">${esc(new Date(d+'T12:00Z').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}))} ×</button>`).join('')+'</div>':''}${kind==='vacation'&&info?'<p>'+esc(info)+'</p>':''}${dates.length>60?'<p>Bitte höchstens 60 Urlaubstage pro Antrag auswählen.</p>':''}`;
 }
 function renderPicker(){
  const source=pickerCache.get(pickerMonth),kind=$('leaveKind').value,start=monday(pickerMonth+'-01'),last=new Date(Date.UTC(Number(pickerMonth.slice(0,4)),Number(pickerMonth.slice(5)),0)).toISOString().slice(0,10),count=Math.ceil(((Date.parse(last)-Date.parse(start))/86400000+1)/7)*7;
  $('leavePickerMonth').textContent=new Date(pickerMonth+'-01T12:00Z').toLocaleDateString('de-DE',{month:'long',year:'numeric'});
  const account=source?.accounts.find(a=>a.year===Number(pickerMonth.slice(0,4)));
  $('leaveBalance').textContent=account?`${days(account.planningRemaining)} für ${account.year} noch planbar · genehmigte und beantragte Tage sind bereits abgezogen.`:source?'Urlaubskonto für dieses Jahr mit Kim klären.':'Dein Urlaubskonto wird geladen …';
  $('leaveDateChoices').innerHTML=['Mo','Di','Mi','Do','Fr','Sa','So'].map(d=>`<span class="calendar-weekday">${d}</span>`).join('')+Array.from({length:count},(_,i)=>{
   const date=add(start,i),other=date.slice(0,7)!==pickerMonth,reason=other?'Anderer Monat':leaveBlocked(date,kind,source),holiday=source?.holidays.find(h=>h.date===date),label=holiday?'Feiertag':reason==='Kein Regeltag'?'Frei':reason==='Bereits beantragt'?'Antrag':reason==='Bereits genehmigt'?'Urlaub':'';
   return `<label class="leave-date-choice${other?' other-month':''}${holiday?' holiday':''}" title="${esc(reason||'Als Urlaub auswählen')}"><input type="checkbox" data-leave-date="${date}" aria-label="${esc(fmt(date)+(reason?' · '+reason:''))}"${reason||pickerBusy||pickerSending?' disabled':''}${pickerDays.has(date)?' checked':''}><span>${Number(date.slice(-2))}${label&&!other?'<small>'+esc(label)+'</small>':''}</span></label>`;
  }).join('');
  $('leaveFormHint').textContent=kind==='holiday'?'Wähle den Tag und beschreibe unten, warum du ohne Feiertag gearbeitet hättest.':'Auswählbar sind deine Regeltage. Freie Tage, Feiertage und bereits belegte Tage bleiben gesperrt. Tippe erneut auf einen gewählten Tag, um ihn abzuwählen.';
  pickerSummary();
 }
 async function requestDays(){
  const from=$('leaveFrom').value,to=$('leaveTo').value,kind=$('leaveKind').value,run=++pickerGeneration;
  pickerDays.clear();$('leaveFormStatus').textContent='';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to||Date.parse(to)-Date.parse(from)>61*86400000){$('leaveFormStatus').textContent='Bitte einen gültigen Zeitraum von höchstens 62 Tagen auswählen.';pickerSummary();return;}
  pickerMonth=from.slice(0,7);pickerBusy=true;renderPicker();
  try{
   const dates=[];for(let d=from;d<=to;d=add(d,1))dates.push(d);
   await Promise.all([...new Set(dates.map(d=>d.slice(0,7)))].map(pickerSource));if(run!==pickerGeneration)return;
   for(const d of dates)if(!leaveBlocked(d,kind,pickerCache.get(d.slice(0,7))))pickerDays.add(d);
  }catch(error){if(run===pickerGeneration)$('leaveFormStatus').textContent=error.message;}
  finally{if(run===pickerGeneration){pickerBusy=false;renderPicker();}}
 }
 function openRequest(kind='vacation',date=null){
  if(!data)return;pickerCache=new Map([[month,data]]);pickerDays.clear();
  const initial=date?(date<b.today()?b.today():date):b.today();
  $('leaveRequestTitle').textContent=kind==='holiday'?'Feiertagsausfall prüfen lassen':'Urlaub beantragen';
  $('leaveKind').value=kind;$('leaveKindField').hidden=true;$('leaveFrom').value=initial;$('leaveTo').value=initial;$('leaveNote').value='';$('leaveFormStatus').textContent='';$('leaveRequestDialog').querySelector('.leave-range').open=false;
  if(date)requestDays();else{const run=++pickerGeneration;pickerMonth=initial.slice(0,7);pickerBusy=true;renderPicker();pickerSource(pickerMonth).catch(error=>{$('leaveFormStatus').textContent=error.message;}).finally(()=>{if(run===pickerGeneration){pickerBusy=false;renderPicker();}});}$('leaveFrom').value=date?initial:'';$('leaveTo').value=date?initial:'';b.openDialog($('leaveRequestDialog'));
 }
 async function openReview(id){
  const r=data.requests.find(r=>String(r.id)===String(id));if(!r)return;
  review={request:r,revision:r.revision,days:r.snapshot?.days||[]};$('leaveDecisionNote').value='Soll-Arbeitstage und automatische Berechnung geprüft.';$('leaveDecisionConfirm').checked=false;$('leaveAdvance').checked=false;$('leaveExtraDays').checked=false;$('leaveDecisionStatus').textContent='';
  if(r.status==='requested'){
   try{review=await api(path('/leave-requests/'+id+'/preview'));}catch(error){$('leaveDecisionStatus').textContent=error.message;review.error=error.message;}
  }
  $('leaveDecisionTitle').textContent=kindLabel(r.kind)+' prüfen';
  $('leaveDecisionDays').innerHTML=review.days.map(d=>`<div class="leave-quote" data-quote-date="${d.date}"><b>${esc(fmt(d.date))}</b><small>${regular(d.date)?'Regeltag · 2 Stunden':d.plan_id?'Soll-Einsatz vorhanden':'Solltag ohne vorhandenen Einsatz: Grundlage prüfen'}${d.legacy?' · Bisherige variable Arbeitszeit':''}${d.closed?' · Monat abgeschlossen':''}</small><p><b>${esc(b.minutes(d.minutes))} · ${esc(euro(d.amount_cents??d.suggested_cents))} brutto</b></p><details><summary>Berechnungswerte / begründete Abweichung</summary><div class="form-grid"><div class="field"><label>Ausfallstunden<input data-quote-hours type="text" inputmode="decimal" value="${Number(d.minutes/60).toLocaleString('de-DE')}"></label></div><div class="field"><label>Bruttovergütung in €<input data-quote-amount type="text" inputmode="decimal" value="${Number((d.amount_cents??d.suggested_cents)/100).toLocaleString('de-DE',{minimumFractionDigits:2})}"></label></div></div></details>${d.reference?'<small>Referenz '+esc(fmt(d.reference.from))+' – '+esc(fmt(d.reference.to))+': '+esc(b.minutes(d.reference.minutes))+' und '+d.reference.commissionable_appointments+' provisionsfähige Termine.</small>':''}${d.note?'<p class="calendar-hint">'+esc(d.note)+'</p>':''}${r.status==='approved'&&r.kind==='vacation'&&d.units>0?`<button class="btn ghost" type="button" data-cal-sick="${d.date}">Mit AU-Nachweis als Krankheit korrigieren</button>`:''}</div>`).join('');
  $('leaveApprove').hidden=r.status!=='requested';$('leaveApprove').disabled=!!review.error;$('leaveReject').hidden=r.status!=='requested';$('leaveCancel').hidden=!['approved','cancellation_requested'].includes(r.status);
  $('leavePaidWrap').hidden=r.status!=='approved';$('leavePaidDate').value=r.paid_at||b.today();
  b.openDialog($('leaveDecisionDialog'));
 }
 async function decide(action,extra={}){
  if(!review)return;const r=review.request;
  const body={action,revision:review.revision,note:$('leaveDecisionNote').value.trim(),confirmed:$('leaveDecisionConfirm').checked,advance_confirmed:$('leaveAdvance').checked,extra_days_confirmed:$('leaveExtraDays').checked,
   days:[...$('leaveDecisionDays').querySelectorAll('[data-quote-date]')].map(el=>({date:el.dataset.quoteDate,minutes:Math.round(Number(el.querySelector('[data-quote-hours]').value.replace(',','.'))*60),amount_cents:amount(el.querySelector('[data-quote-amount]').value)})),...extra};
  $('leaveDecisionStatus').textContent='Wird gespeichert …';
  try{await api(path('/leave-requests/'+r.id),'PUT',body);b.closeDialog($('leaveDecisionDialog'));await load();await b.onChanged?.();}catch(error){$('leaveDecisionStatus').textContent=error.message;}
 }
 async function mutation(button,fn){button.disabled=true;try{await fn();await load();await b.onChanged?.();}catch(error){status(error.message,true);}finally{button.disabled=false;}}
 $('calendarRegularHolidays').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target.closest('[data-holiday-id]');if(!form)return;const button=form.querySelector('button[type=submit]');button.disabled=true;
  try{const unpaid=form.querySelector('[data-holiday-unpaid]').checked;await api(path('/regular-holidays/'+form.dataset.holidayId),'PUT',{revision:Number(form.dataset.holidayRevision),confirmed:form.querySelector('[data-holiday-confirm]').checked,amount_cents:amount(form.querySelector('[data-holiday-amount]').value),note:form.querySelector('[data-holiday-note]').value,unpaid,adjacent_unexcused_confirmed:unpaid});await load();await b.onChanged?.();}catch(error){form.querySelector('[data-holiday-status]').textContent=error.message;}finally{button.disabled=false;}
 });
 $('calendarMonth').addEventListener('change',()=>{month=$('calendarMonth').value;selected=month+'-01';load()});
 for(const [id,delta] of [['calendarPrev',-1],['calendarNext',1]])$(id).addEventListener('click',()=>{if(mode==='week'){selected=add(selected,delta*7);month=selected.slice(0,7);}else{const d=new Date(month+'-01T12:00Z');d.setUTCMonth(d.getUTCMonth()+delta);month=d.toISOString().slice(0,7);selected=month+'-01';}load()});
 $('calendarToday').addEventListener('click',()=>{selected=b.today();month=selected.slice(0,7);load()});
 $('calendarViewMonth').addEventListener('click',()=>{mode='month';render()});$('calendarViewWeek').addEventListener('click',()=>{mode='week';render()});
 $('calendarOwner').addEventListener('change',async()=>{await b.selectEmployee($('calendarOwner').value);load()});
 $('calendarGrid').addEventListener('click',e=>{const x=e.target.closest('[data-cal-date]');if(x){selected=x.dataset.calDate;render();$('calendarDayDetails').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}});
 $('calendarNewLeave').addEventListener('click',()=>openRequest());
 $('calendarDayDetails').addEventListener('click',e=>{if(e.target.closest('[data-cal-regular]'))b.openRegular?.(monday(selected));if(e.target.closest('[data-cal-holiday]'))openRequest('holiday',selected);if(e.target.closest('[data-cal-vacation]'))openRequest('vacation',selected);});
 $('leaveDateChoices').addEventListener('change',e=>{const input=e.target.closest('[data-leave-date]');if(!input||input.disabled)return;input.checked?pickerDays.add(input.dataset.leaveDate):pickerDays.delete(input.dataset.leaveDate);pickerSummary();});
 $('leaveSelectionSummary').addEventListener('click',e=>{const button=e.target.closest('[data-leave-remove]');if(button){pickerDays.delete(button.dataset.leaveRemove);renderPicker();}});
 for(const [id,delta] of [['leavePrevMonth',-1],['leaveNextMonth',1]])$(id).addEventListener('click',async()=>{
  const date=new Date(pickerMonth+'-01T12:00Z');date.setUTCMonth(date.getUTCMonth()+delta);if(date.getUTCFullYear()<2020||date.getUTCFullYear()>2100)return;
  pickerMonth=date.toISOString().slice(0,7);const run=++pickerGeneration;pickerBusy=true;$('leaveFormStatus').textContent='';renderPicker();
  try{await pickerSource(pickerMonth);}catch(error){if(run===pickerGeneration)$('leaveFormStatus').textContent=error.message;}finally{if(run===pickerGeneration){pickerBusy=false;renderPicker();}}
 });
 for(const id of ['leaveFrom','leaveTo','leaveKind'])$(id).addEventListener('change',requestDays);
 $('leaveRequestClose').addEventListener('click',()=>b.closeDialog($('leaveRequestDialog')));
 $('leaveDecisionClose').addEventListener('click',()=>b.closeDialog($('leaveDecisionDialog')));
 $('leaveRequestForm').addEventListener('submit',async e=>{e.preventDefault();if(pickerSending)return;pickerSending=true;renderPicker();
  try{if(pickerBusy)throw Error('Bitte warten, bis der Kalender geladen ist.');const dates=[...pickerDays].sort();if(!dates.length)throw Error('Bitte mindestens einen Urlaubstag auswählen.');await api('/leave-requests','POST',{kind:$('leaveKind').value,dates,note:$('leaveNote').value});b.closeDialog($('leaveRequestDialog'));await load();}catch(error){$('leaveFormStatus').textContent=error.message;$('leaveFormStatus').scrollIntoView({block:'nearest'});}finally{pickerSending=false;renderPicker();}
 });
 $('calendarRequests').addEventListener('click',async e=>{const review=e.target.closest('[data-cal-review]'),withdraw=e.target.closest('[data-cal-withdraw]');if(review)return openReview(review.dataset.calReview);if(withdraw&&confirm('Antrag zurückziehen beziehungsweise die Stornierung zur Prüfung anfragen?'))mutation(withdraw,()=>api('/leave-requests/'+withdraw.dataset.calWithdraw+'/withdraw','POST',{}));});
 for(const [id,action] of [['leaveApprove','approve'],['leaveReject','reject'],['leaveCancel','cancel']])$(id).addEventListener('click',()=>decide(action));
 $('leaveMarkPaid').addEventListener('click',()=>decide('paid',{paid_at:$('leavePaidDate').value}));
 $('leaveDecisionDays').addEventListener('click',e=>{const btn=e.target.closest('[data-cal-sick]');if(btn&&confirm('Liegt für diesen Tag ein ärztlicher AU-Nachweis vor? Die geprüfte Krankheitsvergütung wird aus dem Tagesfeld übernommen.')){const box=btn.closest('[data-quote-date]');decide('sick',{date:btn.dataset.calSick,medical_proof:true,amount_cents:amount(box.querySelector('[data-quote-amount]').value)});}});
 $('calendarTransfer').addEventListener('click',e=>mutation(e.currentTarget,()=>api('/leave-transfer','POST',{year:Number(month.slice(0,4))})));
 $('calendarAdjustmentForm').addEventListener('submit',e=>{e.preventDefault();mutation(e.submitter,()=>api(path('/leave-adjustments'),'POST',{year:Number($('calendarAdjustmentYear').value),days:Number($('calendarAdjustmentDays').value.replace(',','.')),note:$('calendarAdjustmentNote').value}))});
 $('calendarRegionForm').addEventListener('submit',e=>{e.preventDefault();mutation(e.submitter,()=>api(path('/leave-region'),'PUT',{region:$('calendarRegion').value,effective_from:$('calendarRegionFrom').value,note:$('calendarRegionNote').value}))});
 $('calendarRateYear').addEventListener('change',()=>fillYearRules($('calendarRateYear').value));
 $('calendarRateForm').addEventListener('submit',e=>{e.preventDefault();mutation(e.submitter,()=>api(path('/leave-pay-rate'),'PUT',{year:Number($('calendarRateYear').value),rate_cents:amount($('calendarRate').value),note:$('calendarRateNote').value,year_rules:Object.fromEntries([...document.querySelectorAll('[data-year-rule]')].map(el=>[el.dataset.yearRule,['limit','rvMinBase'].includes(el.dataset.yearRule)?amount(el.value):Number(el.value.replace(',','.'))/100]))}))});
 return {load,render,openRequest,get data(){return data},select(date){selected=date;month=date.slice(0,7);return load()}};
}
root.OfficeCalendar={create,labels};
})(typeof window!=='undefined'?window:globalThis);
