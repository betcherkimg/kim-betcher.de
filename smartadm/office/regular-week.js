/* Three regular-day rows. Grouping never rewrites the actual date of work. */
(function(root){'use strict';
function parseDuration(value){
 const text=String(value??'').trim().toLowerCase();if(!text)return 0;
 const match=/^(\d{1,2})(?::([0-5]\d))?\s*h?$/.exec(text);if(!match)return null;
 const minutes=Number(match[1])*60+Number(match[2]||0);return minutes<=1440?minutes:null;
}
function formatDuration(minutes){const n=Math.max(0,Math.round(Number(minutes)||0));return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');}
function appointmentStanding(entries,adjustment=0){
 const count=list=>list.reduce((n,e)=>n+Number(e.appointments||0),0);
 const confirmed=entries.filter(e=>e.entryState!=='draft'),drafts=entries.filter(e=>e.entryState==='draft');
 const total=Math.max(0,count(entries)+Number(adjustment||0)),official=Math.max(0,count(confirmed)+Number(adjustment||0));
 return {total,official,provisional:total-official,hasDrafts:drafts.length>0};
}
// Wochenbalken Mo–Fr: Höhe = gearbeitete Zeit (2 Std. = volle Höhe), heute markiert.
function weekChart(days,today,fmtMin){
 const max=Math.max(120,...days.map(d=>d.minutes||0));
 return `<div class="wc" role="img" aria-label="Arbeitszeit pro Tag">${days.map(d=>{const m=d.minutes||0,h=m?Math.max(10,Math.round(m/max*100)):0;
  return `<div class="wc-col${d.date===today?' is-today':''}${d.off?' is-off':''}"><span class="wc-val">${m?fmtMin(m).replace(' h',''):''}</span><span class="wc-track"><span class="wc-fill" style="height:${h}%"></span></span><span class="wc-day">${d.label}</span></div>`;}).join('')}</div>`;
}
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
  const active=Boolean(data?.active&&(data?.days?.length||data?.slots?.length));$('regularWeekCard').hidden=!active&&!pattern?.patterns?.length;
  $('planCard').hidden=true;$('legacyTimeOverview').hidden=active;$('timeCard').hidden=active&&$('timeFormWrap').hidden;$('openTimeFormBtn').hidden=active||!$('timeFormWrap').hidden;
  if(!data)return;
  const short=d=>fmt(d).slice(0,6);$('regularWeekLabel').textContent=short(week)+' – '+fmt(add(week,6));$('regularToday').hidden=week===mon(b.today());
  const actual=(data.days||[]).flatMap(d=>d.entries||[]),actualMin=actual.reduce((n,e)=>n+e.work_minutes,0),appts=actual.reduce((n,e)=>n+Number(e.appointments||0),0);
  const target=data.targetMinutes||0,rest=Math.max(0,target-actualMin),pct=target?Math.min(100,Math.round(actualMin/target*100)):0;
  $('regularSummary').classList.toggle('is-done',target>0&&rest===0);
  const short2=['','Mo','Di','Mi','Do','Fr'];
  const chartDays=(data.days||[]).map(d=>({date:d.date,label:short2[d.weekday]||'',minutes:(d.entries||[]).reduce((n,e)=>n+e.work_minutes,0),off:Boolean(d.holidayName||d.absence)}));
  $('regularSummary').innerHTML=`<div class="wk-top"><span class="wk-now">${esc(b.minutes(actualMin).replace(' h',''))}<small> / ${esc(b.minutes(target))}</small></span><span class="wk-meta">${data.confirmed?'Abgesendet ✓':rest?`noch ${esc(b.minutes(rest))}`:'Ziel erreicht ✓'}</span></div>${weekChart(chartDays,b.today(),b.minutes)}<div class="wk-sub">${appts} ${appts===1?'Termin':'Termine'}${data.holidayMinutes?' · Feiertagswoche':''}</div>`;
  const now=b.today(),locked=data.confirmed||week!==mon(now)&&!data.correctionOpen,absNames={vacation:'Urlaub',sick:'Krankheit',paid_leave:'Bezahlte Freistellung'};
  const old=(data.allocations||[]).filter(e=>e.entry_state==='draft'&&!e.submission_id);
  // Nur Tage mit Einträgen, offenen Altangaben, Feiertag oder Abwesenheit – keine leeren Wochentage.
  const shown=(data.days||[]).filter(d=>(d.entries||[]).length||old.some(e=>e.work_date===d.date)||d.holidayName||d.absence);
  const dayRows=shown.map(d=>{
   const entries=d.entries||[],blocked=Boolean(d.holidayName||d.absence);
   const label=d.holidayName?(d.holiday?'Feiertag · 2 Std. gutgeschrieben':'Feiertag'):d.absence?(absNames[d.absence.absence_type]||'Abwesenheit'):'';
   const list=entries.map(e=>`<div class="regular-entry"><span>${esc(e.start_time)}–${esc(e.end_time)} Uhr · <b>${esc(b.minutes(e.work_minutes))}</b><small>${Number(e.appointments||0)} ${Number(e.appointments)===1?'Termin':'Termine'}</small></span>${!locked&&!e.submission_id?`<button class="btn ghost small" type="button" data-regular-edit="${e.id}">Ändern</button>`:''}</div>`).join('');
   const fix=old.filter(e=>e.work_date===d.date).map(e=>`<div class="regular-entry regular-missing"><span><b>Uhrzeit fehlt</b> · ${esc(b.minutes(e.work_minutes))}<small>${Number(e.appointments||0)} ${Number(e.appointments)===1?'Termin':'Termine'}</small></span>${locked||blocked?'':`<span class="regular-fix-btns"><button class="btn primary small" type="button" data-regular-fix="${e.id}">Uhrzeit eintragen</button><button class="btn ghost small" type="button" data-regular-remove="${e.id}">Löschen</button></span>`}</div>`).join('');
   const nice=new Intl.DateTimeFormat('de-DE',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(d.date+'T12:00Z'));
   return `<div class="regular-day${blocked?' regular-disabled':''}"><div><b>${esc(names[d.weekday])}</b>, ${esc(nice)}${label?' <strong>'+esc(label)+'</strong>':''}</div><div>${list}${fix}</div></div>`;
  }).join('');
  const canAdd=!locked&&(data.days||[]).some(d=>d.date<=now&&!d.holidayName&&!d.absence);
  $('regularRows').innerHTML=(dayRows||'<p class="muted" style="margin:14px 0 4px;text-align:center">Noch nichts eingetragen.</p>')+(canAdd?`<div class="btn-row" style="margin-top:12px"><button class="btn ghost" style="width:100%" type="button" data-regular-day="${now<add(week,4)?now:add(week,4)}">+ Arbeitszeit eintragen</button></div>`:'');
  $('regularPhaseNotice').hidden=true;
  const messages=[],sendFrom=add(week,4);
  if(data.overtimeMinutes)messages.push(`${b.minutes(data.overtimeMinutes)} mehr als geplant – Kim prüft das.`);
  if(data.correctionOpen&&!data.confirmed)messages.push('Kim hat die Woche zur Korrektur geöffnet.');
  else if(data.confirmed)messages.push(data.confirmation?.automatic?'Automatisch übernommen.':'Für Korrekturen bitte Kim fragen.');
  else if(sendFrom>b.today())messages.push('Absenden ab Freitag möglich.');
  else messages.push('Bis Sonntag absenden – sonst übernimmt Office automatisch.');
  if(data.review)messages.push('Kim hat die Woche eingeordnet.');
  $('regularStatus').textContent=messages.join(' ');
  $('regularComplete').disabled=!data.active||add(week,4)>b.today()||data.confirmed;
  $('regularComplete').textContent=data.confirmed?'Abgesendet ✓':'Woche absenden';
  const today=b.today(),wd=new Date(today+'T12:00Z').getUTCDay();$('regularSendNotice').hidden=!data.active||data.confirmed||week!==mon(today)||![5,6,0].includes(wd);
  $('regularSendNoticeText').textContent=wd===5?'Bitte heute prüfen und absenden.':'Bitte bis Sonntag prüfen und absenden.';
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
   let saved=false;
   while(pending.size){
    const [slot,draft]=pending.entries().next().value,minutes=parseDuration(draft.hours),appts=Number(draft.appointments||0);
    if(minutes===null||!Number.isInteger(appts)||appts<0){$('regularStatus').textContent='Bitte Stunden und Minuten als 1:20 sowie ganze Termine eintragen. Noch nicht gespeichert.';throw Error('Bitte Eingaben prüfen.');}
    try{await api('/regular-week/slot','PUT',{slot,minutes,appointments:appts,note:draft.note});saved=true;if(pending.get(slot)===draft)pending.delete(slot);}
    catch(error){$('regularStatus').textContent='Nicht gespeichert: '+error.message;throw error;}
   }
   const total=[...$('regularRows').querySelectorAll('[data-week-row]:not(.regular-disabled) [data-slot-hours]')].reduce((n,x)=>n+(parseDuration(x.value)||0),0)+(data?.unassigned||[]).reduce((n,e)=>n+e.work_minutes,0);const appts=[...$('regularRows').querySelectorAll('[data-week-row]:not(.regular-disabled) [data-slot-appts]')].reduce((n,x)=>n+Number(x.value||0),0)+(data?.unassigned||[]).reduce((n,e)=>n+e.appointments,0);$('regularSummary').textContent=`${appts} Termine · ${data?.confirmed?'Bestätigt':'Vorläufig'} · ${b.minutes(total)} erfasst + ${b.minutes((data?.holidayMinutes||0)+(data?.absenceMinutes||0))} gutgeschrieben · Noch zu arbeiten: ${b.minutes(Math.max(0,(data?.targetMinutes||0)-total))}`;
   if(saved||!data?.confirmed)$('regularStatus').textContent='Gespeichert · Vorläufig für dich und Kim sichtbar. Absenden bestätigt deinen Stand.';
   if(saved)try{await b.onSaved?.();}catch{$('regularStatus').textContent='Gespeichert · Die Monatsübersicht konnte noch nicht aktualisiert werden. Bitte neu laden.';}
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
  if(!data||!data.active||busy)return;try{await flush();await load();}catch{return;}let note='';if(data.missingMinutes>0){note=prompt(`Es fehlen ${b.minutes(data.missingMinutes)}. Kurz begründen:`)||'';if(!note.trim())return;}
  if(!confirm('Woche jetzt absenden? Danach kann nur noch Kim etwas ändern.'))return;
  busy=true;$('regularComplete').disabled=true;
  try{await flush();await load();await api('/regular-week/complete','POST',{week,state_hash:data.stateHash,note});await load();await b.onSubmitted?.();b.toast('Woche abgesendet ✓');}catch(error){$('regularStatus').textContent=error.message;}finally{busy=false;$('regularComplete').disabled=!data?.active||add(week,4)>b.today()||!!data?.confirmed;}
 }
 $('regularRows').addEventListener('click',e=>{const slot=e.target.closest('[data-regular-slot]'),edit=e.target.closest('[data-regular-edit]');const details=e.target.closest('[data-regular-details]');if(details)document.querySelector('[data-regular-entries="'+details.dataset.regularDetails+'"]').open=true;if(slot)openEntry(slot.dataset.regularSlot);if(edit)b.editEntry(edit.dataset.regularEdit);const day=e.target.closest('[data-regular-day]'),fix=e.target.closest('[data-regular-fix]'),rm=e.target.closest('[data-regular-remove]');if(day)b.openEntry(day.dataset.regularDay,week);if(rm)b.removeEntry(rm.dataset.regularRemove);if(fix){const a=(data.allocations||[]).find(x=>String(x.id)===fix.dataset.regularFix);if(a)b.openEntry(a.work_date,week,a);}});
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
root.OfficeRegularWeek={create,parseDuration,formatDuration,appointmentStanding,weekChart};
})(typeof window!=='undefined'?window:globalThis);
