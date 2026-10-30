(() => {
  'use strict';
  const API='https://takt30-api.betcherkimg.workers.dev', $=id=>document.getElementById(id);
  const code=new URLSearchParams(location.search).get('code') || location.pathname.match(/^\/unterschriften\/(\d+)\/?$/)?.[1];
  let drawing=false, distance=0, last=null, pending=false, busy=false;
  const canvas=$('signature'), ctx=canvas.getContext('2d');
  function update(){ $('send').disabled=busy||(!pending&&(!callbackValid()||!$('consent').checked)); }
  function callbackValid(){return distance>25;}
  function message(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
  function lockPending(){pending=true;$('drawing').hidden=true;$('pending').hidden=false;$('send').textContent='Mailversand erneut versuchen';update();}
  function done(){ $('form').hidden=true;$('done').hidden=false;message(''); }
  const point=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};};
  canvas.addEventListener('pointerdown',e=>{if(busy||pending)return;e.preventDefault();drawing=true;last=point(e);canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!drawing)return;e.preventDefault();const p=point(e);distance+=Math.hypot(p.x-last.x,p.y-last.y);ctx.strokeStyle='#151515';ctx.lineWidth=3.5;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;update();});
  ['pointerup','pointercancel','lostpointercapture'].forEach(name=>canvas.addEventListener(name,()=>{drawing=false;last=null;update();}));
  $('clear').onclick=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);distance=0;update();};
  $('consent').onchange=update;
  async function api(method,body){const r=await fetch(`${API}/public/signatures/${code}`,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const d=await r.json();if(!r.ok)throw Error(d.error||'Versand fehlgeschlagen.');return d;}
  $('send').onclick=async()=>{
    if(busy||$('send').disabled)return;
    busy=true;update();$('clear').disabled=true;$('consent').disabled=true;
    const body={confirmed:true};if(!pending)body.png=canvas.toDataURL('image/png');
    message('Unterschrift wird versendet …');
    try{await api('POST',body);done();}
    catch(e){
      message(e.name==='TimeoutError'?'Die Antwort dauert länger. Bitte den Versand erneut prüfen.':e.message||'Keine Verbindung. Bitte erneut versuchen.',true);
      // Always query the server before another attempt; a lost response may already have sent the mail.
      try{const state=await api('GET');if(state.sent)done();else if(state.pending)lockPending();}catch{}
    }finally{busy=false;$('clear').disabled=false;$('consent').disabled=false;update();}
  };
  if(!/^\d{49}$/.test(code||'')){message('Bitte öffne den persönlichen Unterschriftslink, den Kim dir geschickt hat.',true);return;}
  history.replaceState(null,'',`/unterschriften/${code}`);
  api('GET').then(data=>{ $('customer').textContent=data.customer_name;$('purpose').textContent=data.purpose;if(data.sent)return done();message('');$('form').hidden=false;if(data.pending)lockPending(); }).catch(e=>message(e.message||'Der Link konnte nicht geladen werden.',true));
})();
