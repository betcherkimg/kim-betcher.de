/* Guided release introduction. Examples never create bookings or contract signatures. */
(function(root){'use strict';
function create(b){
 const {$,esc}=b,dialog=$('whatsNew'),body=dialog.querySelector('.whats-new-body');
 let index=0,required=false,busy=false,returnPage='dashboard';
 const spotlight=document.createElement('div');spotlight.className='intro-spotlight';spotlight.setAttribute('aria-hidden','true');dialog.prepend(spotlight);
 const progress=document.createElement('small');progress.id='introProgress';body.prepend(progress);
 const back=document.createElement('button');back.type='button';back.id='introBack';back.className='btn ghost';back.textContent='Zurück';$('whatsNewOk').before(back);
 const steps=[
  {page:'dashboard',target:()=>[...document.querySelectorAll('[data-page="kalender"]')].find(el=>el.getBoundingClientRect().width>0),circle:true,title:'Dein neuer Kalender',text:'Unten findest du das Kalendersymbol. Auf deiner Startseite gibt es außerdem das Widget „Kalender“. Dort siehst du deine Regeltage, Feiertage und genehmigten Urlaub.',example:'Nach dieser Einführung unterschreibst du den Nachtrag mit dem Finger. Danach wählst du einmal deine drei bevorzugten Regeltage von Montag bis Freitag.'},
  {page:'zeiten',target:'#regularWeekCard',title:'Drei Regeltage, keine Wochenplanung mehr',text:'Du wählst drei Wochentage mit je zwei Stunden, zum Beispiel Montag, Mittwoch und Freitag. Sie stehen automatisch in jeder Woche. Konkrete Uhrzeiten musst du nicht mehr im Voraus planen; eine laufende Start- oder Aktivitätskontrolle entfällt.',example:'Du kannst tatsächlich weiterhin andere Tage innerhalb derselben Woche nutzen. Wenn du Dienstag statt Mittwoch arbeitest, nutzt du die Mittwoch-Zeile. Im Arbeitsnachweis bleibt der tatsächliche Dienstag gespeichert.'},
  {page:'zeiten',target:'#timeCard',title:'Stunden und Termine trägst du selbst ein',text:'In jeder Wochenzeile stehen Felder für deine geleisteten Stunden und deine Termine. Office erzeugt keine Arbeitsstunden aus Anrufen oder aus deiner Planung. Du kannst bereits geleistete Arbeit sofort erfassen, auch für einen späteren Regelplatz derselben Woche.',example:'Dienstag: Du hast 1,5 Stunden gearbeitet und 3 Termine gesetzt. Du gibst in der Mittwoch-Zeile 1,5 und 3 ein und bestätigst das tatsächliche Arbeitsdatum mit Beginn, Ende und Pause. Zukünftige, noch nicht geleistete Arbeit zählt nicht als Arbeitszeit.'},
  {page:'zeiten',target:'#regularWeekCard',title:'Bis zum Absenden bleibt alles ein Entwurf',text:'Kim kann deine Einträge schon sehen, sie sind aber noch nicht fest und zählen noch nicht für die Lohnabrechnung. Solange du die Woche nicht abgesendet hast, kannst du deine Einträge prüfen, ergänzen und berichtigen. Bitte erledige das spätestens Sonntag.',example:'Dir fällt am Samstag auf, dass du einen Termin vergessen hast. Du ergänzt ihn in der Liste. Erst wenn alles vollständig ist, klickst du auf „Absenden“.'},
  {page:'zeiten',target:'#regularComplete',title:'Freitag bis Sonntag: Woche absenden',text:'Ab Freitag kannst du auf „Absenden“ klicken. Dann werden Stunden und Termine fest an Kim übermittelt und in die Lohnabrechnung übernommen. Die Bestätigung erscheint erst nach erfolgreichem Speichern. Danach kann Kim die Woche bei Bedarf begründet zur Korrektur öffnen; nach deiner Änderung sendest du erneut ab.',example:'Freitag erscheint „Heute bitte die Arbeitszeiten abschicken“. Solange die Woche offen ist: Samstag ab 12 Uhr ein Push, Sonntag um 9, 13 und 17 Uhr je eine Erinnerung. Nach dem Absenden stoppen die Erinnerungen. Push setzt eine funktionierende Freigabe am Gerät voraus.'},
  {page:'kalender',target:'#calendarDayDetails',title:'Feiertag auf deinem Regeltag: bezahlt frei',text:'Fällt ein gesetzlicher Feiertag auf einen deiner gültigen Regeltage, ist die Wochenzeile grau und zeigt „Feiertag · 2 Stunden gutgeschrieben“. Du kannst dort keine Arbeitszeit eintragen. Die zwei Stunden sind bezahlt frei und werden nicht nachgearbeitet.',example:'Deine Regeltage sind Montag, Mittwoch, Freitag. Freitag ist Feiertag: Du arbeitest in dieser Woche nur vier Stunden. Bei zwei passenden Feiertagen bleiben zwei Arbeitsstunden; bei drei bleibt keine Arbeitszeit. Ein Feiertag auf einem anderen Wochentag gibt keine zusätzliche Gutschrift.'},
  {page:'kalender',target:'#calendarPatterns',title:'Regeltage später ändern',text:'Deine Erklärung bleibt mit Datum gespeichert. Du kannst neue Regeltage wählen; die Änderung gilt ab dem ersten Tag des übernächsten Monats. Bis dahin zählen die bisherigen Tage. Kim sieht beide Fassungen mit ihrem Geltungsbeginn.',example:'Du erklärst am 10. April neue Regeltage: Sie gelten ab 1. Juni. Für Feiertage und Urlaub im Mai bleiben deine bisherigen Regeltage maßgeblich.'},
  {page:'kalender',target:'#calendarNewLeave',title:'Urlaub nur für echte Soll-Arbeitstage',text:'Im Kalender wählst du einen Zeitraum. Auswählbar sind nur deine dann gültigen Regeltage. Andere Wochentage, Samstag, Sonntag und gesetzliche Feiertage sind gesperrt. Ein abgesendeter Urlaubsantrag ist noch keine Genehmigung.',example:'Bei Montag/Mittwoch/Freitag beantragst du für eine ganze normale Arbeitswoche drei Urlaubstage. Ist Freitag ein Feiertag, beantragst du nur Montag und Mittwoch: zwei Urlaubstage plus eine Feiertagsgutschrift.'},
  {page:'kalender',target:'#calendarAccount',title:'Urlaubskonto und Genehmigung',text:'Kim prüft deinen Antrag. Erst „Genehmigt“ heißt, dass du Urlaub nehmen kannst. Der Kalender zeigt Anspruch, genehmigte Tage, offene Anträge und verfügbaren Rest getrennt. Genehmigter Urlaub ersetzt deine Sollstunden und fließt mit der berechneten Vergütung in die Abrechnung ein.',example:'Ein volles Jahr mit Dreitagewoche hat zwölf Urlaubstage. Drei genehmigte Tage lassen neun übrig. Im Eintrittsjahr und während der Wartezeit gelten andere Werte; Office zeigt deinen persönlichen Stand. Frühere Jahre verschwinden nicht beim Jahreswechsel.'},
  {page:'kalender',target:'#calendarRequests',title:'Weniger Stunden oder eine Korrektur?',text:'Wenn du weniger gearbeitet hast, trägst du deine tatsächlichen Stunden ein und erläuterst beim Absenden kurz die fehlende Zeit. Kim kann die Woche freigeben, Nacharbeit vereinbaren oder Fehlstunden einordnen. Office erklärt fehlende Angaben nicht automatisch zu unentschuldigtem Fehlen.',example:'Vier Stunden Arbeit plus zwei Stunden Feiertag erfüllen sechs Stunden. Vier Stunden ohne Gutschrift lassen zwei Stunden offen. Die tatsächlichen Angaben bleiben erhalten; die Entscheidung dazu siehst du anschließend im Wochenkonto.'},
  {page:'vertrag',target:'#addendumCard',title:'Nachtrag lesen und mit dem Finger unterschreiben',text:'Gleich öffnet sich der neue Nachtrag. Lies ihn vollständig und unterschreibe mit dem Finger. Kim unterschreibt dasselbe Dokument ebenfalls. Danach wählst du deine drei Regeltage. Die neue Regelung gilt nach beiden Unterschriften und deiner Tagesauswahl, frühestens ab 01.11.2026.',example:'Der erste Nachtrag bleibt erhalten. Den neuen Nachtrag mit beiden Unterschriften kannst du später unter „Meine Unterlagen“ als eigenes PDF herunterladen. Dein Testkonto hat eigene, als Test gekennzeichnete Dokumente und Daten.'},
  {page:'dashboard',target:null,title:'Alles verstanden?',text:'Dein Ablauf: selbst arbeiten, Stunden und Termine in deine Wochenzeilen eintragen, prüfen und spätestens Sonntag absenden. Urlaub beantragst du im Kalender. Feiertagsgutschriften zeigt Office automatisch; Kim prüft die Abrechnung.',example:'Bestätige jetzt „Ich habe die Änderungen verstanden“. Danach: Nachtrag unterschreiben → drei Regeltage wählen → normal in Office weiterarbeiten.'}
 ];
 function targetFor(step){return typeof step.target==='function'?step.target():step.target?document.querySelector(step.target):null;}
 function position(){
  if(!dialog.open)return;const step=steps[index],el=targetFor(step),rect=el?.getBoundingClientRect();
  if(!rect||rect.width===0){spotlight.hidden=true;body.style.top='50%';body.style.bottom='auto';body.style.transform='translate(-50%,-50%)';return;}
  const width=Math.min(innerWidth-20,step.circle?Math.max(rect.width,rect.height)+18:rect.width+16),height=Math.min(innerHeight*.4,step.circle?width:rect.height+16);
  const left=Math.max(10,Math.min(innerWidth-width-10,rect.left+rect.width/2-width/2)),top=Math.max(10,Math.min(innerHeight-height-10,rect.top-8));
  spotlight.hidden=false;Object.assign(spotlight.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px',borderRadius:step.circle?'50%':'16px'});
  body.style.transform='translateX(-50%)';const h=body.getBoundingClientRect().height;
  const below=top+height+16;
  if(below+h<innerHeight-14){body.style.top=below+'px';body.style.bottom='auto';}
  else if(top-h-16>=12){body.style.top=(top-h-16)+'px';body.style.bottom='auto';}
  else{body.style.top='auto';body.style.bottom='18px';}
 }
 async function render(){
  const step=steps[index];b.showPage(step.page);
  const el=targetFor(step);if(el&&!step.circle)el.scrollIntoView({block:'start',behavior:'instant'});
  $('introProgress').textContent=`Schritt ${index+1} von ${steps.length} · Was ist neu?`;
  $('whatsNewTitle').textContent=step.title;$('whatsNewIntro').textContent=step.text;
  $('whatsNewList').innerHTML=`<div class="intro-example"><b>So sieht das aus</b><p>${esc(step.example)}</p></div>`;
  const last=index===steps.length-1;$('whatsNewConfirmWrap').hidden=!last||!required;
  $('whatsNewCheckText').textContent='Ich habe die Änderungen verstanden.';
  $('whatsNewCheck').checked=false;$('whatsNewOk').textContent=last?(required?'Verstanden – weiter zum Nachtrag':'Einführung schließen'):'Weiter';
  $('whatsNewOk').disabled=last&&required;back.hidden=index===0;back.disabled=busy;$('whatsNewStatus').textContent='';
  requestAnimationFrame(()=>{position();$('whatsNewOk').focus({preventScroll:true})});
 }
 async function open(mustConfirm){
  required=Boolean(mustConfirm);index=0;returnPage=document.querySelector('.page.active')?.id||'dashboard';
  dialog.classList.add('guided-intro');dialog.setAttribute('aria-label','Geführte Einführung in Kalender und Abwesenheiten');
  if(!dialog.open)b.openDialog(dialog);await render();
 }
 async function next(){
  if(busy)return;
  if(index<steps.length-1){index++;await render();return;}
  if(required&&!$('whatsNewCheck').checked)return;
  busy=true;$('whatsNewOk').disabled=true;back.disabled=true;
  try{
   if(required)await b.acknowledge();
   b.closeDialog(dialog);b.showPage(returnPage);await b.finished(required);
  }catch(error){$('whatsNewStatus').textContent='Bestätigung konnte nicht gespeichert werden: '+error.message;$('whatsNewOk').disabled=required&&!$('whatsNewCheck').checked;}
  finally{busy=false;back.disabled=false;}
 }
 $('whatsNewOk').addEventListener('click',next);back.addEventListener('click',async()=>{if(!busy&&index>0){index--;await render()}});
 $('whatsNewCheck').addEventListener('change',()=>{if(index===steps.length-1)$('whatsNewOk').disabled=busy||(required&&!$('whatsNewCheck').checked)});
 dialog.addEventListener('cancel',e=>e.preventDefault());
 new ResizeObserver(()=>{if(dialog.open)position()}).observe(document.querySelector('#calendarAccount'));
 window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
 return {open,position,get step(){return index},count:steps.length};
}
root.OfficeIntro={create};
})(typeof window!=='undefined'?window:globalThis);
