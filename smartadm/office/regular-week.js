/* Three regular-day rows. Grouping never rewrites the actual date of work. */
(function(root){'use strict';
function create(b){
 const {$,esc,api}=b,names=['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
 const fmt=d=>new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00Z'));
 const add=(d,n)=>{const x=new Date(d+'T12:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
 const mon=d=>add(d,-((new Date(d+'T12:00Z').getUTCDay()+6)%7));
 let week=mon(b.today()),data=null,pattern=null,selectionRequired=false,selectedSlot=null,generation=0,busy=false;
 async function load(){
  if(b.role()!=='employee')return;const run=++generation;
  try{const [p,w]=await Promise.all([api('/regular-pattern'),api('/regular-week?week='+week)]);if(run!==generation)return;
   pattern=p;data=w;b.changed?.(p,w);render();return w;
  }catch(error){$('regularStatus').textContent='Wochenansicht konnte nicht geladen werden: '+error.message;}
 }
 function render(){
  const active=Boolean(data?.active&&data?.slots?.length);$('regularWeekCard').hidden=!active&&!pattern?.patterns?.length;
  $('planCard').hidden=true;$('timeCard').hidden=active&&$('timeFormWrap').hidden;$('openTimeFormBtn').hidden=active||!$('timeFormWrap').hidden;
  if(!data)return;
  $('regularWeekLabel').textContent=fmt(week)+' – '+fmt(add(week,6));
  $('regularSummary').textContent=`${b.minutes(data.workMinutes)} erfasst + ${b.minutes(data.holidayMinutes+data.absenceMinutes)} gutgeschrieben · Noch zu arbeiten: ${b.minutes(Math.max(0,data.targetMinutes-data.workMinutes))}`;
  $('regularRows').innerHTML=data.slots.map(s=>{
   const disabled=Boolean(s.holiday||s.absence),minutes=s.entries.reduce((n,e)=>n+e.work_minutes,0),appointments=s.entries.reduce((n,e)=>n+e.appointments,0);
   const sent=data.confirmed,existing=s.entries.length>0;
   const label=s.holiday?'Feiertag · 2 Stunden gutgeschrieben':s.absence?({vacation:'Urlaub',sick:'Krankheit',paid_leave:'Bezahlte Freistellung'}[s.absence.absence_type]||'Abwesenheit'):'';
   return `<div class="regular-row${disabled?' regular-disabled':''}"><div><b>${esc(names[s.weekday])}</b><small>${esc(fmt(s.date))} · Regeltag</small>${label?'<strong>'+esc(label)+'</strong>':''}</div><div><label class="regular-col-label" for="regularHours${s.weekday}">Stunden</label>${disabled||existing||sent?'<output>'+esc(b.minutes(disabled?(s.holiday?.minutes||s.absence?.paid_minutes||0):minutes))+'</output>':`<input ${sent?'disabled':''} id="regularHours${s.weekday}" data-slot-hours="${s.date}" type="text" inputmode="decimal" placeholder="0,0" aria-label="Neue selbst erfasste Stunden für ${esc(names[s.weekday])}"><small>Erfasst: ${esc(b.minutes(minutes))}</small>`}</div><div><label class="regular-col-label" for="regularAppts${s.weekday}">Termine</label>${disabled||existing||sent?'<output>'+(disabled?'–':appointments)+'</output>':`<input ${sent?'disabled':''} id="regularAppts${s.weekday}" data-slot-appts="${s.date}" type="number" min="0" step="1" placeholder="0" aria-label="Neue Termine für ${esc(names[s.weekday])}"><small>Erfasst: ${appointments}</small>`}</div><div class="regular-row-action">${disabled||sent?'':`<button type="button" class="btn ${existing?'ghost':'primary'}" ${s.entries.length===1?'data-regular-edit="'+s.entries[0].id+'"':existing?'data-regular-details="'+s.date+'"':'data-regular-slot="'+s.date+'"'}>${existing?'Bearbeiten':'Eintragen'}</button>`}</div>${s.entries.length?`<details data-regular-entries="${s.date}"><summary>Einträge ansehen (${s.entries.length})</summary>${!sent?'<button type="button" class="btn ghost small" data-regular-slot="'+s.date+'">Weitere Arbeitszeit ergänzen</button>':''}${s.entries.map(e=>`<p>${esc(fmt(e.work_date))} · ${esc(e.start_time)}–${esc(e.end_time)} · ${esc(b.minutes(e.work_minutes))} · ${e.appointments} Termine ${e.submission_id?'<span class="chip good">Abgesendet</span>':`<button class="btn ghost small" type="button" data-regular-edit="${e.id}">Bearbeiten</button>`}</p>`).join('')}</details>`:''}</div>`;
  }).join('');
  if(data.unassigned.length)$('regularRows').innerHTML+=`<details open><summary>Weitere tatsächliche Einträge dieser Woche (${data.unassigned.length})</summary>${data.unassigned.map(e=>`<p>${esc(fmt(e.work_date))} · ${esc(b.minutes(e.work_minutes))} · ${e.appointments} Termine ${e.submission_id?'<span class="chip good">Abgesendet</span>':`<button class="btn ghost small" type="button" data-regular-edit="${e.id}">Bearbeiten</button>`}</p>`).join('')}</details>`;
  const messages=[];
  if(data.overtimeMinutes)messages.push(`${b.minutes(data.overtimeMinutes)} zusätzlich: Kim prüft die Mehrarbeit. Die Feiertagsgutschrift bleibt bestehen.`);
  if(data.actualWorkdays>3)messages.push('Arbeit an mehr als drei tatsächlichen Tagen: Kim prüft die Abweichung. Alle Einträge bleiben erhalten.');
  if(data.patternReview)messages.push('Du hast in mindestens vier der letzten sechs Wochen andere Tage genutzt. Passen deine Regeltage noch? Änderungen gelten mit Vorlauf.');
  messages.push(data.confirmed?'Diese Woche wurde an Kim übermittelt und ist festgeschrieben. Für Änderungen bitte Kim um Korrekturfreigabe bitten.':'Entwurf: Kim kann deine Eingaben sehen. Erst mit „Absenden“ werden sie fest übermittelt und in die Lohnabrechnung übernommen.');
  if(data.review)messages.push('Kims Einordnung dieser Woche steht unter Arbeitszeiten.');
  if(pattern?.patterns?.length&&!pattern.current)messages.push('Die neue Regelverteilung startet nach beiden Unterschriften, frühestens am 01.11.2026. Bis dahin gilt die bisherige Regelung.');
  $('regularStatus').textContent=messages.join(' ');
  $('regularComplete').disabled=!data.active||add(week,4)>b.today()||data.confirmed;
  $('regularComplete').textContent=data.confirmed?'Abgesendet ✓':'Absenden';
  const today=b.today(),wd=new Date(today+'T12:00Z').getUTCDay();$('regularSendNotice').hidden=!data.active||data.confirmed||week!==mon(today)||![5,6,0].includes(wd);
  $('regularSendNoticeText').textContent=wd===5?'Heute bitte die Arbeitszeiten abschicken. Deine Einträge sind bis zum Absenden Entwürfe.':'Die Arbeitswoche ist noch ein Entwurf. Bitte spätestens Sonntag absenden.';
 }
 function fillDays(days=[]){$('regularDayChoices').innerHTML=[1,2,3,4,5].map(d=>`<label class="regular-choice"><input type="checkbox" value="${d}"${days.includes(d)?' checked':''}>${names[d]}</label>`).join('');}
 async function choose(required=false){
  pattern=await api('/regular-pattern');selectionRequired=required;$('regularPatternClose').hidden=required;
  fillDays(pattern.current?.weekdays||pattern.patterns?.at(-1)?.weekdays||[]);$('regularPatternCheck').checked=false;$('regularPatternStatus').textContent='';
  $('regularPatternIntro').textContent=pattern.patterns.length?`Wähle drei Regeltage von Montag bis Freitag. Deine Änderung gilt ab ${fmt(pattern.nextChangeDate)}. Bis dahin bleiben die bisherigen Tage maßgeblich.`:'Wähle die drei Tage, an denen du regelmäßig am liebsten arbeitest. Je Regeltag sind zwei Stunden vorgesehen. Du kannst tatsächlich weiterhin andere Tage nutzen. An Feiertagen auf einem Regeltag bekommst du zwei Stunden gutgeschrieben.';
  b.openDialog($('regularPatternDialog'));
 }
 async function onboarding(){
  await load();if(pattern?.needsInitial){await choose(true);return true;}
  return false;
 }
 async function afterNotices(){
  await load();if(data?.active&&data.overdue?.length){
   const overdue=data.overdue[0];$('regularOverdueText').textContent=`Bitte prüfe und vervollständige deine Zeiten und Termine für ${fmt(overdue)} – ${fmt(add(overdue,6))}. Wenn du weniger gearbeitet hast, erläutere die Fehlstunden kurz. Kim entscheidet darüber wie bisher.`;
   $('regularOverdueGo').dataset.week=overdue;b.openDialog($('regularOverdueDialog'));return;
  }
 }
 function openEntry(slot){
  selectedSlot=slot;b.openEntry(slot,week);$('entryRegularSlot').value=slot;
  $('entryManualHours').value=document.querySelector('[data-slot-hours="'+slot+'"]')?.value||'';$('appointments').value=document.querySelector('[data-slot-appts="'+slot+'"]')?.value||'0';
  $('entryActualHint').textContent='Regelplatz '+names[new Date(slot+'T12:00Z').getUTCDay()]+' · '+fmt(slot)+'. Darunter bitte den tatsächlichen Arbeitstag und die tatsächlichen Zeiten angeben. Bereits geleistete Arbeit kannst du sofort erfassen.';
 }
 async function complete(){
  if(!data||!data.active||busy)return;let note='';if(data.missingMinutes>0){note=prompt(`Es fehlen ${b.minutes(data.missingMinutes)}. Bitte kurz erläutern, damit Kim die Woche einordnen kann:`)||'';if(!note.trim())return;}
  if(!confirm('Sind alle tatsächlich geleisteten Stunden und Termine dieser Woche vollständig? Mit Absenden werden sie fest an Kim übermittelt und für die Lohnabrechnung freigegeben.'))return;
  busy=true;$('regularComplete').disabled=true;
  try{await api('/regular-week/complete','POST',{week,state_hash:data.stateHash,note});await load();await b.onSubmitted?.();b.toast('Arbeitswoche abgesendet. Kim kann Abweichungen prüfen.');}catch(error){$('regularStatus').textContent=error.message;}finally{busy=false;$('regularComplete').disabled=!data?.active||add(week,4)>b.today()||!!data?.confirmed;}
 }
 $('regularRows').addEventListener('click',e=>{const slot=e.target.closest('[data-regular-slot]'),edit=e.target.closest('[data-regular-edit]');const details=e.target.closest('[data-regular-details]');if(details)document.querySelector('[data-regular-entries="'+details.dataset.regularDetails+'"]').open=true;if(slot)openEntry(slot.dataset.regularSlot);if(edit)b.editEntry(edit.dataset.regularEdit)});
 $('regularPrev').addEventListener('click',()=>{week=add(week,-7);load()});$('regularNext').addEventListener('click',()=>{week=add(week,7);load()});$('regularToday').addEventListener('click',()=>{week=mon(b.today());load()});
 $('regularChooseDays').addEventListener('click',()=>choose());$('regularComplete').addEventListener('click',complete);
 $('regularPatternClose').addEventListener('click',()=>{if(!selectionRequired)b.closeDialog($('regularPatternDialog'))});
 $('regularPatternDialog').addEventListener('cancel',e=>{if(selectionRequired)e.preventDefault()});
 $('regularPatternForm').addEventListener('submit',async e=>{e.preventDefault();const button=$('regularPatternSave');button.disabled=true;
  try{const days=[...$('regularDayChoices').querySelectorAll('input:checked')].map(el=>Number(el.value));await api('/regular-pattern','POST',{weekdays:days,confirmed:$('regularPatternCheck').checked});b.closeDialog($('regularPatternDialog'));selectionRequired=false;await load();b.toast('Regeltage gespeichert.');await b.onOnboarded?.();}catch(error){$('regularPatternStatus').textContent=error.message;}finally{button.disabled=false;}
 });
 $('regularOverdueDialog').addEventListener('cancel',e=>e.preventDefault());
 $('regularOverdueGo').addEventListener('click',async()=>{week=$('regularOverdueGo').dataset.week;b.closeDialog($('regularOverdueDialog'));b.showPage('zeiten');await load();$('regularWeekCard').scrollIntoView({block:'start'});});
 return {load,onboarding,afterNotices,choose,render,get data(){return data},get patterns(){return pattern?.patterns||[]},get slot(){return selectedSlot},async selectWeek(value){week=value;await load()},entrySlot(){return $('entryRegularSlot').value||null}};
}
root.OfficeRegularWeek={create};
})(typeof window!=='undefined'?window:globalThis);
