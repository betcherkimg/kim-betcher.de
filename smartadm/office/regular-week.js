/* Three regular-day rows. Grouping never rewrites the actual date of work. */
(function(root){'use strict';
function parseDuration(value){
 const text=String(value??'').trim().toLowerCase();if(!text)return 0;
 const match=/^(\d{1,2})(?::([0-5]\d))?\s*h?$/.exec(text);if(!match)return null;
 const minutes=Number(match[1])*60+Number(match[2]||0);return minutes<=1440?minutes:null;
}
function formatDuration(minutes){const n=Math.max(0,Math.round(Number(minutes)||0));return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');}
function create(b){
 const {$,esc,api}=b,names=['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
 const fmt=d=>new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00Z'));
 const add=(d,n)=>{const x=new Date(d+'T12:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
 const mon=d=>add(d,-((new Date(d+'T12:00Z').getUTCDay()+6)%7));
 let week=mon(b.today()),data=null,pattern=null,selectionRequired=false,selectedSlot=null,generation=0,busy=false,pending=new Map(),saveQueue=Promise.resolve(),saveTimer=null,viewToday=b.today(),failedDrafts=new Map();
 async function load(){
  if(b.role()!=='employee')return;if(pending.size)await flush();const run=++generation;
  try{const [p,w]=await Promise.all([api('/regular-pattern'),api('/regular-week?week='+week)]);if(run!==generation)return;
   pattern=p;data=w;b.changed?.(p,w);render();return w;
  }catch(error){$('regularStatus').textContent='Wochenansicht konnte nicht geladen werden: '+error.message;}
 }
 function render(){
  const active=Boolean(data?.active&&data?.slots?.length);$('regularWeekCard').hidden=!active&&!pattern?.patterns?.length;
  $('planCard').hidden=true;$('legacyTimeOverview').hidden=active;$('timeCard').hidden=active&&$('timeFormWrap').hidden;$('openTimeFormBtn').hidden=active||!$('timeFormWrap').hidden;
  if(!data)return;
  $('regularWeekLabel').textContent=fmt(week)+' – '+fmt(add(week,6));
  $('regularSummary').textContent=`${b.minutes(data.workMinutes)} erfasst + ${b.minutes(data.holidayMinutes+data.absenceMinutes)} gutgeschrieben · Noch zu arbeiten: ${b.minutes(Math.max(0,data.targetMinutes-data.workMinutes))}`;
  $('regularRows').innerHTML=data.slots.map(s=>{
   const entries=s.entries||[],disabled=Boolean(s.holiday||s.absence),legacy=entries.some(e=>e.record_kind!=='weekly_allocation'),sent=data.confirmed;
   const minutes=entries.reduce((n,e)=>n+e.work_minutes,0),appointments=entries.reduce((n,e)=>n+e.appointments,0),note=entries.find(e=>e.record_kind==='weekly_allocation')?.entry_note||'';
   const label=s.holiday?'Feiertag · 2 Stunden gutgeschrieben':s.absence?({vacation:'Urlaub',sick:'Krankheit',paid_leave:'Bezahlte Freistellung'}[s.absence.absence_type]||'Abwesenheit'):'';
   const locked=disabled||sent||week!==mon(b.today())&&!data.correctionOpen;
   return `<div class="regular-row${disabled?' regular-disabled':''}" data-week-row="${s.date}"><div><b>${esc(names[s.weekday])}</b><small>${esc(fmt(s.date))}</small>${label?'<strong>'+esc(label)+'</strong>':''}${legacy?'<small>Vorhandener Arbeitsnachweis</small>':''}</div><div><label class="regular-col-label" for="regularHours${s.weekday}">Std:Min</label><input ${locked?'disabled':''} id="regularHours${s.weekday}" data-slot-hours="${s.date}" type="text" inputmode="text" maxlength="8" value="${disabled?formatDuration(s.holiday?.minutes||s.absence?.paid_minutes||0):entries.length?formatDuration(minutes):''}" placeholder="0:00" title="Stunden:Minuten, zum Beispiel 1:20" aria-label="Stunden und Minuten ${esc(names[s.weekday])}"></div><div><label class="regular-col-label" for="regularAppts${s.weekday}">Termine</label><input ${locked?'disabled':''} id="regularAppts${s.weekday}" data-slot-appts="${s.date}" type="number" min="0" step="1" value="${disabled?'':entries.length?appointments:''}" placeholder="0" aria-label="Termine ${esc(names[s.weekday])}"></div><div class="regular-note"><label class="regular-col-label" for="regularNote${s.weekday}">Notiz</label><input ${locked?'disabled':''} id="regularNote${s.weekday}" data-slot-note="${s.date}" type="text" maxlength="500" value="${esc(note)}" placeholder="–" aria-label="Notiz ${esc(names[s.weekday])}"></div></div>`;
  }).join('');
  if(data.unassigned.length)$('regularRows').innerHTML+=`<details open><summary>Weitere tatsächliche Einträge dieser Woche (${data.unassigned.length})</summary>${data.unassigned.map(e=>`<p>${esc(fmt(e.work_date))} · ${esc(b.minutes(e.work_minutes))} · ${e.appointments} Termine ${e.submission_id?'<span class="chip good">Abgesendet</span>':`<button class="btn ghost small" type="button" data-regular-edit="${e.id}">Bearbeiten</button>`}</p>`).join('')}</details>`;
  $('regularPhaseNotice').hidden=!data.transition;$('regularPhaseNotice').textContent=data.transition?'Übergangswoche: Hier gilt noch deine bisherige Einsatzplanung. Dein gewählter Wochenrhythmus startet erst ab '+(data.regularStart?fmt(data.regularStart):'dem bestätigten Geltungsbeginn')+'. Vorhandene Stunden und Termine sind schon enthalten. Geplante Zeiten zählen nicht als gearbeitet.':'';
  const messages=[];
  if(data.overtimeMinutes)messages.push(`${b.minutes(data.overtimeMinutes)} zusätzlich: Kim prüft die Mehrarbeit. Die Feiertagsgutschrift bleibt bestehen.`);
  if(data.actualWorkdays>3)messages.push('Arbeit an mehr als drei tatsächlichen Tagen: Kim prüft die Abweichung. Alle Einträge bleiben erhalten.');
  if(data.patternReview)messages.push('Du hast in mindestens vier der letzten sechs Wochen andere Tage genutzt. Passen deine Regeltage noch? Änderungen gelten mit Vorlauf.');
  messages.push(data.confirmed?(data.confirmation?.automatic?'Automatisch nach Sonntag übernommen. Fehlende Angaben prüft Kim.':'Abgesendet. Für Korrekturen bitte Kim fragen.'):'Änderungen werden automatisch gespeichert. Bis Sonntag kannst du sie ändern. Mit „Absenden“ wird die Woche fest übermittelt; sonst übernimmt Office Sonntag zum Tagesende den gespeicherten Stand automatisch.');
  if(data.review)messages.push('Kims Einordnung dieser Woche steht unter Arbeitszeiten.');
  if(!data.transition&&pattern?.patterns?.length&&!pattern.current)messages.push('Die neue Regelverteilung startet nach beiden Unterschriften, frühestens am 01.11.2026. Bis dahin gilt die bisherige Regelung.');
  $('regularStatus').textContent=messages.join(' ');
  $('regularComplete').disabled=!data.active||add(week,4)>b.today()||data.confirmed;
  $('regularComplete').textContent=data.confirmed?'Abgesendet ✓':'Absenden';
  const today=b.today(),wd=new Date(today+'T12:00Z').getUTCDay();$('regularSendNotice').hidden=!data.active||data.confirmed||week!==mon(today)||![5,6,0].includes(wd);
  $('regularSendNoticeText').textContent=wd===5?'Heute bitte die Arbeitszeiten abschicken. Deine Einträge sind bis zum Absenden Entwürfe.':'Bitte die Woche bis Sonntag prüfen und absenden. Danach übernimmt Office den gespeicherten Stand automatisch.';
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
 function changedRow(input){
  const row=input.closest('[data-week-row]');if(!row||input.disabled)return;
  const slot=row.dataset.weekRow;pending.set(slot,{slot,hours:row.querySelector('[data-slot-hours]').value,appointments:row.querySelector('[data-slot-appts]').value,note:row.querySelector('[data-slot-note]').value});
  $('regularStatus').textContent='Wird gespeichert …';clearTimeout(saveTimer);saveTimer=setTimeout(()=>flush().catch(()=>{}),500);
 }
 async function flush(){
  clearTimeout(saveTimer);
  const work=async()=>{
   while(pending.size){
    const [slot,draft]=pending.entries().next().value,minutes=parseDuration(draft.hours),appts=Number(draft.appointments||0);
    if(minutes===null||!Number.isInteger(appts)||appts<0){$('regularStatus').textContent='Bitte Stunden und Minuten als 1:20 sowie ganze Termine eintragen. Noch nicht gespeichert.';throw Error('Bitte Eingaben prüfen.');}
    try{await api('/regular-week/slot','PUT',{slot,minutes,appointments:appts,note:draft.note});if(pending.get(slot)===draft)pending.delete(slot);}
    catch(error){$('regularStatus').textContent='Nicht gespeichert: '+error.message;throw error;}
   }
   const total=[...$('regularRows').querySelectorAll('[data-week-row]:not(.regular-disabled) [data-slot-hours]')].reduce((n,x)=>n+(parseDuration(x.value)||0),0)+(data?.unassigned||[]).reduce((n,e)=>n+e.work_minutes,0);$('regularSummary').textContent=`${b.minutes(total)} erfasst + ${b.minutes((data?.holidayMinutes||0)+(data?.absenceMinutes||0))} gutgeschrieben · Noch zu arbeiten: ${b.minutes(Math.max(0,(data?.targetMinutes||0)-total))}`;
   $('regularStatus').textContent='Gespeichert · Bis zum Absenden kannst du deine Angaben ändern.';
  };
  saveQueue=saveQueue.catch(()=>{}).then(work);return saveQueue;
 }
 async function rollover(){
  const today=b.today();if(today===viewToday)return;const oldCurrent=mon(viewToday);viewToday=today;
  try{await flush();}catch{failedDrafts.set(week,[...pending.values()]);try{localStorage.setItem('office-unsaved-week:'+b.userId()+':'+week,JSON.stringify([...pending.values()]));}catch{}pending.clear();b.toast('Einige Änderungen der alten Woche waren noch nicht gespeichert. Bitte Kim um Prüfung bitten.');}if(mon(today)!==oldCurrent)week=mon(today);await load();
 }
 $('regularRows').addEventListener('input',e=>{if(e.target.matches('[data-slot-hours],[data-slot-appts],[data-slot-note]'))changedRow(e.target)});
 $('regularRows').addEventListener('change',e=>{if(e.target.matches('[data-slot-hours],[data-slot-appts],[data-slot-note]')){if(e.target.matches('[data-slot-hours]')){const minutes=parseDuration(e.target.value);if(minutes!==null)e.target.value=formatDuration(minutes);}changedRow(e.target);flush().catch(()=>{});}});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')rollover()});root.addEventListener('focus',rollover);setInterval(rollover,30000);
 root.addEventListener('beforeunload',e=>{if(pending.size){e.preventDefault();e.returnValue='';}});
 async function complete(){
  if(!data||!data.active||busy)return;try{await flush();await load();}catch{return;}let note='';if(data.missingMinutes>0){note=prompt(`Es fehlen ${b.minutes(data.missingMinutes)}. Bitte kurz erläutern, damit Kim die Woche einordnen kann:`)||'';if(!note.trim())return;}
  if(!confirm('Sind alle tatsächlich geleisteten Stunden und Termine dieser Woche vollständig? Mit Absenden werden sie fest an Kim übermittelt und für die Lohnabrechnung freigegeben.'))return;
  busy=true;$('regularComplete').disabled=true;
  try{await flush();await load();await api('/regular-week/complete','POST',{week,state_hash:data.stateHash,note});await load();await b.onSubmitted?.();b.toast('Arbeitswoche abgesendet. Kim kann Abweichungen prüfen.');}catch(error){$('regularStatus').textContent=error.message;}finally{busy=false;$('regularComplete').disabled=!data?.active||add(week,4)>b.today()||!!data?.confirmed;}
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
 return {load,onboarding,afterNotices,choose,render,get data(){return data},get patterns(){return pattern?.patterns||[]},flush,get slot(){return selectedSlot},async selectWeek(value){week=value;await load()},entrySlot(){return $('entryRegularSlot').value||null}};
}
root.OfficeRegularWeek={create,parseDuration,formatDuration};
})(typeof window!=='undefined'?window:globalThis);
