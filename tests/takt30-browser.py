# Browser-Test für TAKT Nr. 30: echte Seiten aus dem Repo, echter Worker lokal (SQLite),
# Clerk gemockt, Kamera mit einem echten QR-Code als Fake-Video. Keine Produktionsdaten.
#   python3 tests/takt30-browser.py [ausgabeordner-für-screenshots]
import json, os, pathlib, subprocess, sys, time, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="takt30-shots-"))
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8799
API = "https://takt30-api.betcherkimg.workers.dev"
CHROME = next((p for p in ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/usr/bin/chromium"] if os.path.exists(p)), None)

server = subprocess.Popen(["node", str(ROOT / "tests/takt30-dev-server.mjs"), str(PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(50):
    try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health"); break
    except Exception: time.sleep(0.1)

def sql(q, *args):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/__sql", data=json.dumps({"sql": q, "args": list(args)}).encode(), method="POST")
    return json.loads(urllib.request.urlopen(req).read())

CLERK = """window.Clerk={user:{id:'user_DevMainAdmin0001'},session:{getToken:async()=>(await (await fetch('%s/__token')).text())},
load:async()=>{},mountSignIn:()=>{},mountUserButton:()=>{},unmountSignIn:()=>{},addListener:()=>{}};""" % API
errors = []

def wire(ctx):
    def site(route):
        url = route.request.url.split("?")[0].split("#")[0]
        rel = url.replace("https://kim-betcher.de/", "")
        f = ROOT / rel
        if f.is_dir(): f = f / "index.html"
        if not f.exists(): return route.fulfill(status=404, body="not found")
        types = {".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png"}
        route.fulfill(status=200, body=f.read_bytes(), content_type=types.get(f.suffix, "application/octet-stream"))
    def api(route):
        r = route.fetch(url=route.request.url.replace(API, f"http://127.0.0.1:{PORT}"))
        route.fulfill(response=r)
    ctx.route("https://kim-betcher.de/**", site)
    ctx.route(f"{API}/**", api)
    ctx.route("**/clerk.browser.js", lambda r: r.fulfill(content_type="application/javascript", body=CLERK))
    ctx.route("**/ui.browser.js", lambda r: r.fulfill(content_type="application/javascript", body=""))

def watch(page, name):
    page.on("pageerror", lambda e: errors.append(f"{name}: {e}"))
    # ERR_FAILED ist beim Scanner der absichtlich simulierte Verbindungsabbruch
    page.on("console", lambda m: m.type == "error" and "favicon" not in m.text and not (name == "scanner" and "ERR_FAILED" in m.text) and errors.append(f"{name} console: {m.text}"))

def no_overflow(page, label):
    w = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert w <= 0, f"{label}: horizontale Überbreite {w}px"

BASE = "https://kim-betcher.de/taktnr30/tickets/"
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME)
        # ---------- Admin am PC ----------
        actx = browser.new_context(viewport={"width": 1440, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
        wire(actx); admin = actx.new_page(); watch(admin, "admin")
        admin.goto("https://kim-betcher.de/taktnr30/admin/")
        admin.wait_for_selector("text=Ticketverkauf")
        admin.screenshot(path=str(OUT / "admin-uebersicht-geschlossen.png"))
        admin.click("#modeBtns button[data-m=test]")
        admin.wait_for_selector(".chip.warn:has-text('Testmodus aktiv')")
        invite1 = invite2 = admin.inner_text(".linkbox code")     # gemeinsamer Ticket-Link
        assert "?e=" in invite1
        admin.screenshot(path=str(OUT / "admin-uebersicht-test.png"))
        admin.click("nav button[data-p=prep]")
        admin.wait_for_selector(".todo")
        assert admin.locator(".todo").count() == 27 and admin.locator(".todo.done").count() == 1
        admin.click(".todo:not(.done) input[type=checkbox] >> nth=0")
        admin.wait_for_function("document.querySelectorAll('.todo.done').length === 2")
        admin.fill("#todoAdd [name=ttl]", "Müllcontainer bestellen"); admin.select_option("#todoAdd [name=phase]", "woche"); admin.click("#todoAdd button")
        admin.wait_for_selector(".todo:has-text('Müllcontainer bestellen')")
        admin.screenshot(path=str(OUT / "admin-vorbereitung.png"), full_page=True)
        admin.click("nav button[data-p=money]"); admin.wait_for_selector("#ledForm")
        admin.fill("#ledForm [name=purpose]", "Bier, 10 Fässer"); admin.fill("#ledForm [name=party]", "Getränke Müller")
        admin.fill("#ledForm [name=amount]", "480,50"); admin.fill("#ledForm [name=receipt_no]", "B-1"); admin.click("#ledSave")
        admin.wait_for_selector("td:has-text('Bier, 10 Fässer')")
        admin.click("#gemaForm >> xpath=..//summary"); admin.fill("#gemaForm [name=sqm]", "300")
        for btn, name in [("#pdfAll", "TAKT30-Abrechnung.pdf"), ("#pdfGema", "TAKT30-GEMA-Rechnungslegung.pdf")]:
            with admin.expect_download() as dl: admin.click(btn)
            path = OUT / name; dl.value.save_as(str(path)); assert path.stat().st_size > 2000, name
        with admin.expect_download() as dl: admin.click("[data-xc=ledger]")
        p2 = OUT / "belege.csv"; dl.value.save_as(str(p2)); assert "Bier, 10 Fässer" in p2.read_text(encoding="utf-8-sig")
        admin.screenshot(path=str(OUT / "admin-abrechnung.png"), full_page=True)
        admin.click("nav button[data-p=entry]")
        admin.fill("#scForm [name=name]", "Tür 1"); admin.click("#scForm button")
        admin.wait_for_selector("#newLink code")
        scanner_link = admin.inner_text("#newLink code")
        admin.click("nav button[data-p=content]")
        admin.wait_for_selector("#cForm")
        admin.click("#addLu"); admin.fill("#lu .lineup-row:last-child [name=lt]", "22:00"); admin.fill("#lu .lineup-row:last-child [name=ln]", "Testact")
        admin.click("#cForm button.btn-uv"); admin.wait_for_selector("#toast:has-text('Gespeichert')")
        admin.click("#lu .lineup-row:last-child [data-del]"); admin.click("#cForm button.btn-uv"); admin.wait_for_timeout(300)
        admin.click("nav button[data-p=paper]"); admin.wait_for_selector("#blockForm")
        admin.fill("#sellForm [name=no]", "2T-31"); admin.fill("#sellForm [name=fn]", "Max"); admin.fill("#sellForm [name=ln]", "Reserve"); admin.click("#sellForm button")
        admin.wait_for_selector("td:has-text('Max Reserve')"); assert "35 €" in admin.inner_text("#sellForm + .tablewrap")
        assert admin.inner_text(".kpis").count("50") >= 2
        admin.click("details summary:has-text('Nachdruck')")
        with admin.expect_download(timeout=60000) as dz: admin.click("#zipBtn")
        dz.value.save_as(str(OUT / "TAKT30-Papiertickets-Druckdaten.zip"))
        with admin.expect_download(timeout=120000) as dp: admin.click("#pdfBtn")
        dp.value.save_as(str(OUT / "TAKT30-Papiertickets-A4-selbst-drucken.pdf"))
        admin.fill("#blockForm [name=no]", "fk-03"); admin.click("#blockForm button[name=b]")
        admin.wait_for_selector(".kpi:has-text('Gesperrt') b:has-text('1')")
        admin.screenshot(path=str(OUT / "admin-papiertickets.png"))
        admin.click("nav button[data-p=guests]"); admin.wait_for_selector("#compForm")
        admin.fill("#compForm [name=first]", "Gratis"); admin.fill("#compForm [name=last]", "Gast"); admin.click("#compForm button")
        admin.wait_for_selector("#compDone code:has-text('T30-001')")
        admin.wait_for_selector("#trows td:has-text('Gratis Gast')")
        admin.screenshot(path=str(OUT / "admin-kostenlos.png"))

        # ---------- Gast am Handy ----------
        for width in (360, 390):
            gctx = browser.new_context(viewport={"width": width, "height": 800}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
            wire(gctx); g = gctx.new_page(); watch(g, f"gast{width}")
            g.goto(BASE)
            g.wait_for_selector("#ticketBox h2")
            no_overflow(g, f"start ohne einladung {width}")
            if width == 390: g.screenshot(path=str(OUT / "gast-hero-390.png")); g.screenshot(path=str(OUT / "gast-ganzseite-ohne-einladung.png"), full_page=True)
            gctx.close()

        gctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
        wire(gctx); g = gctx.new_page(); watch(g, "gast")
        g.goto(invite1)
        g.wait_for_selector("text=Du bist eingeladen.")
        assert g.is_visible("#testbar")
        g.locator("#tickets").scroll_into_view_if_needed()
        g.check("input[name=qty][value='2']")
        g.fill("[name=first_0]", "Lisa"); g.fill("[name=last_0]", "Muster"); g.fill("[name=first_1]", "Ben"); g.fill("[name=last_1]", "Muster")
        assert "35 €" in g.inner_text("#totalSum")
        g.check("input[name=tier_1][value=vip]")
        assert "50 €" in g.inner_text("#totalSum"), g.inner_text("#totalSum")
        g.check("input[name=tier_0][value=vip]")
        assert "55 €" in g.inner_text("#totalSum")
        g.check("input[name=tier_0][value=regular]")
        g.fill("[name=email]", "lisa@example.org")
        g.click("#buyBtn")
        assert "bestätigen" in g.inner_text("#buyErr")
        g.check("[name=accept]")
        no_overflow(g, "kaufformular")
        g.screenshot(path=str(OUT / "gast-kaufformular.png"))
        g.click("#buyBtn")
        g.wait_for_selector("#testPay")
        assert "50 €" in g.inner_text(".pay .sum") and "1 VIP" in g.inner_text(".pay .sum")
        g.click("#testPay")
        g.wait_for_url("**/ticket/?o=*")
        g.wait_for_selector(".ticket")
        assert g.locator(".ticket").count() == 2
        assert "Getränkemarken" in g.inner_text(".ticket >> nth=1") and "VIP" in g.inner_text(".ticket >> nth=1")
        no_overflow(g, "ticketseite")
        g.screenshot(path=str(OUT / "gast-ticket.png"))
        with g.expect_download() as dl:
            g.click("#pdf")
        pdf = dl.value.path(); assert open(pdf, "rb").read(5) == b"%PDF-", "kein PDF"
        dl.value.save_as(str(OUT / "TAKT-Nr-30-Tickets.pdf"))
        # zurück auf die Startseite: Gerät erinnert sich, Einladung ausgeschöpft
        g.goto(BASE)
        g.wait_for_selector("text=Du bist dabei.")
        assert g.locator(".mine a.tk").count() == 2
        g.screenshot(path=str(OUT / "gast-du-bist-dabei.png"), full_page=True)

        # ---------- Helfer ----------
        hctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        wire(hctx); h = hctx.new_page(); watch(h, "helfer")
        h.goto(invite2)
        h.wait_for_selector("[data-tab=help]")
        h.click("[data-tab=help]")
        h.check("input[name=job][value='Bar']")
        h.fill("[name=first]", "Ben"); h.fill("[name=last]", "Helfer"); h.fill("[name=email]", "ben@example.org"); h.check("[name=accept]")
        no_overflow(h, "helferformular")
        h.screenshot(path=str(OUT / "helfer-formular.png"))
        h.click("#helpBtn")
        h.wait_for_url("**/ticket/?k=*")
        h.wait_for_selector(".ticket.cat-helper")
        assert "Helfer · Bar" in h.inner_text(".ticket")
        h.screenshot(path=str(OUT / "helfer-ticket.png"))
        h.goto(BASE); h.wait_for_selector("text=Du bist dabei.")
        assert h.is_visible("#buyForm")

        # ---------- Einlass mit echtem QR-Code über Fake-Kamera ----------
        code = sql("SELECT code FROM tickets WHERE first_name = 'Lisa' AND category = 'regular'")[0]["code"]
        y4m = OUT / "qr.y4m"
        subprocess.run(["node", "-e", f"""
const fs=require('fs');const vm=require('vm');const c={{}};vm.runInNewContext(fs.readFileSync('{ROOT}/taktnr30/assets/vendor/qrcode.js','utf8')+';this.q=qrcode',c);
const qr=c.q(0,'M');qr.addData('T30.{code}');qr.make();const n=qr.getModuleCount(),s=12,q=4,W=640,H=480,img=Buffer.alloc(W*H,255);
const off=(W-(n+2*q)*s)/2|0,offy=(H-(n+2*q)*s)/2|0;
for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(qr.isDark(y,x))for(let dy=0;dy<s;dy++)for(let dx=0;dx<s;dx++)img[(offy+(y+q)*s+dy)*W+off+(x+q)*s+dx]=0;
fs.writeFileSync('{OUT}/qr.pgm',Buffer.concat([Buffer.from('P5\\n'+W+' '+H+'\\n255\\n'),img]));"""], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-i", str(OUT / "qr.pgm"), "-t", "3", "-r", "10", "-pix_fmt", "yuv420p", str(y4m)], check=True)
        cam = p.chromium.launch(executable_path=CHROME, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-video-capture={y4m}"])
        sctx = cam.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, permissions=["camera"])
        wire(sctx); s = sctx.new_page(); watch(s, "scanner")
        # alter Link-Pfad leitet auf die Scanner-App weiter, Schlüssel verschwindet aus der Adresse
        s.goto(scanner_link.replace("/taktnr30/scanner/", "/taktnr30/tickets/einlass/"))
        s.wait_for_selector("#startBtn")
        assert "/taktnr30/scanner/" in s.url and "#k=" not in s.url, s.url
        s.click("#startBtn")
        s.wait_for_selector(".result.green", timeout=15000)
        assert "Lisa Muster" in s.inner_text(".result")
        s.screenshot(path=str(OUT / "einlass-gruen.png"))
        s.wait_for_selector("#result", state="hidden", timeout=6000)
        # gleicher Code nach Sperrzeit → rot „Bereits eingelöst“
        s.wait_for_selector(".result.red", timeout=15000)
        assert "Bereits eingelöst" in s.inner_text(".result")
        s.screenshot(path=str(OUT / "einlass-rot.png"))
        s.click("#next")
        s.click("#stopBtn")
        # Offline → gelb
        s.route(f"{API}/scan/check", lambda r: r.abort())
        s.evaluate("""(async()=>{})()""")
        s.click("#startBtn")
        s.wait_for_selector(".result.yellow", timeout=15000)
        assert "NICHT einlassen" in s.inner_text(".result")
        s.screenshot(path=str(OUT / "einlass-gelb.png"))
        s.click("#next"); s.click("#stopBtn"); s.unroute(f"{API}/scan/check")
        # Namenssuche + manueller Check-in
        s.fill("#q", "Ben")
        s.wait_for_selector("#hits [data-id]")
        s.once("dialog", lambda d: d.accept())
        s.click("#hits [data-id] >> nth=0")
        s.wait_for_selector(".result.green")
        s.click("#next")
        no_overflow(s, "scanner")
        s.screenshot(path=str(OUT / "einlass-liste.png"))
        cam.close()

        # ---------- Scanner-App ohne Link: Zugang per Einfügen, Abmelden ----------
        pctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        wire(pctx)
        pctx.route("**/clerk.browser.js", lambda r: r.fulfill(content_type="application/javascript", body="window.Clerk={user:null,session:null,load:async()=>{},mountSignIn:()=>{},addListener:()=>{}};"))
        pg = pctx.new_page(); watch(pg, "scanner-login")
        pg.goto("https://kim-betcher.de/taktnr30/scanner/")
        pg.wait_for_selector("#keyIn")
        no_overflow(pg, "scanner login")
        pg.screenshot(path=str(OUT / "scanner-login.png"))
        pg.fill("#keyIn", "falsch-falsch-falsch-falsch"); pg.click("#keyForm button")
        pg.wait_for_selector("#authErr:not([hidden])")
        pg.fill("#keyIn", scanner_link); pg.click("#keyForm button")
        pg.wait_for_selector("#startBtn")
        assert pg.is_visible("#logout")
        pg.reload(); pg.wait_for_selector("#startBtn")   # Gerät merkt sich den Zugang
        pctx.close()

        # ---------- Admin: Zahlen stimmen ----------
        admin.click("nav button[data-p=overview]")
        admin.wait_for_selector(".kpi")
        txt = admin.inner_text("#main")
        assert "3 / 60" in txt and "2 verkauft · 1 kostenlos" in txt and "50 VIP · 49 Freitickets" in txt, txt[:500]
        admin.screenshot(path=str(OUT / "admin-uebersicht-nach-tests.png"), full_page=True)
        admin.click("nav button[data-p=guests]"); admin.wait_for_selector("#trows tr")
        admin.screenshot(path=str(OUT / "admin-gaeste.png"))
        # Handy-Admin ohne Überbreite
        admin.set_viewport_size({"width": 390, "height": 844})
        for pg in ["overview", "prep", "money", "guests", "orders", "helpers", "paper", "content", "entry", "settings"]:
            admin.evaluate(f"document.querySelector('nav button[data-p={pg}]').click()")
            admin.wait_for_timeout(250)
            assert not admin.is_visible("#main .err"), f"admin {pg}: " + admin.inner_text("#main")[:200]
            # Tabellen scrollen in ihrem Rahmen, die Seite selbst nicht
            no_overflow(admin, f"admin {pg} 390")
        admin.screenshot(path=str(OUT / "admin-handy.png"))
        browser.close()
finally:
    server.terminate()

if errors:
    print("FEHLER IM BROWSER:"); [print("  ", e) for e in errors]; sys.exit(1)
print("takt30-browser: alle Abläufe ok ·", OUT)
