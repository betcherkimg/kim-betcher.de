/* =====================================================================
   Synergie-Rechner – Rechenkern
   Vergleich „nur ETF“ gegen „ETF + Bausparvertrag“ bis zur Finanzierung.
   Bausparlogik nach ABB Fuchs 06 (Bewertungszahl, Wahlzuteilung,
   Tilgungsfaktor), Finanzierung als Annuitätendarlehen wie BSHTOP.
   ===================================================================== */
(function(root){
  "use strict";

  // Werte aus den ABB Tarif Fuchs 06 (§ 2, § 3, § 4, § 6, § 11)
  var SYN_TARIFE = {
    XS06:{code:"XS06", name:"FuchsImmo (XS06)", zins:1.40, regel:45, zt:7.9, fMin:0.818, fMax:1.800, bzf:2.10, zinsplus:0,    wahlMin:25, wahlMax:55, jlb:false},
    XL06:{code:"XL06", name:"FuchsImmo (XL06)", zins:1.99, regel:40, zt:6.3, fMin:0.727, fMax:1.600, bzf:2.85, zinsplus:0,    wahlMin:25, wahlMax:55, jlb:false},
    XP06:{code:"XP06", name:"FuchsImmo (XP06)", zins:2.45, regel:45, zt:3.7, fMin:0.818, fMax:1.800, bzf:1.70, zinsplus:0,    wahlMin:25, wahlMax:55, jlb:false},
    XX06:{code:"XX06", name:"FuchsStart (XX06)", zins:2.85, regel:50, zt:6.0, fMin:0.909, fMax:2.000, bzf:4.80, zinsplus:0.25, wahlMin:25, wahlMax:55, jlb:true},
    XE06:{code:"XE06", name:"FuchsEco (XE06)", zins:2.50, regel:50, zt:6.0, fMin:0.909, fMax:2.000, bzf:4.80, zinsplus:0.25, wahlMin:25, wahlMax:55, jlb:false,
          hinweis:"FuchsEco nur für energetische Maßnahmen – sonst Umwandlung in XX06 (2,85 %)."},
    XR06:{code:"XR06", name:"FuchsSpar (XR06)", zins:3.75, regel:50, zt:4.0, fMin:1.000, fMax:2.000, bzf:2.40, zinsplus:0.85, wahlMin:25, wahlMax:50, jlb:false}
  };

  var GUTHABENZINS = 0.2;      // % p.a., Gutschrift zum Jahresende und bei Zuteilung
  var ABSCHLUSS = 1.6;         // % der Bausparsumme
  var MIN_BZ = 44;
  var JLB_BETRAG = 200;

  function r2(x){ return Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
  function r3(x){ return Math.round((x + 1e-12) * 1000) / 1000; }
  function monat(n){ return {y:Math.floor(n / 12), m:(n % 12) + 1}; }
  function nIndex(y, m){ return y * 12 + (m - 1); }

  /* ---------- Tilgungsbeitrag bei Wahlzuteilung (§ 11 Abs. 2) ---------- */
  function tilgungsfaktor(t, mindest){
    var f = t.regel / mindest;
    f = Math.min(t.fMax, Math.max(t.fMin, f));
    return r3(f);
  }
  function ztBeitrag(t, bss, mindest){
    var b = Math.ceil(bss / 1000 * t.zt * tilgungsfaktor(t, mindest) - 1e-9);
    return Math.max(20, b);
  }

  /* ---------- Steuer auf ETF-Gewinne ---------- */
  function steuersatz(kirche){
    var k = kirche ? kirche / 100 : 0;
    var est = k ? 1 / (4 + k) : 0.25;
    return est * (1 + 0.055 + k);
  }

  /* ---------- Sparphase des Bausparvertrags ----------
     o: {tarif, bss, rate, start(nIndex 1. Sparbeitrag), mindest, ende(nIndex Zuteilung oder null),
         stichtag(nIndex oder null = erster zulässiger), maxN, transfers:[{n,betrag}],
         foerd:{an, wop, asz, verh, vl, jlb}}
     Rückgabe: Verlauf je Monat, Stichtag, Zuteilung, Guthaben, Erträge                    */
  function bsvSparen(o){
    var t = o.tarif, bss = o.bss, f = o.foerd || {};
    var bal = -r2(bss * ABSCHLUSS / 100);
    var acc = 0, zpAcc = 0, zpGut = 0, fz = 0, zinsSumme = 0;
    var startJahr = monat(o.start).y;
    var aszJahr = startJahr + 7;                 // Gutschrift nach 7 Jahren Sperrfrist
    var jahre = {};                              // je Kalenderjahr: eigene Einzahlungen, vL
    var transfers = {};
    (o.transfers || []).forEach(function(tr){ transfers[tr.n] = (transfers[tr.n] || 0) + tr.betrag; });
    var zielGuthaben = bss * o.mindest / 100;
    var stichtag = o.stichtag == null ? null : o.stichtag;
    var zuteilung = stichtag == null ? null : stichtag + 3;
    var verlauf = [];
    var aszGutgeschrieben = 0, wopZut = 0, wopNach = 0, zinsplus = 0, jlb = 0;
    var vlAn = f.an && f.vl > 0;
    var maxN = o.maxN || (o.start + 12 * 40);

    for(var n = o.start; n <= maxN; n++){
      var mo = monat(n);
      var j = jahre[mo.y] || (jahre[mo.y] = {eigen:0, vl:0});
      bal += o.rate; j.eigen += o.rate;
      var waehrend = bal;
      acc += Math.max(waehrend, 0) * GUTHABENZINS / 100 / 12;
      zpAcc += Math.max(waehrend + zpGut, 0) * t.zinsplus / 100 / 12;
      fz += Math.max(waehrend, 0) * 0.01 / 12;
      if(vlAn){ bal += f.vl; j.vl += f.vl; }
      if(transfers[n]){ bal += transfers[n]; j.eigen += transfers[n]; }
      if(f.an && f.asz && vlAn && mo.m === 12 && mo.y === aszJahr && (zuteilung == null || n < zuteilung)){
        var asz = 0;
        for(var y = startJahr; y < aszJahr; y++) asz += aszJahrBetrag(jahre[y], f);
        aszGutgeschrieben = asz;
        bal += asz;
      }
      var istZuteilung = zuteilung != null && n === zuteilung;
      if(mo.m === 12 && !istZuteilung){ var z = r2(acc); bal += z; zinsSumme += z; acc = 0; zpGut = r2(zpAcc); }
      var lf = Math.min(2, Math.max(0.8, bal / (bss / 2)));
      var bz = fz / (bss / 1000) * t.bzf * lf;
      verlauf.push({n:n, guthaben:r2(bal), bz:bz});

      if(stichtag == null && bz >= MIN_BZ - 1e-9 && bal >= zielGuthaben - 1e-9 && (o.fruehester == null || n >= o.fruehester)){
        stichtag = n; zuteilung = n + 3;
      }
      if(istZuteilung){
        var zz = r2(acc); bal += zz; zinsSumme += zz; acc = 0;
        if(t.zinsplus && (n - o.start + 1) >= 60){ zinsplus = r2(zpAcc); bal += zinsplus; }
        if(f.jlb && t.jlb){ jlb = JLB_BETRAG; bal += jlb; }
        if(f.an && f.wop){
          for(var y2 = startJahr; y2 < mo.y; y2++) wopZut += wopJahrBetrag(jahre[y2], f);
          wopNach = wopJahrBetrag(jahre[mo.y], f);
          bal += wopZut;
        }
        bal = r2(bal);
        return {
          stichtag:stichtag, zuteilung:zuteilung, guthaben:bal, verlauf:verlauf,
          zinsen:r2(zinsSumme), zinsplus:zinsplus, jlb:jlb, wop:r2(wopZut), wopNach:r2(wopNach),
          asz:r2(aszGutgeschrieben), aszExtern:aszExtern(jahre, f, startJahr, mo.y), jahre:jahre,
          stichtagGuthaben:stichtagWert(verlauf, stichtag, "guthaben"), stichtagBz:stichtagWert(verlauf, stichtag, "bz")
        };
      }
    }
    return null;
  }
  function stichtagWert(verlauf, n, feld){
    for(var i = 0; i < verlauf.length; i++) if(verlauf[i].n === n) return verlauf[i][feld];
    return null;
  }
  function wopJahrBetrag(j, f){
    if(!j) return 0;
    var basis = j.eigen + (f.asz ? 0 : j.vl);
    if(basis < 50) return 0;
    var max = f.verh ? 1400 : 700;
    return r2(Math.min(basis, max) * 0.10);
  }
  // 9 % auf höchstens 470 € je Arbeitnehmer und Jahr, auf volle Euro aufgerundet.
  // Bei Verheirateten wird angenommen, dass die vL auf zwei Arbeitnehmer verteilt sind.
  function aszJahrBetrag(j, f){
    if(!j || !j.vl) return 0;
    var personen = f.verh ? 2 : 1;
    var jePerson = j.vl / personen;
    return personen * Math.ceil(Math.min(jePerson, 470) * 0.09 - 1e-9);
  }
  function aszExtern(jahre, f, startJahr, bisJahr){
    if(!f.an || !f.asz) return 0;
    var s = 0;
    for(var y = startJahr + 7; y <= bisJahr; y++) s += aszJahrBetrag(jahre[y], f);
    return s;
  }

  /* ---------- Darlehensphase des Bausparvertrags ---------- */
  function bsvDarlehen(t, bss, darlehen, mindest, zuteilung, wopNach){
    var rate = ztBeitrag(t, bss, mindest);
    var bal = darlehen, zinsen = 0, monate = 0, n = zuteilung;
    var sonderN = wopNach > 0 ? nIndex(monat(zuteilung).y + 1, 3) : null;
    var letzte = 0;
    while(bal > 0.005 && monate < 600){
      n++; monate++;
      var i = bal * t.zins / 100 / 12;
      zinsen += i;
      var zahl = Math.min(rate, bal + i);
      bal = bal + i - zahl;
      letzte = zahl;
      if(n === sonderN){ bal -= Math.min(bal, wopNach); }
    }
    return {rate:rate, zinsen:r2(zinsen), monate:monate, letzte:r2(letzte), ende:n};
  }

  /* ---------- Bankdarlehen (Annuität, monatlich, wie BSHTOP) ---------- */
  function bankDarlehen(betrag, zins, tilgung, tilgFrei, bindungJahre){
    if(!(betrag > 0)) return {betrag:0, zins:zins, rate:0, zinsen:0, zinsenBindung:0, rest:0, monate:0};
    var rate = r2(betrag * (zins + tilgung) / 100 / 12);
    var bal = betrag, zinsen = 0, zinsenB = 0, rest = null, m = 0;
    while(bal > 0.005 && m < 1200){
      m++;
      var i = r2(bal * zins / 100 / 12);
      var zahl = m <= tilgFrei ? i : Math.min(rate, bal + i);
      bal = r2(bal + i - zahl);
      zinsen += i;
      if(m <= bindungJahre * 12) zinsenB += i;
      if(m === bindungJahre * 12) rest = bal;
    }
    return {betrag:betrag, zins:zins, rate:rate, zinsen:r2(zinsen), zinsenBindung:r2(zinsenB), rest:rest == null ? 0 : rest, monate:m};
  }

  /* ---------- Zinssatz je nach Eigenkapitalquote ---------- */
  function bankZins(e, darlehen, ek){
    if(!(darlehen > 0)) return null;
    if(darlehen <= e.kleinGrenze) return {zins:e.kleinZins, rabatt:0, klein:true, quote:ek / e.bedarf * 100};
    var quote = e.bedarf > 0 ? ek / e.bedarf * 100 : 0;
    var anteil = Math.min(1, Math.max(0, quote / e.rabattAbEk));
    var rabatt = Math.round(e.rabattMax * anteil * 1000) / 1000;
    return {zins:Math.round((e.bankZins - rabatt) * 1000) / 1000, rabatt:rabatt, klein:false, quote:quote};
  }

  /* ---------- ETF-Depot ---------- */
  function etfMonatszins(renditeProzent){ return Math.pow(1 + renditeProzent / 100, 1 / 12) - 1; }

  function Depot(i){ this.i = i; this.wert = 0; this.basis = 0; this.eingezahlt = 0; }
  Depot.prototype.monat = function(beitrag){
    this.wert = (this.wert + beitrag) * (1 + this.i);
    this.basis += beitrag; this.eingezahlt += beitrag;
  };
  // Verkauft so viel, dass netto „netto“ übrig bleibt (Steuer auf den Gewinnanteil)
  Depot.prototype.verkaufen = function(netto, steuer, pausch){
    if(netto <= 0) return {brutto:0, steuer:0, gewinn:0};
    var brutto = netto, stz = 0, gewinn = 0;
    for(var k = 0; k < 6; k++){
      var anteil = this.wert > 0 ? Math.min(1, brutto / this.wert) : 0;
      gewinn = brutto - this.basis * anteil;
      stz = steuer ? Math.max(0, gewinn * 0.7 - pausch.rest) * steuer : 0;
      brutto = netto + stz;
    }
    var anteilEnd = this.wert > 0 ? Math.min(1, brutto / this.wert) : 0;
    if(steuer){ pausch.rest = Math.max(0, pausch.rest - Math.max(0, gewinn * 0.7)); }
    this.basis -= this.basis * anteilEnd;
    this.wert -= brutto;
    return {brutto:brutto, steuer:stz, gewinn:gewinn};
  };
  Depot.prototype.alles = function(steuer, pausch){
    var anteilGewinn = this.wert - this.basis;
    var stz = steuer ? Math.max(0, anteilGewinn * 0.7 - pausch.rest) * steuer : 0;
    if(steuer) pausch.rest = Math.max(0, pausch.rest - Math.max(0, anteilGewinn * 0.7));
    var netto = this.wert - stz;
    var res = {brutto:this.wert, steuer:stz, netto:netto, gewinn:anteilGewinn};
    this.wert = 0; this.basis = 0;
    return res;
  };

  /* ---------- Gesamtrechnung ---------- */
  function standard(){
    var heute = new Date();
    return {
      bedarf:400000, bss:100000, sparrate:300, jahre:10, rendite:7.22, etfAnteil:50,
      tarif:"XX06", bankZins:4.8,
      verh:false, wop:false, asz:false, vl:0, jlb:false, foerderungEinrechnen:false,
      steuer:true, kirche:0,
      rabattMax:0.5, rabattAbEk:25, kleinGrenze:50000, kleinZins:4.9,
      tilgung:2, bindung:10, tilgFrei:2, blanko:50000, mindest:null,
      beginnJahr:heute.getFullYear(), beginnMonat:heute.getMonth() + 1
    };
  }

  function autoMindest(t, bss, blanko){
    var darl = Math.min(blanko, bss * (1 - t.wahlMin / 100));
    var pct = Math.ceil((bss - darl) / bss * 100 - 1e-9);
    return Math.min(t.wahlMax, Math.max(t.wahlMin, pct));
  }

  function rechnen(eingabe){
    var e = Object.assign(standard(), eingabe || {});
    var t = SYN_TARIFE[e.tarif] || SYN_TARIFE.XX06;
    var warn = [];
    var start = nIndex(e.beginnJahr, e.beginnMonat) + 1;       // 1. Sparbeitrag im Folgemonat
    var monate = Math.max(12, Math.round(e.jahre * 12));
    var zielZut = start + monate - 1;
    var i = etfMonatszins(e.rendite);
    var stz = e.steuer ? steuersatz(e.kirche) : 0;
    var pauschJahr = e.verh ? 2000 : 1000;
    var etfRate2 = r2(e.sparrate * e.etfAnteil / 100);
    var bsvRate = r2(e.sparrate - etfRate2);
    var mindestWunsch = e.mindest ? Math.min(t.wahlMax, Math.max(t.wahlMin, Math.round(e.mindest))) : autoMindest(t, e.bss, e.blanko);
    var foerd = {an:!!e.foerderungEinrechnen, wop:!!e.wop, asz:!!e.asz, verh:!!e.verh, vl:+e.vl || 0, jlb:!!e.jlb && t.jlb};

    // Bausparvertrag: spätester Monat für die Einmalzahlung aus dem ETF, mit dem
    // Mindestguthaben und Bewertungszahl (44) am Bewertungsstichtag erreicht sind.
    function planFuer(anteilEtf, mProz, sVon, sBis){
      var rEtf = r2(e.sparrate * anteilEtf / 100), rBsv = r2(e.sparrate - rEtf);
      var probe = new Depot(i), wertBis = {}, basisBis = {};
      for(var n = start; n <= sBis; n++){ probe.monat(rEtf); wertBis[n] = probe.wert; basisBis[n] = probe.basis; }
      var ziel = e.bss * mProz / 100;
      for(var s = sVon; s <= sBis; s++){
        var ohne = bsvSparen({tarif:t, bss:e.bss, rate:rBsv, start:start, mindest:mProz, stichtag:s, foerd:foerd, maxN:s + 3});
        if(!ohne) continue;
        var gS = ohne.stichtagGuthaben, bzS = ohne.stichtagBz;
        if(gS >= ziel - 1e-9 && bzS >= MIN_BZ) return {s:s, m:mProz, transfer:null, sp:ohne};
        var betrag = Math.ceil(ziel - gS - 1e-9);
        for(var tn = s; tn >= start; tn--){
          var g = wertBis[tn] > 0 ? Math.max(0, 1 - basisBis[tn] / wertBis[tn]) : 0;
          if(wertBis[tn] < betrag / (1 - stz * 0.7 * g)) break;
          var mit = bsvSparen({tarif:t, bss:e.bss, rate:rBsv, start:start, mindest:mProz, stichtag:s, foerd:foerd, maxN:s + 3,
                               transfers:[{n:tn, betrag:betrag}]});
          if(mit && mit.stichtagGuthaben >= ziel - 1e-9 && mit.stichtagBz >= MIN_BZ) return {s:s, m:mProz, transfer:{n:tn, betrag:betrag}, sp:mit};
        }
      }
      return null;
    }

    // 1. Wunsch-Mindestguthaben (Blanko-Grenze) zum Wunschtermin,
    // 2. sonst niedrigeres Mindestguthaben (Wahlzuteilung bis 25 %) zum Wunschtermin,
    // 3. sonst spätere Zuteilung.
    var s0 = zielZut - 3, plan = null;
    var mUnten = e.mindest ? mindestWunsch : t.wahlMin;
    for(var mp = mindestWunsch; mp >= mUnten && !plan; mp--) plan = planFuer(e.etfAnteil, mp, s0, s0);
    if(!plan) plan = planFuer(e.etfAnteil, mindestWunsch, s0 + 1, s0 + 72);
    if(!plan){
      warn.push("Mit diesen Werten wird der Bausparvertrag in den nächsten Jahren nicht zuteilungsreif – bitte Sparrate, Anteil oder Laufzeit anpassen.");
      return {eingabe:e, tarif:t, fehler:true, warnungen:warn};
    }
    var tipp = null;
    if(plan.m < mindestWunsch || plan.s > s0){
      // Was wäre nötig, damit es mit dem Wunsch-Mindestguthaben zum Wunschtermin klappt?
      for(var a2 = Math.round(e.etfAnteil) - 1; a2 >= 0; a2--){
        if(planFuer(a2, mindestWunsch, s0, s0)){ tipp = {etfAnteil:a2}; break; }
      }
      if(plan.s === s0){
        var spaeter = planFuer(e.etfAnteil, mindestWunsch, s0 + 1, s0 + 72);
        if(spaeter){ tipp = tipp || {}; tipp.zuteilung = spaeter.s + 3; }
      }
    }
    var mindest = plan.m;
    if(mindest < mindestWunsch) warn.push("Zum Wunschtermin reicht es nur für " + mindest + " % Mindestguthaben (Wahlzuteilung) statt " + mindestWunsch + " % – dadurch höheres Bauspardarlehen und höhere Rate.");
    if(tipp){
      var tt = [];
      if(tipp.etfAnteil != null) tt.push("ETF-Anteil auf " + tipp.etfAnteil + " % senken (Bausparen " + (100 - tipp.etfAnteil) + " %)");
      if(tipp.zuteilung){ var mt = monat(tipp.zuteilung); tt.push("Zuteilung erst " + ("0" + mt.m).slice(-2) + "/" + mt.y + " einplanen"); }
      if(tt.length) warn.push("Für " + mindestWunsch + " % Mindestguthaben zum Wunschtermin: " + tt.join(" oder ") + ".");
    }
    var sp = plan.sp;
    var zut = sp.zuteilung;
    if(zut > zielZut){
      var mz = monat(zut);
      warn.push("Zuteilung frühestens " + ("0" + mz.m).slice(-2) + "/" + mz.y + " – " + (zut - zielZut) + " Monat(e) später als gewünscht. Beide Varianten rechnen bis zu diesem Zeitpunkt.");
    }
    var bsvDarl = Math.max(0, r2(e.bss - sp.guthaben));
    var dar = bsvDarl > 0 ? bsvDarlehen(t, e.bss, bsvDarl, mindest, zut, foerd.an && foerd.wop ? sp.wopNach : 0)
                          : {rate:0, zinsen:0, monate:0, letzte:0, ende:zut};
    if(bsvDarl > e.blanko + 0.005) warn.push("Bauspardarlehen über " + e.blanko.toLocaleString("de-DE") + " € – nicht mehr als Blankodarlehen darstellbar.");
    if(t.hinweis) warn.push(t.hinweis);
    var abschluss = r2(e.bss * ABSCHLUSS / 100);
    var bsvKosten = r2(abschluss + dar.zinsen - sp.zinsen - sp.zinsplus - sp.jlb);

    // ---------- Variante 1: nur ETF ----------
    var pausch1 = {}; function pj(store, y){ if(!(y in store)) store[y] = {rest:pauschJahr}; return store[y]; }
    var d1 = new Depot(i);
    for(var n1 = start; n1 <= zut; n1++) d1.monat(e.sparrate);
    var eingez1 = d1.eingezahlt;
    var verk1 = d1.alles(stz, pj(pausch1, monat(zut).y));
    var ek1 = Math.min(verk1.netto, e.bedarf);
    var darl1 = r2(Math.max(0, e.bedarf - ek1));
    var z1 = bankZins(e, darl1, ek1);
    var bank1 = bankDarlehen(darl1, z1 ? z1.zins : 0, e.tilgung, e.tilgFrei, e.bindung);
    var zuwachs1 = r2(verk1.netto - eingez1);

    // ---------- Variante 2: ETF + Bausparen ----------
    var pausch2 = {};
    var d2 = new Depot(i), entnahme = null;
    for(var n2 = start; n2 <= zut; n2++){
      d2.monat(etfRate2);
      if(plan.transfer && plan.transfer.n === n2){
        entnahme = d2.verkaufen(plan.transfer.betrag, stz, pj(pausch2, monat(n2).y));
        entnahme.netto = plan.transfer.betrag; entnahme.n = n2;
      }
    }
    var eingez2 = d2.eingezahlt;
    var verk2 = d2.alles(stz, pj(pausch2, monat(zut).y));
    var ek2 = Math.min(e.bss + verk2.netto, e.bedarf);
    var darl2 = r2(Math.max(0, e.bedarf - e.bss - verk2.netto));
    var z2 = bankZins(e, darl2, ek2);
    var bank2 = bankDarlehen(darl2, z2 ? z2.zins : 0, e.tilgung, e.tilgFrei, e.bindung);
    var steuer2 = (entnahme ? entnahme.steuer : 0) + verk2.steuer;
    var zuwachs2 = r2(verk2.netto + (entnahme ? entnahme.netto : 0) - eingez2);

    function saldo(zuwachs, bank, extra, bindung){
      return r2(zuwachs - (bindung ? bank.zinsenBindung : bank.zinsen) - extra);
    }
    var saldo1 = saldo(zuwachs1, bank1, 0, false), saldo2 = saldo(zuwachs2, bank2, bsvKosten, false);
    var saldo1B = saldo(zuwachs1, bank1, 0, true), saldo2B = saldo(zuwachs2, bank2, bsvKosten, true);

    // Förderung (nur Anzeige, keine Rendite)
    var vlSumme = 0, wopGesamt = 0, aszGesamt = 0;
    var jahreF = {};
    for(var nf = start; nf <= zut; nf++){
      var yf = monat(nf).y;
      var jf = jahreF[yf] || (jahreF[yf] = {eigen:0, vl:0});
      jf.eigen += bsvRate; jf.vl += (+e.vl || 0); vlSumme += (+e.vl || 0);
    }
    if(plan.transfer){ var yt = monat(plan.transfer.n).y; if(jahreF[yt]) jahreF[yt].eigen += plan.transfer.betrag; }
    var fAnz = {verh:e.verh, asz:e.asz, vl:+e.vl || 0};
    Object.keys(jahreF).forEach(function(y){
      if(e.wop) wopGesamt += wopJahrBetrag(jahreF[y], fAnz);
      if(e.asz && e.vl > 0) aszGesamt += aszJahrBetrag(jahreF[y], fAnz);
    });

    return {
      eingabe:e, tarif:t, warnungen:warn, fehler:false,
      start:start, zuteilung:zut, stichtag:sp.stichtag, jahreEffektiv:(zut - start + 1) / 12,
      v1:{
        etfRate:e.sparrate, eingezahlt:r2(eingez1), endwert:r2(verk1.brutto), steuer:r2(verk1.steuer), netto:r2(verk1.netto),
        zuwachs:zuwachs1, ek:r2(ek1), darlehen:darl1, zins:z1, bank:bank1,
        rateMonat:bank1.rate, saldo:saldo1, saldoBindung:saldo1B
      },
      v2:{
        etfRate:etfRate2, bsvRate:bsvRate, eingezahltEtf:r2(eingez2),
        entnahme:entnahme ? {n:entnahme.n, netto:r2(entnahme.netto), brutto:r2(entnahme.brutto), steuer:r2(entnahme.steuer)} : null,
        etfRest:r2(verk2.brutto), etfRestNetto:r2(verk2.netto), steuer:r2(steuer2), zuwachs:zuwachs2,
        bsv:{
          mindest:mindest, guthaben:sp.guthaben, darlehen:bsvDarl, rate:dar.rate, monate:dar.monate, letzte:dar.letzte, ende:dar.ende,
          abschluss:abschluss, sollzinsen:dar.zinsen, guthabenzinsen:sp.zinsen, zinsplus:sp.zinsplus, jlb:sp.jlb,
          kosten:bsvKosten, kostenProzent:r2(bsvKosten / e.bss * 100), stichtagBz:sp.stichtagBz,
          wop:sp.wop, asz:sp.asz
        },
        ek:r2(ek2), darlehen:darl2, zins:z2, bank:bank2,
        rateMonat:r2(bank2.rate + dar.rate), saldo:saldo2, saldoBindung:saldo2B
      },
      vorteil:r2(saldo2 - saldo1), vorteilBindung:r2(saldo2B - saldo1B),
      foerderung:{vl:r2(vlSumme), wop:r2(wopGesamt), asz:aszGesamt, eingerechnet:foerd.an}
    };
  }

  var API = {TARIFE:SYN_TARIFE, rechnen:rechnen, standard:standard, bsvSparen:bsvSparen, bsvDarlehen:bsvDarlehen,
             bankDarlehen:bankDarlehen, ztBeitrag:ztBeitrag, nIndex:nIndex, monat:monat, autoMindest:autoMindest};
  if(typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Synergie = API;
})(typeof window !== "undefined" ? window : this);

/* =====================================================================
   Synergie-Rechner – Oberfläche (SmartADM Sales)
   ===================================================================== */
(function(){
  "use strict";
  if(typeof document === "undefined" || !document.getElementById("seite-synergie")) return;
  var S = window.Synergie;
  var ABLAGE_SYN = "smartadm.synergie";
  var seite = document.getElementById("seite-synergie");
  var E = S.standard();
  var sicht = "gesamt";
  var experte = false;
  var letztes = null;

  function lesenSpeicher(){
    try{
      var roh = window.SPEICHER ? SPEICHER.lesen(ABLAGE_SYN) : null;
      if(!roh) return;
      var d = JSON.parse(roh);
      if(d && d.e) Object.keys(S.standard()).forEach(function(k){ if(k in d.e && k !== "beginnJahr" && k !== "beginnMonat") E[k] = d.e[k]; });
      if(d && d.sicht) sicht = d.sicht;
      if(d && typeof d.experte === "boolean") experte = d.experte;
    }catch(err){}
  }
  function schreibenSpeicher(){
    try{
      var e = Object.assign({}, E); delete e.beginnJahr; delete e.beginnMonat;
      if(window.SPEICHER) SPEICHER.schreiben(ABLAGE_SYN, JSON.stringify({e:e, sicht:sicht, experte:experte}));
    }catch(err){}
  }

  function h(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  // Punkte sind immer Tausendertrenner (egal wo sie stehen), das Komma ist das Dezimalzeichen.
  // Nur bei Prozent- und Jahresfeldern gilt ein einzelner Punkt ohne Komma als Dezimalpunkt (7.22).
  var DEZIMAL_PUNKT = {rendite:1, etfAnteil:1, bankZins:1, jahre:1, rabattMax:1, rabattAbEk:1, kleinZins:1, tilgung:1, mindest:1};
  function zahl(text, feld){
    var t = String(text == null ? "" : text).trim().replace(/\s/g, "").replace(/€|%/g, "");
    if(t === "") return null;
    if(t.indexOf(",") >= 0) t = t.replace(/\./g, "").replace(",", ".");
    else if(DEZIMAL_PUNKT[feld] && (t.match(/\./g) || []).length === 1) t = t;
    else t = t.replace(/\./g, "");
    var z = parseFloat(t);
    return isNaN(z) ? null : z;
  }
  function de(x, nach){ return (Number(x) || 0).toLocaleString("de-DE", {minimumFractionDigits:nach || 0, maximumFractionDigits:nach == null ? 2 : nach}); }
  function eur(x){ return de(Math.round(x), 0) + " €"; }
  function eur2(x){ return de(x, 2) + " €"; }
  function proz(x, n){ return (Number(x) || 0).toLocaleString("de-DE", {minimumFractionDigits:n == null ? 2 : n, maximumFractionDigits:n == null ? 3 : n}) + " %"; }
  function mon(n){ var m = S.monat(n); return ("0" + m.m).slice(-2) + "/" + m.y; }
  function dauer(monate){ var j = Math.floor(monate / 12), m = monate % 12; return j + " J." + (m ? " " + m + " M." : ""); }
  function vorzeichen(x){ return (x > 0 ? "+" : x < 0 ? "−" : "") + eur(Math.abs(x)); }

  var FORMAT = {bedarf:0, bss:0, sparrate:2, jahre:1, rendite:2, etfAnteil:1, bankZins:3, vl:2, rabattMax:3, rabattAbEk:1,
                kleinGrenze:0, kleinZins:3, tilgung:2, bindung:0, tilgFrei:0, blanko:0, mindest:0};
  function feldText(k){
    if(k === "mindest" && !E.mindest) return "";
    var v = E[k];
    if(v == null || v === "") return "";
    return Number(v).toLocaleString("de-DE", {maximumFractionDigits:FORMAT[k] == null ? 2 : FORMAT[k]});
  }

  function tarifeFuellen(){
    var sel = document.getElementById("syn-tarif");
    sel.innerHTML = Object.keys(S.TARIFE).map(function(k){
      var t = S.TARIFE[k];
      return '<option value="' + k + '">' + h(t.name) + ' – ' + de(t.zins, 2) + ' %</option>';
    }).join("");
  }

  function formularFuellen(){
    seite.querySelectorAll("[data-syn]").forEach(function(el){
      var k = el.getAttribute("data-syn");
      if(el.type === "checkbox") el.checked = !!E[k];
      else if(el.tagName === "SELECT") el.value = String(E[k]);
      else if(document.activeElement !== el) el.value = feldText(k);
    });
    seite.querySelectorAll("[data-verh]").forEach(function(b){ b.setAttribute("aria-pressed", (b.getAttribute("data-verh") === "1") === !!E.verh ? "true" : "false"); });
    var jlbMoeglich = !!(S.TARIFE[E.tarif] && S.TARIFE[E.tarif].jlb);
    var jlbZeile = document.getElementById("syn-jlb-zeile");
    jlbZeile.classList.toggle("aus", !jlbMoeglich);
    jlbZeile.querySelector("input").disabled = !jlbMoeglich;
    document.getElementById("syn-experte-karte").hidden = !experte;
    document.getElementById("syn-experte").setAttribute("aria-pressed", experte ? "true" : "false");
    var etf = E.sparrate * E.etfAnteil / 100;
    document.getElementById("syn-anteil-hilfe").textContent = eur2(etf) + " in den ETF, " + eur2(E.sparrate - etf) + " in den Bausparvertrag";
  }

  var GRENZEN = {bedarf:[0, 1e8], bss:[10000, 1e7], sparrate:[10, 1e5], jahre:[1, 40], rendite:[-20, 30], etfAnteil:[0, 100], bankZins:[0, 20],
                 vl:[0, 1000], rabattMax:[0, 5], rabattAbEk:[1, 100], kleinGrenze:[0, 1e7], kleinZins:[0, 20], tilgung:[0.5, 20],
                 bindung:[1, 40], tilgFrei:[0, 24], blanko:[0, 1e7], mindest:[25, 55]};
  function uebernehmen(el){
    var k = el.getAttribute("data-syn");
    if(el.type === "checkbox"){ E[k] = el.checked; return true; }
    if(el.tagName === "SELECT"){ E[k] = k === "kirche" ? Number(el.value) : el.value; return true; }
    var z = zahl(el.value, k);
    if(k === "mindest"){ E.mindest = z == null ? null : Math.min(55, Math.max(25, Math.round(z))); return true; }
    if(z == null) return false;
    var g = GRENZEN[k];
    if(g) z = Math.min(g[1], Math.max(g[0], z));
    E[k] = z;
    return true;
  }

  var uhr = null;
  function spaeterRechnen(){ clearTimeout(uhr); uhr = setTimeout(rechnenUndZeigen, 160); }

  seite.addEventListener("input", function(ev){
    var el = ev.target.closest("[data-syn]");
    if(!el) return;
    if(uebernehmen(el)){ formularFuellen(); spaeterRechnen(); }
  });
  seite.addEventListener("change", function(ev){
    var el = ev.target.closest("[data-syn]");
    if(!el) return;
    uebernehmen(el);
    if(el.getAttribute("data-syn") === "tarif" && !(S.TARIFE[E.tarif] || {}).jlb) E.jlb = false;
    formularFuellen(); rechnenUndZeigen();
  });
  seite.addEventListener("focusout", function(ev){
    var el = ev.target.closest("input[data-syn]");
    if(el && el.type !== "checkbox") el.value = feldText(el.getAttribute("data-syn"));
  });
  seite.addEventListener("click", function(ev){
    var b = ev.target.closest("[data-verh]");
    if(b){ E.verh = b.getAttribute("data-verh") === "1"; formularFuellen(); rechnenUndZeigen(); return; }
    var s = ev.target.closest("[data-sicht]");
    if(s){ sicht = s.getAttribute("data-sicht"); schreibenSpeicher(); zeigen(letztes); return; }
  });
  document.getElementById("syn-experte").addEventListener("click", function(){
    experte = !experte; formularFuellen(); schreibenSpeicher();
  });
  document.getElementById("syn-reset").addEventListener("click", function(){
    E = S.standard(); sicht = "gesamt";
    formularFuellen(); rechnenUndZeigen();
    if(typeof melden === "function") melden("Synergie-Rechner zurückgesetzt");
  });

  function rechnenUndZeigen(){
    var heute = new Date();
    E.beginnJahr = heute.getFullYear(); E.beginnMonat = heute.getMonth() + 1;
    try{ letztes = S.rechnen(E); }catch(err){ letztes = {fehler:true, warnungen:["Die Berechnung ist fehlgeschlagen: " + err.message]}; }
    schreibenSpeicher();
    zeigen(letztes);
  }

  function zeile(label, wert, klasse, unter){
    return '<div class="syn-zeile' + (klasse ? " " + klasse : "") + '"><span>' + label + (unter ? '<em>' + unter + '</em>' : '') + '</span><b>' + wert + '</b></div>';
  }
  function betragZeile(label, x, unter, art){
    var kl = art === "kosten" ? (x > 0 ? "syn-minus" : "") : (x >= 0 ? "syn-plus" : "syn-minus");
    var txt = art === "kosten" ? (x > 0 ? "−" + eur(x) : eur(0)) : vorzeichen(x);
    return '<div class="syn-zeile"><span>' + label + (unter ? '<em>' + unter + '</em>' : '') + '</span><b class="' + kl + '">' + txt + '</b></div>';
  }
  function zinsText(z){
    if(!z) return {wert:"–", unter:"kein Bankdarlehen nötig"};
    if(z.klein) return {wert:proz(z.zins), unter:"Kleindarlehen – ohne Rabatt"};
    return {wert:proz(z.zins), unter:"Rabatt " + proz(z.rabatt) + " bei " + proz(z.quote, 1) + " Eigenkapital"};
  }

  function zeigen(r){
    var ziel = document.getElementById("syn-ergebnis");
    if(!r) { ziel.innerHTML = ""; return; }
    if(r.fehler){
      ziel.innerHTML = '<div class="syn-fehler">' + (r.warnungen || []).map(h).join("<br>") + '</div>';
      return;
    }
    var e = r.eingabe, v1 = r.v1, v2 = r.v2, b = v2.bsv;
    var bindung = sicht === "bindung";
    var vorteil = bindung ? r.vorteilBindung : r.vorteil;
    var anderer = bindung ? r.vorteil : r.vorteilBindung;
    var zk = function(bank){ return bindung ? bank.zinsenBindung : bank.zinsen; };
    var zkText = bindung ? "Zinskosten Bank (" + e.bindung + " J. Zinsbindung)" : "Zinskosten Bank (gesamte Laufzeit)";
    var html = '';

    html += '<div class="syn-vorteil' + (vorteil < 0 ? " negativ" : "") + '"><span>Dein Vorteil durch Variante 2</span><b>' + vorzeichen(vorteil) + '</b>'
         +  '<small>' + (bindung ? "Betrachtung über die Zinsbindung von " + e.bindung + " Jahren" : "Betrachtung über die gesamte Laufzeit der Finanzierung")
         +  ' · ' + (bindung ? "gesamte Laufzeit: " : "nur Zinsbindung: ") + vorzeichen(anderer) + '</small></div>';

    html += '<div class="syn-sicht"><div class="syn-seg" role="group" aria-label="Betrachtungszeitraum">'
         +  '<button type="button" data-sicht="gesamt" aria-pressed="' + (!bindung) + '">Gesamtlaufzeit</button>'
         +  '<button type="button" data-sicht="bindung" aria-pressed="' + bindung + '">Zinsbindung (' + e.bindung + ' J.)</button></div>'
         +  '<p>Finanzierung ab ' + mon(r.zuteilung + 1) + ' · Ansparzeit ' + dauer(r.zuteilung - r.start + 1) + '</p></div>';

    // Variante 1
    var z1 = zinsText(v1.zins);
    var h1 = '<div class="syn-var v1"><h4>Variante 1 – Nur ETF<small>Alles in den ETF, Rest über die Bank</small></h4>'
      + '<div class="syn-gruppe">Ansparen bis ' + mon(r.zuteilung) + '</div>'
      + zeile("Sparrate ETF", eur2(v1.etfRate) + " / Monat")
      + zeile("Eingezahlt", eur(v1.eingezahlt))
      + zeile("ETF-Wert bei Finanzierung", eur(v1.endwert))
      + (e.steuer ? betragZeile("Abgeltungsteuer beim Verkauf", v1.steuer, null, "kosten") : "")
      + '<div class="syn-zeile zwischen"><span>Wertzuwachs' + (e.steuer ? " nach Steuer" : "") + '</span><b class="syn-plus">' + vorzeichen(v1.zuwachs) + '</b></div>'
      + '<div class="syn-gruppe">Finanzierung</div>'
      + zeile("Eigenkapital", eur(v1.ek))
      + zeile("Bankdarlehen", eur(v1.darlehen))
      + zeile("Zinssatz", z1.wert, "", z1.unter)
      + zeile("Monatsrate", eur2(v1.rateMonat))
      + betragZeile(zkText, zk(v1.bank), null, "kosten")
      + '<div class="syn-zeile saldo"><span>Saldo Variante 1</span><b class="' + ((bindung ? v1.saldoBindung : v1.saldo) >= 0 ? "syn-plus" : "syn-minus") + '">' + vorzeichen(bindung ? v1.saldoBindung : v1.saldo) + '</b></div>'
      + '</div>';

    // Variante 2
    var z2 = zinsText(v2.zins);
    var blankoOk = b.darlehen <= e.blanko + 0.005;
    var h2 = '<div class="syn-var v2"><h4>Variante 2 – ETF + Bausparen<small>' + h(r.tarif.name) + ' über ' + eur(e.bss) + '</small></h4>'
      + '<div class="syn-gruppe">Ansparen bis ' + mon(r.zuteilung) + '</div>'
      + zeile("Sparrate ETF + Bausparen", eur2(v2.etfRate) + " + " + eur2(v2.bsvRate))
      + (v2.entnahme ? zeile("Einmalzahlung ETF → Bausparvertrag", eur(v2.entnahme.netto), "", mon(v2.entnahme.n) + (e.steuer && v2.entnahme.steuer > 0 ? " · Steuer beim Verkauf " + eur(v2.entnahme.steuer) : ""))
                     : zeile("Einmalzahlung ETF → Bausparvertrag", "nicht nötig"))
      + zeile("ETF-Rest bei Finanzierung", eur(v2.etfRest))
      + '<div class="syn-zeile zwischen"><span>Wertzuwachs ETF' + (e.steuer ? " nach Steuer" : "") + '</span><b class="' + (v2.zuwachs >= 0 ? "syn-plus" : "syn-minus") + '">' + vorzeichen(v2.zuwachs) + '</b></div>'
      + '<div class="syn-gruppe">Bausparvertrag</div>'
      + zeile("Guthaben bei Zuteilung", eur(b.guthaben), "", "Zuteilung " + mon(r.zuteilung) + " · Mindestguthaben " + b.mindest + " %")
      + zeile("Bauspardarlehen", eur(b.darlehen), "", b.darlehen > 0 ? (blankoOk ? "blanko bis " + eur(e.blanko) : "über der Blanko-Grenze") : "")
      + (b.darlehen > 0 ? zeile("Zins- und Tilgungsbeitrag", eur2(b.rate) + " / Monat", "", dauer(b.monate) + " · Sollzins " + proz(r.tarif.zins)) : "")
      + betragZeile("Kosten Bausparvertrag", b.kosten, null, "kosten")
      + '<div class="syn-zeile" style="padding-top:0"><span><em>' + de(b.kostenProzent, 2) + ' % der Bausparsumme: Abschlussgebühr ' + eur(b.abschluss) + ' + Sollzinsen ' + eur(b.sollzinsen)
          + ' − Guthabenzins ' + eur(b.guthabenzinsen) + (b.zinsplus ? ' − Zinsplus ' + eur(b.zinsplus) : '') + (b.jlb ? ' − Junge-Leute-Bonus ' + eur(b.jlb) : '') + '</em></span><b></b></div>'
      + '<div class="syn-gruppe">Finanzierung</div>'
      + zeile("Eigenkapital", eur(v2.ek), "", "Bausparsumme + ETF-Rest")
      + zeile("Bankdarlehen", eur(v2.darlehen))
      + zeile("Zinssatz", z2.wert, "", z2.unter)
      + zeile("Monatsrate", eur2(v2.rateMonat), "", b.darlehen > 0 ? "Bank " + eur2(v2.bank.rate) + " + Bausparen " + eur2(b.rate) + " für " + dauer(b.monate) : "")
      + betragZeile(zkText, zk(v2.bank), null, "kosten")
      + '<div class="syn-zeile saldo"><span>Saldo Variante 2</span><b class="' + ((bindung ? v2.saldoBindung : v2.saldo) >= 0 ? "syn-plus" : "syn-minus") + '">' + vorzeichen(bindung ? v2.saldoBindung : v2.saldo) + '</b></div>'
      + '</div>';

    html += '<div class="syn-varianten">' + h1 + h2 + '</div>';

    if(r.warnungen && r.warnungen.length){
      html += '<div class="syn-hinweise"><ul>' + r.warnungen.map(function(w){ return '<li>' + h(w) + '</li>'; }).join("") + '</ul></div>';
    }

    var f = r.foerderung;
    if(e.wop || e.asz || e.vl > 0){
      html += '<div class="syn-foerd"><h4>F&ouml;rderung &amp; Arbeitgeberleistungen bis zur Zuteilung</h4>'
        + (e.vl > 0 ? zeile("Vermögenswirksame Leistungen vom Arbeitgeber", eur(f.vl)) : "")
        + (e.asz ? zeile("Arbeitnehmersparzulage", e.vl > 0 ? eur(f.asz) : "– (keine vL)") : "")
        + (e.wop ? zeile("Wohnungsbauprämie", eur(f.wop)) : "")
        + '<p>' + (f.eingerechnet ? "Ist im Bausparguthaben eingerechnet (wie BSHTOP) und senkt die nötige Einmalzahlung."
                                   : "Kommt zusätzlich obendrauf – im Vorteil bewusst nicht als Rendite eingerechnet.") + '</p></div>';
    }
    ziel.innerHTML = html;
  }

  /* ---------- PDF ---------- */
  function pdfDokument(r, kunde){
    var e = r.eingabe, v1 = r.v1, v2 = r.v2, b = v2.bsv, f = r.foerderung;
    var heute = new Date();
    var datum = ("0" + heute.getDate()).slice(-2) + "." + ("0" + (heute.getMonth() + 1)).slice(-2) + "." + heute.getFullYear();
    var P = window.PROFIL || {};
    var berater = ((P.vorname || "") + " " + (P.nachname || "")).trim();
    var kontakt = [P.funktion && berater ? P.funktion : "", P.mobil ? "Mobil " + P.mobil : "", P.mail || ""].filter(Boolean);
    function row(label, a, c, kl){ return '<tr' + (kl ? ' class="' + kl + '"' : '') + '><th>' + label + '</th><td>' + a + '</td><td>' + c + '</td></tr>'; }
    function zt(z){ return z ? proz(z.zins) + (z.klein ? "" : '<small>Rabatt ' + proz(z.rabatt) + '</small>') : "–"; }
    var tabelle = '<table class="vergleich"><thead><tr><th></th><th>Variante 1<span>Nur ETF</span></th><th>Variante 2<span>ETF + Bausparen</span></th></tr></thead><tbody>'
      + '<tr class="gruppe"><th colspan="3">Ansparphase bis ' + mon(r.zuteilung) + '</th></tr>'
      + row("Monatliche Sparrate", eur2(v1.etfRate), eur2(v2.etfRate) + " + " + eur2(v2.bsvRate))
      + row("Einmalzahlung ETF → Bausparvertrag", "–", v2.entnahme ? eur(v2.entnahme.netto) + " (" + mon(v2.entnahme.n) + ")" : "nicht nötig")
      + row("ETF-Wert bei Finanzierung", eur(v1.endwert), eur(v2.etfRest))
      + (e.steuer ? row("Abgeltungsteuer auf ETF-Gewinne", "−" + eur(v1.steuer), "−" + eur(v2.steuer)) : "")
      + row("Wertzuwachs ETF" + (e.steuer ? " nach Steuer" : ""), vorzeichen(v1.zuwachs), vorzeichen(v2.zuwachs), "summe")
      + '<tr class="gruppe"><th colspan="3">Bausparvertrag ' + h(r.tarif.name) + '</th></tr>'
      + row("Bausparguthaben bei Zuteilung", "–", eur(b.guthaben) + "<small>Mindestguthaben " + b.mindest + " %</small>")
      + row("Bauspardarlehen", "–", b.darlehen > 0 ? eur(b.darlehen) + "<small>" + proz(r.tarif.zins) + " fest · " + eur2(b.rate) + " / Monat · " + dauer(b.monate) + "</small>" : "–")
      + row("Kosten Bausparvertrag", "–", "−" + eur(b.kosten) + "<small>" + de(b.kostenProzent, 2) + " % der Bausparsumme</small>")
      + '<tr class="gruppe"><th colspan="3">Finanzierung ab ' + mon(r.zuteilung + 1) + '</th></tr>'
      + row("Eigenkapital", eur(v1.ek), eur(v2.ek) + "<small>Bausparsumme + ETF</small>")
      + row("Bankdarlehen", eur(v1.darlehen), eur(v2.darlehen))
      + row("Sollzins Bank", zt(v1.zins), zt(v2.zins))
      + row("Monatliche Rate", eur2(v1.rateMonat), eur2(v2.rateMonat) + (b.darlehen > 0 ? "<small>davon Bausparen " + eur2(b.rate) + " für " + dauer(b.monate) + "</small>" : ""))
      + row("Zinskosten Bank (gesamte Laufzeit)", "−" + eur(v1.bank.zinsen), "−" + eur(v2.bank.zinsen))
      + row("Saldo", vorzeichen(v1.saldo), vorzeichen(v2.saldo), "saldo")
      + '</tbody></table>';
    var foerd = "";
    if(e.wop || e.asz || e.vl > 0){
      var teile = [];
      if(e.vl > 0) teile.push("Vermögenswirksame Leistungen vom Arbeitgeber: <b>" + eur(f.vl) + "</b>");
      if(e.asz && e.vl > 0) teile.push("Arbeitnehmersparzulage: <b>" + eur(f.asz) + "</b>");
      if(e.wop) teile.push("Wohnungsbauprämie: <b>" + eur(f.wop) + "</b>");
      foerd = '<section class="box"><h2>Zusätzlich: Förderung &amp; Arbeitgeberleistungen</h2><p style="font-size:8.6pt">' + teile.join(" · ") + '</p><p class="klein">'
            + (f.eingerechnet ? "Im Bausparguthaben bereits berücksichtigt." : "Nicht im Vorteil enthalten – kommt zusätzlich hinzu, sofern die Voraussetzungen (u. a. Einkommensgrenzen) erfüllt sind.") + '</p></section>';
    }
    var css = '@page{size:A4;margin:12mm}*{box-sizing:border-box}html{background:#eef1f4}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#152333;font-size:9.2pt;line-height:1.35;background:#eef1f4}'
      + '.dokument{width:min(190mm,calc(100% - 32px));margin:18px auto;background:#fff;border:1px solid #cbd4dc;border-radius:4px;box-shadow:0 10px 34px rgba(27,43,58,.12);padding:11mm 11mm 9mm}'
      + '.kopf{display:flex;justify-content:space-between;gap:10mm;padding-bottom:4mm;border-bottom:2px solid #0f4d8a}.kicker{margin:0 0 1.2mm;font-size:7.5pt;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:#71808e}'
      + 'h1{font-size:17pt;line-height:1.1;margin:0;color:#0f4d8a;letter-spacing:-.02em}.kopf-rechts{text-align:right;color:#5c6b78;font-size:8.3pt;line-height:1.5}.kopf-rechts b{color:#152333;font-size:9.2pt}'
      + '.eck{display:grid;grid-template-columns:repeat(4,1fr);font-size:9pt;border:1px solid #d9e0e6;border-radius:6px;overflow:hidden;margin:4mm 0}.eck div{padding:2mm 3mm;border-right:1px solid #e3e8ec;border-bottom:1px solid #e3e8ec}.eck div:nth-child(4n){border-right:0}.eck div:nth-last-child(-n+4){border-bottom:0}'
      + '.eck b{display:block;font-size:6.8pt;text-transform:uppercase;letter-spacing:.06em;color:#71808e;font-weight:700;margin-bottom:.6mm}.eck span{font-size:9.6pt;font-weight:600}'
      + 'table.vergleich{width:100%;border-collapse:separate;border-spacing:0;border:1px solid #d9e0e6;border-radius:6px;overflow:hidden;table-layout:fixed}'
      + '.vergleich th,.vergleich td{padding:1.15mm 3mm;border-bottom:1px solid #e9edf0;text-align:right;vertical-align:top}.vergleich tbody th{text-align:left;font-weight:500;color:#33485a;width:46%}'
      + '.vergleich thead th{background:#0f4d8a;color:#fff;font-size:9.6pt;text-align:right}.vergleich thead th:first-child{background:#0f4d8a}.vergleich thead th span{display:block;font-size:7.5pt;font-weight:400;opacity:.85}'
      + '.vergleich thead th:last-child{background:#1f7a52}.vergleich small{display:block;font-size:7pt;line-height:1.25;color:#7b8995;font-weight:400}'
      + '.vergleich tr.gruppe th{background:#f3f6f9;color:#0f4d8a;font-size:7.4pt;text-transform:uppercase;letter-spacing:.07em;font-weight:700;padding:1.2mm 3mm}'
      + '.vergleich tr.summe td,.vergleich tr.summe th{font-weight:700;background:#fafbfc}.vergleich tr.saldo td,.vergleich tr.saldo th{font-weight:700;font-size:10.5pt;border-bottom:0;background:#f3f6f9}'
      + '.vorteil{margin:4mm 0;padding:3.5mm 6mm;break-inside:avoid;border-radius:6px;background:#0f4d8a;color:#fff;display:flex;justify-content:space-between;align-items:center}.vorteil.neg{background:#8e3a33}.vorteil span{font-size:11pt}.vorteil b{font-size:20pt;letter-spacing:-.02em}'
      + '.vorteil small{display:block;font-size:8pt;opacity:.8;margin-top:.8mm}.box{border:1px solid #d9e0e6;border-radius:6px;padding:2.5mm 4mm;margin-bottom:3mm;break-inside:avoid}.box h2{font-size:9.4pt;margin:0 0 1mm;color:#0f4d8a}.box p{margin:0}.klein{font-size:7.6pt;color:#71808e;margin-top:1.2mm!important}'
      + '.hinweise{font-size:6.9pt;color:#6b7884;line-height:1.4;border-top:1px solid #e3e8ec;padding-top:2.5mm;margin-top:3mm}.hinweise p{margin:0 0 1.2mm}'
      + '.fuss{display:flex;justify-content:space-between;margin-top:3mm;padding-top:2.5mm;border-top:1px solid #e3e8ec;font-size:7.5pt;color:#8a96a2}'
      + '@media print{html,body{background:#fff}.dokument{width:auto;margin:0;border:0;box-shadow:none;padding:0}.vergleich thead th,.vergleich tr.gruppe th,.vorteil,.vergleich tr.saldo th,.vergleich tr.saldo td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
    var foerdText = [e.verh ? "verheiratet" : "ledig"].concat(e.wop ? ["WoP"] : [], e.asz ? ["ASZ"] : [], e.vl > 0 ? ["vL " + eur2(e.vl)] : []).join(" · ");
    return '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Synergie-Konzept' + (kunde ? " – " + h(kunde) : "") + '</title><style>' + css + '</style></head><body><main class="dokument">'
      + '<header class="kopf"><div><p class="kicker">Individuelles Synergie-Konzept</p><h1>' + (kunde ? "für " + h(kunde) : "ETF + Bausparen im Vergleich") + '</h1></div>'
      + '<div class="kopf-rechts">' + (berater ? '<b>' + h(berater) + '</b><br>' : '') + kontakt.map(h).join("<br>") + (kontakt.length || berater ? "<br>" : "") + 'Stand ' + datum + '</div></header>'
      + '<section class="eck">'
      + '<div><b>Finanzierungsbedarf</b><span>' + eur(e.bedarf) + '</span></div>'
      + '<div><b>Bausparsumme</b><span>' + eur(e.bss) + '</span></div>'
      + '<div><b>Sparrate gesamt</b><span>' + eur2(e.sparrate) + ' / Monat</span></div>'
      + '<div><b>Ansparzeit</b><span>' + dauer(r.zuteilung - r.start + 1) + '</span></div>'
      + '<div><b>ETF-Rendite (Annahme)</b><span>' + proz(e.rendite, 2) + ' p. a.</span></div>'
      + '<div><b>Aufteilung Variante 2</b><span>' + de(e.etfAnteil, 1) + ' % ETF</span></div>'
      + '<div><b>Bankzins ohne EK</b><span>' + proz(e.bankZins) + '</span></div>'
      + '<div><b>Kunde</b><span>' + h(foerdText) + '</span></div>'
      + '</section>'
      + tabelle
      + '<div class="vorteil' + (r.vorteil < 0 ? " neg" : "") + '"><div><span>Ihr Vorteil durch Variante 2</span><small>über die gesamte Laufzeit · nur Zinsbindung (' + e.bindung + ' J.): ' + vorzeichen(r.vorteilBindung) + '</small></div><b>' + vorzeichen(r.vorteil) + '</b></div>'
      + foerd
      + '<section class="hinweise">'
      + '<p><b>Annahmen:</b> ETF-Rendite ' + proz(e.rendite, 2) + ' p. a. gleichbleibend, monatliche Besparung. Bankdarlehen mit ' + proz(e.tilgung, 2) + ' Anfangstilgung, Sollzins nach der Zinsbindung unverändert. '
      + 'Zinsrabatt anteilig bis ' + proz(e.rabattMax, 2) + ' ab ' + de(e.rabattAbEk, 0) + ' % Eigenkapital. Bausparvertrag nach den Allgemeinen Bedingungen für Bausparverträge Tarif Fuchs 06, Zuteilung bei Erreichen von Mindestguthaben und Mindestbewertungszahl.'
      + (e.steuer ? ' Abgeltungsteuer inkl. Solidaritätszuschlag' + (e.kirche ? ' und ' + e.kirche + ' % Kirchensteuer' : '') + ', 30 % Teilfreistellung, Sparerpauschbetrag ' + (e.verh ? '2.000' : '1.000') + ' € je Jahr.' : ' Ohne Berücksichtigung von Steuern.') + '</p>'
      + '<p>Unverbindliche Modellrechnung, kein Angebot und keine Steuerberatung. ETF-Wertentwicklungen sind nicht garantiert. Der Zuteilungszeitpunkt kann nicht zugesagt werden; Zinsen und Förderung hängen von Bonität, Beleihung und den Verhältnissen bei Finanzierung ab.</p>'
      + '</section>'
      + '</main></body></html>';
  }

  document.getElementById("syn-pdf").addEventListener("click", function(){
    if(!letztes || letztes.fehler){ if(typeof melden === "function") melden("Bitte zuerst gültige Werte eingeben."); return; }
    var kunde = document.getElementById("syn-kunde").value.trim();
    var fenster = window.open("", "_blank");
    if(!fenster){ if(typeof melden === "function") melden("Das PDF-Fenster wurde vom Browser blockiert."); return; }
    fenster.document.open();
    fenster.document.write(pdfDokument(letztes, kunde));
    fenster.document.close();
    fenster.focus();
    setTimeout(function(){ fenster.print(); }, 200);
  });

  lesenSpeicher();
  tarifeFuellen();
  formularFuellen();
  rechnenUndZeigen();
  window.SynergieUI = {neu:rechnenUndZeigen, pdf:function(k){ return letztes ? pdfDokument(letztes, k || "") : ""; }};
})();
