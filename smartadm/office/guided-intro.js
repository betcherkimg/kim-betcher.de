/* Geführte Einführung „Was ist neu?“ – fürs Handy gebaut.
   Unten eine feste Karte (Bottom Sheet), oben wird das echte Bedienelement hervorgehoben.
   Die Beispiele lösen nichts aus: keine Buchungen, keine Unterschriften. */
(function(root){'use strict';
function create(b){
 const {$,esc}=b,dialog=$('whatsNew'),body=dialog.querySelector('.whats-new-body');
 let index=0,required=false,busy=false,rendering=false,returnPage='dashboard',raf=0;

 const steps=[
  {page:'dashboard',target:'.my-widget[data-my="einsatz"]',title:'Office ist aufgeräumt',
   text:'Neuer Look, viel weniger Text. Auf der Startseite siehst du sofort, wie viele Stunden dir diese Woche noch fehlen.'},
  {page:'zeiten',target:'#regularWeekCard',title:'Arbeitszeit mit Beginn und Ende',
   text:'Trag den Tag ein, an dem du wirklich gearbeitet hast – welcher Wochentag, ist egal. Ziel: 6 Stunden pro Woche, in einer Feiertagswoche 4.',
   example:'Dienstag 16–18 Uhr → „+ Arbeitszeit eintragen“, Beginn 16:00, Ende 18:00, Termine, Speichern.'},
  {page:'zeiten',target:'#regularComplete',title:'Ab Freitag absenden',
   text:'Bis Sonntag kannst du alles ändern, dann „Woche absenden“. Muss danach noch etwas korrigiert werden, öffnet Kim die Woche wieder.',
   example:'Steht „Uhrzeit fehlt“ da: antippen, Beginn und Ende eintragen – die alte Zeile wird ersetzt.'},
  {page:'telefon',target:'#callList',title:'Telefonliste: gleiche Abläufe, weniger Text',
   text:'Nummer antippen zählt als Versuch. Danach „Mit Termin“, „Ohne Termin“ oder „Halten“. Wischen geht weiterhin.',
   example:'Hinweis zu einem Kunden? In der Kontaktkarte auf „An Kim“.'}
 ];

 // Gerüst einmalig aufbauen: Spotlight, Fortschritt, Zurück-Knopf.
 const spot=document.createElement('div');spot.className='gi-spot';spot.setAttribute('aria-hidden','true');dialog.prepend(spot);
 const head=document.createElement('div');head.className='gi-head';
 head.innerHTML='<div class="gi-dots" aria-hidden="true"></div><small id="introProgress"></small>';body.prepend(head);
 const nav=document.createElement('div');nav.className='gi-nav';
 const back=document.createElement('button');back.type='button';back.id='introBack';back.className='btn ghost';back.textContent='Zurück';
 $('whatsNewOk').before(nav);nav.append(back,$('whatsNewOk'));

 const target=step=>step.target?document.querySelector(step.target):null;
 const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};

 function place(){
  cancelAnimationFrame(raf);
  raf=requestAnimationFrame(()=>{
   if(!dialog.open)return;
   const el=target(steps[index]),sheet=body.getBoundingClientRect();
   const topbar=document.querySelector('.topbar')?.getBoundingClientRect().bottom||0;
   if(!visible(el)){spot.classList.add('is-off');return;}
   const r=el.getBoundingClientRect(),pad=8,minTop=Math.max(8,topbar+6),maxBottom=sheet.top-12;
   const top=Math.max(minTop,r.top-pad),bottom=Math.min(maxBottom,r.bottom+pad);
   if(bottom-top<40){spot.classList.add('is-off');return;}
   spot.classList.remove('is-off');
   Object.assign(spot.style,{top:top+'px',left:Math.max(6,r.left-pad)+'px',width:Math.min(innerWidth-12,r.width+pad*2)+'px',height:(bottom-top)+'px'});
  });
 }

 // Ziel so scrollen, dass es oberhalb der Karte steht.
 function bringIntoView(el){
  if(!visible(el))return;
  const topbar=document.querySelector('.topbar')?.getBoundingClientRect().bottom||0;
  const free=body.getBoundingClientRect().top-topbar-24,r=el.getBoundingClientRect();
  const offset=r.height<free?(free-r.height)/2:0;
  window.scrollTo({top:Math.max(0,scrollY+r.top-topbar-12-offset),behavior:'instant'});
 }

 async function render(){
  const step=steps[index],last=index===steps.length-1;
  rendering=true;b.showPage(step.page);
  head.querySelector('.gi-dots').innerHTML=steps.map((_,i)=>`<span class="${i===index?'on':i<index?'done':''}"></span>`).join('');
  $('introProgress').textContent=`${index+1} von ${steps.length}`;
  $('whatsNewTitle').textContent=step.title;
  $('whatsNewIntro').textContent=step.text;
  $('whatsNewList').innerHTML=step.example?`<p class="gi-example">${esc(step.example)}</p>`:'';
  $('whatsNewConfirmWrap').hidden=!last||!required;
  $('whatsNewCheckText').textContent='Ich habe die Änderungen verstanden.';
  $('whatsNewCheck').checked=false;
  $('whatsNewOk').textContent=last?(required?'Akzeptieren':'Schließen'):'Weiter';
  $('whatsNewOk').disabled=last&&required;
  back.hidden=index===0;back.disabled=busy;$('whatsNewStatus').textContent='';
  await new Promise(r=>setTimeout(r,40)); // Seite kurz zeichnen lassen
  bringIntoView(target(step));place();rendering=false;
 }

 async function open(mustConfirm){
  required=Boolean(mustConfirm);index=0;returnPage=document.querySelector('.page.active')?.id||'dashboard';
  dialog.classList.add('guided-intro');dialog.setAttribute('aria-label','Was ist neu in Office');
  if(!dialog.open)b.openDialog(dialog);
  await render();
 }

 async function next(){
  if(busy||rendering)return;
  if(index<steps.length-1){index++;await render();return;}
  if(required&&!$('whatsNewCheck').checked)return;
  busy=true;$('whatsNewOk').disabled=true;back.disabled=true;
  try{
   if(required)await b.acknowledge();
   b.closeDialog(dialog);b.showPage(returnPage);window.scrollTo({top:0,behavior:'instant'});
   await b.finished(required);
  }catch(error){$('whatsNewStatus').textContent='Konnte nicht gespeichert werden: '+error.message;$('whatsNewOk').disabled=required&&!$('whatsNewCheck').checked;}
  finally{busy=false;back.disabled=false;}
 }

 $('whatsNewOk').addEventListener('click',next);
 back.addEventListener('click',async()=>{if(!busy&&!rendering&&index>0){index--;await render();}});
 $('whatsNewCheck').addEventListener('change',()=>{if(index===steps.length-1)$('whatsNewOk').disabled=busy||(required&&!$('whatsNewCheck').checked);});
 dialog.addEventListener('cancel',e=>e.preventDefault());
 new ResizeObserver(place).observe(body);
 window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
 return {open,position:place,get step(){return index},count:steps.length};
}
root.OfficeIntro={create};
})(typeof window!=='undefined'?window:globalThis);
