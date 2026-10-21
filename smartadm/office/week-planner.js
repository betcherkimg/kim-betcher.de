/* Wochenplanung: Stunden je Tag und die wöchentliche Planungsaufgabe. */
(function(root){
  "use strict";
  const TARGET = 360, MAX_DAYS = 3, FIRST_RELEASE = "2026-10-21";
  const addDays = (iso,n) => { const d=new Date(iso+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); };
  const monday = iso => { const d=new Date(iso+"T12:00:00Z");return addDays(iso,1-(d.getUTCDay()||7)); };
  const berlinDate = (now=new Date()) => new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Berlin",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  function parseHours(value){
    const text=String(value).trim();let minutes;
    if(/^\d{1,2}:[0-5]\d$/.test(text)){const [h,m]=text.split(":").map(Number);minutes=h*60+m;}
    else if(/^\d+(?:[.,]\d{1,2})?$/.test(text)) minutes=Math.round(Number(text.replace(",","."))*60);
    return Number.isInteger(minutes)&&minutes>0&&minutes<=1440 ? minutes : null;
  }
  const hoursValue = minutes => minutes%15===0 ? String(minutes/60).replace(".",",") : `${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,"0")}`;
  function details(plan){
    const raw=String(plan?.note||"");
    const match=/^Geplante Dauer: (\d{1,2}):([0-5]\d) h(?:\r?\n|$)/.exec(raw);
    const minutes=match ? Number(match[1])*60+Number(match[2]) : 120;
    if(!match||minutes<=0||minutes>1440)return {minutes:120,note:raw};
    let note=raw.slice(match[0].length),reason="";
    const why=/^Wochenbegründung: ([^\n]*)(?:\r?\n|$)/.exec(note);
    if(why){reason=why[1];note=note.slice(why[0].length);}
    return {minutes,note,...(reason ? {reason} : {})};
  }
  function encodeNote(minutes,note,reason=""){
    if(!Number.isInteger(minutes)||minutes<=0||minutes>1440) throw Error("Bitte gültige Stunden eintragen.");
    const prefix=`Geplante Dauer: ${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,"0")} h`;
    const text=String(note||"").trim(),why=String(reason||"").trim().replace(/\s+/g," ");
    const result=[prefix,why ? "Wochenbegründung: "+why : "",text].filter(Boolean).join("\n");
    if(result.length>200)throw Error("Bitte die Notiz zum Tag oder die Wochenbegründung kürzen; zusammen sind höchstens 200 Zeichen möglich.");
    return result;
  }
  const activeWeek = (plans,week) => plans.filter(p=>p.status!=="cancelled"&&p.plan_date>=week&&p.plan_date<=addDays(week,6)).sort((a,b)=>a.plan_date.localeCompare(b.plan_date));
  const samePlan = (a,b) => !!a&&!!b&&a.plan_date===b.plan_date&&a.start_time===b.start_time&&details(a).minutes===details(b).minutes&&details(a).note===details(b).note&&(details(a).reason||"")===(details(b).reason||"");
  function changesFor(base,current,desired){
    const before=new Map(base.map(p=>[p.plan_date,p])),now=new Map(current.map(p=>[p.plan_date,p])),want=new Map(desired.map(p=>[p.plan_date,p]));
    for(const day of new Set([...before.keys(),...now.keys()])){
      const old=before.get(day),fresh=now.get(day),next=want.get(day);
      const unchanged=(!old&&!fresh)||(samePlan(old,fresh)&&old.status===fresh.status&&String(old.id)===String(fresh.id));
      // Ein nach einem Verbindungsabbruch bereits gespeicherter Tag wird beim Wiederholen erkannt.
      const alreadySaved=(!fresh&&!next)||(fresh&&next&&fresh.status==="planned"&&samePlan(fresh,next));
      if(!unchanged&&!alreadySaved) throw Error("Der Wochenplan wurde inzwischen geändert. Bitte schließe das Fenster und öffne die Woche erneut; deine Eingaben sind hier noch sichtbar.");
    }
    return {
      remove:current.filter(p=>!want.has(p.plan_date)),
      update:desired.filter(p=>now.has(p.plan_date)&&!samePlan(now.get(p.plan_date),p)).map(p=>({...p,id:now.get(p.plan_date).id})),
      add:desired.filter(p=>!now.has(p.plan_date))
    };
  }
  function reminderWeek(today){
    const ws=monday(today),weekday=new Date(today+"T12:00:00Z").getUTCDay()||7;
    const target=weekday>=5 ? addDays(ws,7) : ws;
    return addDays(target,-3)>=FIRST_RELEASE ? target : null;
  }
  function reminderPolicy(today,saved={}){
    const weekday=new Date(today+"T12:00:00Z").getUTCDay()||7;
    return {canSnooze:(weekday===5||weekday===6)&&Number(saved.count||0)<2,
      deferred:typeof saved.until==="string"&&saved.until>today,until:addDays(today,1)};
  }
  function create(b){
    const $=b.$,esc=b.esc;let week="",base=[],reminder=false,saving=false,slots=[],drafts=new Map(),lastCheck=0;
    const dialog=$("planDialog"),weekSelect=$("planWeek"),host=$("planWeekDays");
    const today=()=>b.today ? b.today() : berlinDate();
    const savedReminder=ws=>b.getPrefs()?.weekPlanning?.[ws]||{};
    const minutesInWeek=(plans,ws,includeCancelled=false)=>plans.filter(p=>(includeCancelled||p.status!=="cancelled")&&p.plan_date>=ws&&p.plan_date<=addDays(ws,6)).reduce((sum,p)=>sum+details(p).minutes,0);
    function task(){
      if(b.state.role!=="employee"||b.state.plansUnsupported) return null;
      const ws=reminderWeek(today());if(!ws)return null;
      const real=b.state.tasks?.find(t=>t.weekPlanning&&t.weekStart===ws);
      if(real?.status==="completed"||savedReminder(ws).completed||minutesInWeek(b.state.plans,ws)===TARGET)return null;
      if(real)return real;
      return {id:"week-plan:"+ws,weekPlanning:true,weekStart:ws,title:"Bitte Folgewoche planen",description:`Plane deine Arbeitstage. Bei mehr oder weniger als sechs Stunden ist eine Begründung nötig. Geplante Woche: ${b.weekLabel(ws)}. Freitag und Samstag kannst du jeweils auf morgen verschieben. Spätestens am Sonntag ist die Planung verbindlich.`,priority:"high",status:"open",assigned_to:b.state.bootstrappedFor||"employee",created_by:"system",due_date:addDays(ws,-1)};
    }
    function collect(){
      return slots.map((slot,i)=>({...slot,date:$("weekDay"+i).value,start:$("weekStart"+i).value,hours:$("weekHours"+i).value,note:$("weekNote"+i).value}));
    }
    function remember(){if(week&&slots.length)drafts.set(week,{base,slots:collect(),reason:$("planWeekReason").value});}
    function render(ws){
      week=ws;const cached=drafts.get(ws);base=cached?.base||activeWeek(b.state.plans,ws).map(p=>({...p}));
      const preferred=base.find(p=>p.start_time)?.start_time||b.state.plans.find(p=>p.start_time)?.start_time||"18:00";
      const originals=cached?.slots||base.map(p=>({date:p.plan_date,start:p.start_time,hours:hoursValue(details(p).minutes),note:details(p).note,
        locked:p.status!=="planned"||b.startPassed(p),mustKeep:p.plan_date<=addDays(today(),1),id:p.id,status:p.status}));
      slots=Array.from({length:MAX_DAYS},(_,i)=>originals[i]||{date:"",start:preferred,hours:"2",note:"",locked:false,mustKeep:false});
      weekSelect.value=ws;$("planWeekReason").value=cached?.reason||base.map(p=>details(p).reason).find(Boolean)||"";
      host.innerHTML=slots.map((slot,i)=>{
        const options=Array.from({length:7},(_,n)=>addDays(ws,n)).map(day=>{
          const blocked=day<today()&&day!==slot.date;
          return `<option value="${day}"${day===slot.date ? " selected" : ""}${blocked ? " disabled" : ""}>${esc(b.dayLabel(day))}</option>`;
        }).join("");
        return `<fieldset class="week-plan-day" data-week-slot="${i}"><legend>Tag ${i+1}${slot.locked ? ' <span class="chip">Bereits begonnen</span>' : ""}</legend>
          <div class="week-plan-grid"><div class="field"><label for="weekDay${i}">Arbeitstag</label><select id="weekDay${i}"${slot.locked||slot.mustKeep ? " disabled" : ""}><option value="">Tag auswählen</option>${options}</select></div>
          <div class="field"><label for="weekStart${i}">Startzeit</label><input id="weekStart${i}" type="time" step="300" value="${esc(slot.start)}"${slot.locked ? " disabled" : ""}></div>
          <div class="field"><label for="weekHours${i}">Stunden</label><input id="weekHours${i}" type="text" inputmode="decimal" value="${esc(slot.hours)}" placeholder="z. B. 2 oder 2,5"${slot.locked ? " disabled" : ""}></div></div>
          <details class="week-plan-note"${slot.note ? " open" : ""}><summary>Notiz (optional)</summary><div class="field"><input id="weekNote${i}" aria-label="Notiz für Tag ${i+1}" type="text" maxlength="178" value="${esc(slot.note)}"${slot.locked ? " disabled" : ""}></div></details>
          <small class="week-plan-day-hint" id="weekHint${i}"></small></fieldset>`;
      }).join("");
      b.setStatus("planStatus",base.length>MAX_DAYS ? "Für diese Woche sind mehr als drei Einsätze vorhanden. Bitte prüfe die bestehenden Einträge einzeln." : "",base.length>MAX_DAYS);
      sync();
    }
    function sync(){
      let total=0,chosen=0,invalid=false;const days=new Set();
      slots.forEach((slot,i)=>{
        const card=host.querySelector(`[data-week-slot="${i}"]`),minutes=parseHours($("weekHours"+i).value);
        card.disabled=saving;
        const day=$("weekDay"+i).value;
        if(day){chosen++;total+=minutes||0;if(days.has(day)||!minutes)invalid=true;days.add(day);}
        $("weekHint"+i).textContent=slot.locked ? "Dieser Einsatz ist bereits begonnen und bleibt bestehen." : slot.mustKeep ? "Für diesen Tag bitte die Funktion „Absagen“ im Einsatzplan verwenden, falls du nicht arbeiten kannst." : "";
      });
      const remaining=TARGET-total;
      $("planWeekSummary").textContent=`${chosen} ${chosen===1 ? "Tag" : "Tage"} · ${b.fmtMinutes(total)} von 6:00 h geplant`+(remaining>0 ? ` · ${b.fmtMinutes(remaining)} weniger – bitte begründen` : remaining<0 ? ` · ${b.fmtMinutes(-remaining)} mehr – bitte begründen` : " · vollständig");
      $("planWeekSummary").classList.toggle("is-complete",total===TARGET&&!invalid);
      $("planWeekReasonField").hidden=total===TARGET||!chosen;
      $("planWeekReasonLabel").textContent=total<TARGET ? "Warum weniger als sechs Stunden?" : "Warum mehr als sechs Stunden?";
      $("planWeekReason").disabled=saving;
      $("planSaveBtn").disabled=saving||base.length>MAX_DAYS;
      const policy=reminderPolicy(today(),savedReminder(week));
      $("planSnoozeBtn").hidden=!reminder||!policy.canSnooze;$("planSnoozeBtn").disabled=saving;
      $("planDialogClose").hidden=reminder;$("planDialogClose").disabled=saving;
      weekSelect.disabled=reminder||saving;
      $("planReminderHint").hidden=!reminder;
      $("planReminderHint").textContent=policy.canSnooze ? "Bitte plane jetzt deine Folgewoche. Du kannst die Planung heute noch auf morgen verschieben." : "Die Wochenplanung ist jetzt fällig. Bitte speichere deine Arbeitstage. Bei mehr oder weniger als sechs Stunden brauchst du eine kurze Begründung.";
    }
    function open(planOrWeek=null,{required=false}={}){
      if(saving)return;
      const pending=task();let ws=typeof planOrWeek==="string" ? planOrWeek : planOrWeek?.plan_date ? monday(planOrWeek.plan_date) : pending?.weekStart||monday(today());
      reminder=required||!!(pending&&pending.weekStart===ws&&!reminderPolicy(today(),savedReminder(ws)).canSnooze);
      if(!dialog.open)drafts=new Map();else remember();
      const first=monday(today()),options=[];
      for(let n=0;n<9;n++){const value=addDays(first,n*7);options.push(`<option value="${value}">${esc((n===0 ? "Diese Woche · " : n===1 ? "Nächste Woche · " : "")+b.weekLabel(value))}</option>`);}
      if(!options.some(o=>o.includes(`value="${ws}"`)))options.unshift(`<option value="${ws}">${esc(b.weekLabel(ws))}</option>`);
      weekSelect.innerHTML=options.join("");b.setText("planDialogTitle",reminder ? "Bitte Folgewoche planen" : "Woche planen");b.setText("planSaveBtn","Woche speichern");
      render(ws);if(!dialog.open)b.openDialog(dialog);
    }
    async function persistProgress(update){
      const remote=await b.api("/me/prefs"),prefs={...(remote?.prefs||b.getPrefs())};
      const saved=prefs.weekPlanning&&typeof prefs.weekPlanning==="object" ? prefs.weekPlanning : {};
      const progress=update(saved[week]||{});
      prefs.weekPlanning={...saved,[week]:progress};
      const keys=Object.keys(prefs.weekPlanning).sort().slice(-12);prefs.weekPlanning=Object.fromEntries(keys.map(k=>[k,prefs.weekPlanning[k]]));
      await b.api("/me/prefs","PUT",{prefs});
      const confirmed=await b.api("/me/prefs");
      const actual=confirmed?.prefs?.weekPlanning?.[week];
      if(!actual||Object.keys(progress).some(k=>actual[k]!==progress[k]))throw Error("Der Aufschub konnte nicht geräteübergreifend gespeichert werden. Bitte versuche es erneut.");
      b.setPrefs(confirmed.prefs);return actual;
    }
    async function save(event){
      event.preventDefault();if(saving)return;
      const draft=collect().filter(s=>s.date),total=draft.reduce((sum,s)=>sum+(parseHours(s.hours)||0),0);
      try{
        if(!draft.length)throw Error("Bitte wähle mindestens einen Arbeitstag.");
        if(new Set(draft.map(s=>s.date)).size!==draft.length)throw Error("Bitte wähle jeden Arbeitstag nur einmal.");
        if(draft.some(s=>!parseHours(s.hours)))throw Error("Bitte trage gültige Stunden ein (höchstens 24 je Tag).");
        const reason=total!==TARGET ? $("planWeekReason").value.trim().replace(/\s+/g," ") : "";
        if(total!==TARGET&&!reason)throw Error("Bitte begründe kurz, warum du diese Woche mehr oder weniger als sechs Stunden einplanst.");
        const desired=draft.map(s=>({plan_date:s.date,start_time:s.start,note:encodeNote(parseHours(s.hours),s.note,reason)}));
        for(const s of desired){
          if(!/^\d{4}-\d{2}-\d{2}$/.test(s.plan_date)||s.plan_date<week||s.plan_date>addDays(week,6)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start_time))throw Error("Bitte gültige Tage und Startzeiten wählen.");
          const old=base.find(p=>p.plan_date===s.plan_date);
          if((!old||!samePlan(old,s))&&new Date(s.plan_date+"T"+s.start_time+":00")<=new Date())throw Error("Bitte wähle für neue oder geänderte Einsätze eine zukünftige Startzeit.");
        }
        saving=true;sync();b.setStatus("planStatus","Deine Woche wird gespeichert …");
        const current=activeWeek(await b.api("/plans"),week),changes=changesFor(base,current,desired);
        const modified=[...changes.remove,...changes.update];
        if(modified.some(p=>p.status&&p.status!=="planned"||current.find(c=>String(c.id)===String(p.id))&&b.startPassed(current.find(c=>String(c.id)===String(p.id)))))throw Error("Ein Einsatz wurde bereits begonnen und kann nicht mehr geändert werden. Bitte öffne die Woche erneut.");
        if(changes.remove.some(p=>p.plan_date<=addDays(today(),1)))throw Error("Einsätze heute oder morgen bitte über „Absagen“ mit Grund absagen.");
        for(const p of changes.remove)await b.api(`/plans/${p.id}`,"DELETE");
        for(const p of changes.update)await b.api(`/plans/${p.id}`,"PUT",{plan_date:p.plan_date,start_time:p.start_time,note:p.note});
        for(const p of changes.add)await b.api("/plans","POST",p);
        await b.loadPlans();
        const saved=activeWeek(b.state.plans,week);
        if(saved.length!==desired.length||desired.some(p=>!saved.some(s=>samePlan(s,p))))throw Error("Der gespeicherte Plan ist noch nicht vollständig bestätigt. Bitte erneut speichern; bereits übernommene Tage werden erkannt.");
        await b.api("/plans/week/confirm","POST",{week_start:week,reason});
        try{await persistProgress(old=>({...old,completed:true}));}catch(error){console.warn("Planungsbestätigung:",error.message);}
        if(b.loadTasks)await b.loadTasks();
        reminder=false;b.closeDialog(dialog);b.renderTasks();b.toast("Woche gespeichert ✓");
      }catch(error){
        b.setStatus("planStatus",error.message+ (saving ? " Bereits gespeicherte Tage bleiben erhalten. Du kannst erneut speichern." : ""),true);
        if(saving)await b.loadPlans();
      }finally{saving=false;sync();}
    }
    async function snooze(){
      if(saving||!reminderPolicy(today(),savedReminder(week)).canSnooze)return;
      saving=true;sync();b.setStatus("planStatus","Aufschub wird gespeichert …");
      try{await persistProgress(old=>{const p=reminderPolicy(today(),old);if(p.deferred)return old;if(!p.canSnooze)throw Error("Bitte plane die Folgewoche jetzt.");return {...old,count:Number(old.count||0)+1,until:p.until};});
        reminder=false;b.closeDialog(dialog);b.renderTasks();b.toast("Die Wochenplanung erinnert dich morgen wieder.");
      }catch(error){b.setStatus("planStatus",error.message,true);}finally{saving=false;sync();}
    }
    async function check({refresh=false}={}){
      if(b.isReady&&!b.isReady()||b.state.role!=="employee"||b.state.plansUnsupported||document.hidden||dialog.open||saving)return;
      if(document.querySelector("dialog[open]"))return;
      if(refresh){await b.loadPlans();await b.loadPrefs();if(b.loadTasks)await b.loadTasks();}
      const pending=task();if(!pending){b.renderTasks();return;}
      const p=reminderPolicy(today(),savedReminder(pending.weekStart));
      b.renderTasks();if(!p.deferred)open(pending.weekStart,{required:true});lastCheck=Date.now();
    }
    weekSelect.addEventListener("change",()=>{remember();render(weekSelect.value);});
    const changed=()=>{if(!saving)b.setStatus("planStatus","");sync();};
    $("planWeekReason").addEventListener("input",changed);
    host.addEventListener("input",changed);host.addEventListener("change",changed);
    $("planForm").addEventListener("submit",save);$("planSnoozeBtn").addEventListener("click",snooze);
    $("planDialogClose").addEventListener("click",()=>{if(!reminder&&!saving)b.closeDialog(dialog);});
    dialog.addEventListener("cancel",event=>event.preventDefault());
    const refreshCheck=()=>{if(dialog.open){if(reminder)sync();return;}if(Date.now()-lastCheck>30000)check({refresh:true}).catch(error=>console.warn("Wochenplanung:",error.message));};
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshCheck();});
    setInterval(refreshCheck,60000);
    return {open,check,task,minutesInWeek};
  }
  const exported={TARGET,MAX_DAYS,addDays,monday,berlinDate,parseHours,hoursValue,details,encodeNote,activeWeek,samePlan,changesFor,reminderWeek,reminderPolicy,create};
  root.SmartADMWeekPlanner=exported;
  if(typeof module!=="undefined"&&module.exports)module.exports=exported;
})(typeof window!=="undefined" ? window : globalThis);
