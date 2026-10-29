/* TAKT Nr. 30 – Verträge: Text anzeigen, mit dem Finger unterschreiben, fertiges PDF erzeugen.
   Wird vom Admin (Unterschrift Veranstalter) und von /taktnr30/vertrag/ (Unterschrift Partner) genutzt. */
(function () {
  "use strict";
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const plain = t => String(t).replace(/\*\*(.+?)\*\*/g, "$1");
  const dtDe = iso => iso ? new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " Uhr" : "";

  // Vertragstext: "# Titel", "## Abschnitt", "1. Punkt", "- Punkt", Leerzeile = neuer Absatz
  function renderHtml(body) {
    const out = []; let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(body).split("\n")) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { close(); continue; }
      if ((m = line.match(/^#\s+(.*)/))) { close(); out.push(`<h1>${inline(m[1])}</h1>`); continue; }
      if ((m = line.match(/^##\s+(.*)/))) { close(); out.push(`<h2>${inline(m[1])}</h2>`); continue; }
      if ((m = line.match(/^\d+\.\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = line.match(/^[-•]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      close(); out.push(`<p>${inline(line)}</p>`);
    }
    close();
    return out.join("");
  }

  // Unterschriftenfeld (Finger, Stift, Maus)
  function SignPad(canvas) {
    const ctx = canvas.getContext("2d");
    let drawing = false, strokes = 0, last = null;
    const fit = () => {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0b0b10";
      strokes = 0;
    };
    const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, 7); ctx.fillStyle = "#0b0b10"; ctx.fill(); strokes++; e.preventDefault(); });
    canvas.addEventListener("pointermove", e => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; e.preventDefault(); });
    const end = () => { drawing = false; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end); canvas.addEventListener("pointerleave", end);
    fit();
    let resizeT; window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (!strokes) fit(); }, 150); });
    return {
      clear() { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); fit(); },
      empty: () => strokes === 0,
      // Zugeschnitten auf die Unterschrift, transparenter Hintergrund
      toDataURL() {
        const { width: w, height: h } = canvas, px = ctx.getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (px[(y * w + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 <= x0) return null;
        const pad = 12; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w, x1 + pad); y1 = Math.min(h, y1 + pad);
        let cw = x1 - x0, ch = y1 - y0, scale = Math.min(1, 900 / cw);
        const out = document.createElement("canvas"); out.width = Math.round(cw * scale); out.height = Math.round(ch * scale);
        out.getContext("2d").drawImage(canvas, x0, y0, cw, ch, 0, 0, out.width, out.height);
        return out.toDataURL("image/png");
      }
    };
  }

  const imgSize = src => new Promise(res => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ w: 3, h: 1 }); i.src = src; });

  // Fertiges PDF: Text, Anlage, beide Unterschriften, Prüfsumme
  async function pdf(c, file) {
    if (!window.jspdf) throw new Error("PDF-Werkzeug wird noch geladen – bitte gleich nochmal");
    const { jsPDF } = window.jspdf, doc = new jsPDF({ unit: "mm", format: "a4" });
    const L = 20, R = 190, W = R - L; let y = 22;
    const brk = h => { if (y + h > 275) { doc.addPage(); y = 22; } };
    const para = (t, size = 10, bold = false, gap = 1.6, indent = 0, lead = "") => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size);
      const lines = doc.splitTextToSize(plain(t), W - indent);
      const lh = size * 0.46;
      lines.forEach((ln, i) => { brk(lh); if (i === 0 && lead) doc.text(lead, L, y); doc.text(ln, L + indent, y); y += lh; });
      y += gap;
    };
    let n = 0;
    for (const raw of String(c.body).split("\n")) {
      const line = raw.trimEnd(); let m;
      if (!line.trim()) { y += 1.2; n = 0; continue; }
      if ((m = line.match(/^#\s+(.*)/))) { para(m[1], 16, true, 4); continue; }
      if ((m = line.match(/^##\s+(.*)/))) { y += 2.5; brk(12); para(m[1], 11.5, true, 1.5); n = 0; continue; }
      if ((m = line.match(/^(\d+)\.\s+(.*)/))) { para(m[2], 10, false, 1.2, 7, `${m[1]}.`); continue; }
      if ((m = line.match(/^[-•]\s+(.*)/))) { para(m[1], 10, false, 1.2, 5, "•"); continue; }
      para(line);
    }
    const annex = Array.isArray(c.annex) ? c.annex : [];
    if (annex.length) {
      if (/Anlage 1/.test(c.body)) { y += 1; brk(20); } else { y += 3; brk(20); para("Anlage 1: Equipmentliste", 11.5, true, 2); }
      doc.setFontSize(9); doc.setFont("helvetica", "bold");
      doc.text("Gerät", L, y); doc.text("Seriennummer", L + 95, y); doc.text("Wert (€)", R, y, { align: "right" }); y += 1.5;
      doc.setDrawColor(150); doc.setLineWidth(.2); doc.line(L, y, R, y); y += 4.5; doc.setFont("helvetica", "normal");
      let sum = 0;
      annex.forEach(a => { brk(6); doc.text(doc.splitTextToSize(a.item, 90)[0], L, y); doc.text(a.serial || "", L + 95, y); doc.text(a.value || "", R, y, { align: "right" }); y += 5; sum += parseFloat(String(a.value).replace(/\./g, "").replace(",", ".")) || 0; });
      doc.line(L, y - 3.2, R, y - 3.2); y += 1; doc.setFont("helvetica", "bold"); doc.text("Summe", L, y); doc.text(sum.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 }), R, y, { align: "right" }); y += 6;
    }
    // Unterschriften
    y += 6; brk(58); para("Unterschriften", 11.5, true, 3);
    const col = async (x, label, name, sig, at) => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(110); doc.text(label, x, y); doc.setTextColor(0);
      if (sig) { const s = await imgSize(sig), maxW = 70, maxH = 26, k = Math.min(maxW / s.w, maxH / s.h); doc.addImage(sig, "PNG", x, y + 3, s.w * k, s.h * k); }
      doc.setDrawColor(0); doc.setLineWidth(.25); doc.line(x, y + 31, x + 75, y + 31);
      doc.setFontSize(10); doc.text(name || "", x, y + 36);
      doc.setFontSize(8.5); doc.setTextColor(90); doc.text(at ? `unterschrieben am ${dtDe(at)}` : "noch nicht unterschrieben", x, y + 41); doc.setTextColor(0);
    };
    await col(L, "Veranstalter", c.owner_name, c.owner_sig, c.owner_signed_at);
    await col(L + 92, "Vertragspartner", c.party_name, c.party_sig, c.party_signed_at);
    y += 50;
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(120);
      doc.text(plain(c.title), L, 284); doc.text(`Seite ${i} von ${pages}`, R, 284, { align: "right" });
      doc.setFontSize(6.5);
      doc.text(c.final_sha ? `Prüfsumme (SHA-256): ${c.final_sha}` : `Textprüfsumme (SHA-256): ${c.body_sha || ""}`, L, 289);
      doc.setTextColor(0);
    }
    doc.save(file || "Vertrag.pdf");
  }

  window.TAKT_CONTRACT = { renderHtml, SignPad, pdf, dtDe };
})();
