const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync('smartadm/sales/index.html','utf8'),source=html.split('/* ---------- Folgetermine ---------- */')[1].split('/* ---------- Fällige Wiedervorlagen ---------- */')[0];
function fixture(){
 let today='2026-10-28';const elements=new Map(),handlers=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:true,focus(){},addEventListener(type,fn){handlers.set(id+':'+type,fn)}});return elements.get(id)};
 const c=vm.createContext({AUSWERTUNG:[{id:1,kunde:'Testkunde',datum:'2026-10-01',status:'folgetermin',wv:today}],TERMINE:[{id:1,status:'folgetermin',wv:today}],STATUS:[],awOffen:{},heuteIso:()=>today,awSchluessel:t=>String(t.id),awGefiltert:x=>x,statusInfo:s=>({label:s,klasse:''}),terminKundenText:t=>t.kunde,terminZusatzHtml:()=>'',datumKurz:x=>x,esc:x=>String(x),document:{getElementById:el,addEventListener(){},querySelector:()=>null},oeffnen(){},schliessen(){},sichern(){},zeichnen(){},awZeichnen(){},melden(){},maengel(){},wvNachfragen(){},setTimeout:()=>1,clearTimeout(){},setInterval(){}});
 vm.runInContext(source,c);
 return {c,el,save:()=>handlers.get('folge-speichern:click')(),date:d=>today=d};
}
test('today and future follow-ups offer early result entry',()=>{
 const f=fixture();for(const date of ['2026-10-28','2026-10-30']){f.c.AUSWERTUNG[0].wv=date;const target={},counter={};f.c.folgeZeichnen(target,counter);assert.match(target.innerHTML,/data-folge-eintragen="1"/);assert.equal(f.c.folgeOhneErgebnis().length,0);}
});
test('early save persists history and status on both records; no next-day reminder, next appointment still becomes due',()=>{
 const f=fixture();f.c.folgeOeffnen('1');f.el('folge-ergebnis').value='Gespräch abgeschlossen';f.el('folge-status').value='folgetermin';f.el('folge-wv').value='2026-11-03';f.save();
 const t=f.c.AUSWERTUNG[0];assert.equal(t.folgetermine.length,1);assert.equal(t.folgetermine[0].datum,'2026-10-28');assert.equal(t.wv,'2026-11-03');assert.equal(f.c.TERMINE[0].wv,t.wv);
 f.date('2026-10-29');f.c.folgeSitzungAus={};assert.equal(f.c.folgeOhneErgebnis().length,0);
 f.date('2026-11-04');assert.equal(f.c.folgeOhneErgebnis().length,1);
});
test('completed follow-up does not remind even if its old follow-up status remains; unfinished legacy records still remind',()=>{
 const f=fixture(),t=f.c.AUSWERTUNG[0];t.folgetermine=[{datum:t.wv,ergebnis:'Ergebnis bereits gespeichert'}];f.date('2026-10-29');assert.equal(f.c.folgeOhneErgebnis().length,0);assert.equal(f.c.folgeOhneErgebnis(true).length,0);
 t.folgetermine=[];assert.equal(f.c.folgeOhneErgebnis().length,1);
});
