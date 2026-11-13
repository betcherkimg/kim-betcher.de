"""Check the personal pages of kim-betcher.de (start page with lab, private insights, legal pages) and /beratung.

Run: python tests/start-browser.py
Requires Playwright and Chromium. External requests are blocked; nothing is submitted.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import shutil
from threading import Thread

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
NEW_PAGES = ["index.html", "private-einblicke.html", "spielwiese.html", "impressum.html", "datenschutz.html"]

for name in ("index.html", "private-einblicke.html"):
    source = (ROOT / name).read_text()
    # The personal pages may mention the employer but never show its material or link the advisory page.
    for banned in ("SH_", "fuchs", "qr-visitenkarte", "finanzprofi", "beratung.html", "volksbank", "gmail", "schwäbisch", "schwaebisch", "bausparkasse"):
        assert banned not in source.lower() if banned.islower() else banned not in source, f"{banned} in {name}"
    for path in re.findall(r'(?:src|href)="((?:ressources|assets)/[^"?]+)', source):
        target = ROOT / path.replace("%20", " ").replace("%26", "&").replace("%28", "(").replace("%29", ")").replace("&amp;", "&")
        assert target.exists(), f"Missing {path} in {name}"
advisory = (ROOT / "beratung.html").read_text()
assert "private-einblicke" not in advisory and 'href="index.html' not in advisory, "Advisory page must stand alone"
assert "Vom Dach in die Bank" in advisory


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()
origin = f"http://127.0.0.1:{server.server_port}"
errors = []
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=shutil.which("chromium") or shutil.which("chromium-browser"))
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        external = []
        page.route(re.compile(r"^https?://(?!127\.0\.0\.1)"), lambda route: (external.append(route.request.url), route.abort()))
        page.goto(origin + "/", wait_until="networkidle")
        expect(page.get_by_role("heading", level=1)).to_have_text("Hi, ich bin Kim.")
        for heading in ("Kurz zu mir.", "Mein Weg.", "Was ich baue.", "Wofür ich stehe.", "Was mich erdet.", "Meld dich einfach."):
            expect(page.get_by_role("heading", name=heading)).to_be_attached()
        expect(page.locator(".story .chapter")).to_have_count(4)
        # Die Stationen liegen in .story: Der Begleiter muss ihre Abschnitte trotzdem finden, sonst spricht er dort nicht
        assert 'querySelectorAll("main section[id]")' in (ROOT / "figur.js").read_text(encoding="utf-8")
        assert page.evaluate('[...document.querySelectorAll("main section[id]")].map(s => s.id).join()') == "ueber-mich,weg,privat,werte,coding,kontakt"
        # Die Stationsnummer liegt über dem Zollstock
        assert page.evaluate("getComputedStyle(document.querySelector('.story .chapter')).zIndex") == "2"
        assert not external, f"Start page loads external content: {external}"
        expect(page.locator(".roster")).to_have_count(0)
        if page.evaluate("Boolean(document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl'))"):
            expect(page.locator(".stage")).to_have_class(re.compile(r"\bis-3d\b"), timeout=60000)
            expect(page.locator(".lab")).to_have_class(re.compile(r"\bis-live\b"))
            page.get_by_role("button", name="Charakter erstellen").click()
            expect(page.locator(".hair-card")).to_have_count(12)
            page.get_by_role("button", name="Frisur: Kurz").click()
            # Skins: mit Skin bleiben nur Frisur, Haarfarbe und Hautfarbe anpassbar
            page.locator('.ed-tab[data-tab="skin"]').click()
            expect(page.locator(".skin-card")).to_have_count(3)
            page.get_by_role("button", name="Skin: Zimmerer").click()
            for tab in ("Oberteil", "Hose", "Schuhe"):
                expect(page.locator(f'.ed-tab[data-tab="{tab}"]')).to_be_hidden()
            for tab in ("frisur", "haarfarbe", "haut"):
                expect(page.locator(f'.ed-tab[data-tab="{tab}"]')).to_be_visible()
            page.get_by_role("button", name="Skin: Ohne").click()
            expect(page.locator('.ed-tab[data-tab="Hose"]')).to_be_visible()
            page.get_by_role("button", name="Skin: Anzug").click()
            page.get_by_role("button", name="Fertig").click()
            saved = page.evaluate("JSON.parse(localStorage.getItem('kb-figur-v1'))")
            assert saved["fertig"] and saved["figuren"]["kim"]["frisur"] == "Kurz" and saved["figuren"]["kim"]["skin"] == "Anzug" and "maksim" not in saved["figuren"], saved
            page.evaluate("localStorage.clear()")
        assert "Steine" not in page.locator("main").inner_text(), "Advisory slogan on the personal page"
        page.locator('.build-shot[data-gallery="smartadm"]').click()
        expect(page.locator("#preview-title")).to_have_text("SmartADM 5")
        expect(page.locator(".preview-counter")).to_have_text("1 / 2")
        page.keyboard.press("Escape")
        # Every project opens a gallery; BlankofleX is linked in its card only, not in the footer.
        expect(page.locator(".build-shot[data-preview]")).to_have_count(5)
        # Begleiter: lässt sich antippen, packen und versetzen; der Platz wird gemerkt
        if page.locator(".stage.is-3d").count():
            page.evaluate("document.querySelector('#weg').scrollIntoView({behavior: 'instant'})")
            figure = page.locator(".companion-figure")
            expect(figure).to_be_visible()
            page.wait_for_function("performance.getEntriesByType('resource').some((entry) => entry.name.includes('kim-moves.glb') && entry.responseEnd > 0)")
            figure.click()
            before = page.locator(".companion").bounding_box()
            page.mouse.move(before["x"] + before["width"] / 2, before["y"] + before["height"] / 2)
            page.mouse.down()
            page.mouse.move(before["x"] + before["width"] / 2 + 300, before["y"] + before["height"] / 2 - 4, steps=8)
            expect(page.locator(".companion")).to_have_class(re.compile("is-carried"))
            page.mouse.up()
            expect(page.locator(".companion")).not_to_have_class(re.compile("is-carried"))
            after = page.locator(".companion").bounding_box()
            assert abs(after["x"] - before["x"] - 300) < 12, (before, after)
            # Losgelassen fällt die Figur immer an den unteren Rand
            page.mouse.move(after["x"] + after["width"] / 2, after["y"] + after["height"] / 2)
            page.mouse.down()
            page.mouse.move(after["x"] + after["width"] / 2, after["y"] + after["height"] / 2 - 400, steps=8)
            page.mouse.up()
            page.wait_for_function("Math.abs(document.querySelector('.companion').getBoundingClientRect().bottom - innerHeight) < 2", timeout=20000)
            spot = page.evaluate("JSON.parse(localStorage.getItem('kb-figur-v1')).platz")
            assert 0 < spot["x"] < 1 and spot["y"] == 1, spot
            assert not errors, errors
            page.evaluate("window.scrollTo(0, 0)")
        for key, count in (("blankoflex", 3), ("iquest", 3), ("heimello", 4), ("roadlands", 6)):
            page.locator(f'.build-shot[data-gallery="{key}"]').click()
            expect(page.locator(".preview-counter")).to_have_text(f"1 / {count}")
            page.keyboard.press("Escape")
        assert "BlankofleX" not in page.locator(".site-footer").inner_text()
        # Alle Verweise auf Juschkin Labs führen auf Kims Seite dort
        links = page.eval_on_selector_all('a[href*="juschkinlabs.de"]', "els => els.map(a => a.getAttribute('href'))")
        assert len(links) == 3 and set(links) == {"https://juschkinlabs.de/kim"}, links
        for width in (320, 390, 768, 820, 1024, 1440):
            page.set_viewport_size({"width": width, "height": 1000})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow at {width}px"
        page.set_viewport_size({"width": 1440, "height": 1000})

        page.goto(origin + "/private-einblicke.html", wait_until="networkidle")
        expect(page.get_by_role("heading", level=1)).to_have_text("Mehr als nur Arbeit.")
        page.locator('.tile[data-gallery="familie"]').click()
        expect(page.locator("#preview-title")).to_have_text("Meine Familie")
        expect(page.locator(".preview-counter")).to_have_text("1 / 8")
        page.keyboard.press("Escape")
        # YouTube öffnet eine Liste mit KIM und ODYN, TikTok ist raus
        menu = page.locator("#musik .tile-menu")
        expect(menu.locator("ul")).to_be_hidden()
        menu.locator("summary").click()
        assert menu.locator("a").all_inner_texts() == ["KIM", "ODYN"]
        assert all("youtu" in (a.get_attribute("href") or "") for a in menu.locator("a").all())
        assert "tiktok" not in page.content().lower()
        menu.locator("summary").click()
        # Musik-Kachel startet den Song, der Player steuert ihn
        player = page.locator("[data-music-player]")
        expect(player).to_be_hidden()
        page.locator(".tile[data-music]").click()
        page.keyboard.press("Escape")
        expect(player).to_be_visible()
        expect(player).to_have_class(re.compile("is-playing"))
        assert page.evaluate("() => { const a = document.querySelector('[data-music-player] audio'); return !a.paused && a.src.endsWith('assets/musik/odyn-wald-2026-remake.mp3') && window.kbMusicPlaying === true; }")
        page.wait_for_function("document.querySelector('[data-music-player] audio').currentTime > 0.3")
        player.locator(".music-toggle").click()
        expect(player).not_to_have_class(re.compile("is-playing"))
        assert page.evaluate("window.kbMusicPlaying === false")
        player.locator(".music-close").click()
        expect(player).to_be_hidden()
        for width in (320, 390, 820, 1440):
            page.set_viewport_size({"width": width, "height": 1000})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow on private page at {width}px"

        # Spielwiese: Wiese läuft, Leiste ist gefüllt, Antippen stellt etwas auf und merkt es
        page.goto(origin + "/", wait_until="networkidle")
        assert page.locator("[data-worlds]").get_attribute("href") == "spielwiese.html"
        expect(page.locator(".hero-actions a")).to_have_count(1)
        page.goto(origin + "/spielwiese.html", wait_until="networkidle")
        expect(page.locator(".palette-item")).to_have_count(23)
        expect(page.locator("[data-hud-life]")).to_be_attached()
        expect(page.locator(".header-legal a")).to_have_count(2)
        if page.evaluate("Boolean(document.createElement('canvas').getContext('webgl2'))"):
            expect(page.locator("[data-play]")).to_have_class(re.compile("is-live"))
            page.wait_for_function("window.kbSpielwiese && kbSpielwiese.kim.ready && kbSpielwiese.things.filter(t => !t.temp).length === 7", timeout=240000)
            # Spielen: keine Leiste. Bauen (B): Leiste sichtbar, auf- und zuklappbar.
            expect(page.locator(".palette")).to_be_hidden()
            page.keyboard.press("b")
            expect(page.locator("[data-play]")).to_have_class(re.compile("is-build"))
            expect(page.locator(".palette-item").first).to_be_visible()
            page.locator("[data-palette-toggle]").click()
            expect(page.locator(".palette-item").first).to_be_hidden()
            page.locator("[data-palette-toggle]").click()
            expect(page.locator(".palette-item").first).to_be_visible()
            page.locator('.palette-item[data-item="arian"]').click()
            page.wait_for_function("kbSpielwiese.things.filter(t => !t.temp).length === 8", timeout=120000)
            assert any(row[0] == "arian" for row in page.evaluate("JSON.parse(localStorage.getItem('kb-spielwiese-v1'))"))
            expect(page.locator("[data-play-tools]")).to_be_visible()
            # Einsteigen wechselt ins Spiel; Kim sitzt, steigt mit E wieder aus
            page.locator('[data-tool="drive"]').click()
            assert page.evaluate("kbSpielwiese.mode") == "play"
            # Die Knöpfe unten rechts gibt es nur mit dem Finger
            expect(page.locator("[data-play-exit]")).to_be_hidden()
            page.wait_for_function("kbSpielwiese.driving && !kbSpielwiese.kim.busy", timeout=1200000)
            assert page.evaluate("kbSpielwiese.kim.current") == "SitInCar"
            page.keyboard.press(" ")
            page.keyboard.press("e")
            page.wait_for_function("!kbSpielwiese.driving", timeout=1200000)
            assert page.evaluate("kbSpielwiese.kim.group.parent.type") == "Scene"
            # Flaches Fahrzeug: die Beine bleiben ruhig (früher drehten sie sich jedes Bild weiter), nach dem Aussteigen steht Kim auf dem Boden
            page.evaluate("kbSpielwiese.kim.safe = 9999; kbSpielwiese.enter(kbSpielwiese.things.find(t => t.id === 'gokart'))")
            page.wait_for_function("kbSpielwiese.driving && !kbSpielwiese.kim.busy", timeout=1200000)
            legs = "kbSpielwiese.kim.legs.flatMap(l => [...l.thigh.quaternion.toArray(), ...l.shin.quaternion.toArray()])"
            page.wait_for_timeout(1200)
            before = page.evaluate(legs)
            page.keyboard.down("w")
            page.keyboard.down("a")
            page.wait_for_timeout(2500)
            page.keyboard.up("w")
            page.keyboard.up("a")
            drift = max(abs(a - b) for a, b in zip(page.evaluate(legs), before))
            assert drift < 0.05, f"Legs move while driving ({drift})"
            page.wait_for_function("Math.abs(kbSpielwiese.driving.speed) < 2", timeout=240000)
            page.keyboard.press("e")
            page.wait_for_function("!kbSpielwiese.driving && !kbSpielwiese.kim.busy", timeout=1200000)
            # Steuerung mit H, Schwert mit Q, ein Schlag trifft den Gegner
            page.keyboard.press("h")
            expect(page.locator("[data-help]")).to_be_visible()
            page.keyboard.press("h")
            expect(page.locator("[data-help]")).to_be_hidden()
            page.evaluate("(async () => { const k = kbSpielwiese, at = k.kim.group.position; window.__mob = await k.addThing('pilzling', at.x + Math.sin(k.kim.yaw) * 1.6, at.z + Math.cos(k.kim.yaw) * 1.6, 0, { save: false }); window.__mob.calm = 9999; })()")
            page.wait_for_function("window.__mob && kbSpielwiese.sword.mesh", timeout=240000)
            page.keyboard.press("q")
            page.wait_for_function("kbSpielwiese.sword.drawn && !kbSpielwiese.sword.moving", timeout=240000)
            expect(page.locator("[data-hud-sword]")).to_have_attribute("aria-pressed", "true")
            page.evaluate("kbSpielwiese.strike()")
            page.wait_for_function("window.__mob.hp < 30", timeout=240000)
            # Die Polizei ist friedlich, bis Kim ein Tier angreift
            page.evaluate("(async () => { const k = kbSpielwiese; window.__cop = await k.addThing('polizist', 20, 20, 0, { save: false }); })()")
            page.wait_for_function("window.__cop", timeout=240000)
            assert page.evaluate("kbSpielwiese.wanted") == 0
            page.evaluate("kbSpielwiese.hurtMob(kbSpielwiese.things.find(t => t.id === 'fuchs'), 5, 0, 0)")
            assert page.evaluate("kbSpielwiese.wanted") > 0
            assert page.evaluate("kbSpielwiese.things.find(t => t.id === 'fuchs').afraid") is True
        assert not errors, errors
        for width in (390, 820, 1440):
            page.set_viewport_size({"width": width, "height": 800})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow on playground at {width}px"
        page.set_viewport_size({"width": 1440, "height": 1000})
        page.goto(origin + "/impressum.html", wait_until="networkidle")
        expect(page.get_by_role("heading", name="Angaben gemäß § 5 DDG")).to_be_visible()
        expect(page.get_by_role("heading", name="Angaben zur Beratung")).to_be_visible()
        assert "640815-7" in page.locator("main").inner_text()
        page.goto(origin + "/datenschutz.html", wait_until="networkidle")
        assert "kb-figur-v1" in page.locator("main").inner_text()
        for name in ("impressum.html", "datenschutz.html"):
            page.goto(f"{origin}/{name}", wait_until="networkidle")
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), name
        browser.close()
    assert not errors, errors
    print("PASS: start page with lab and editor (Kim only), no employer material, private insights with galleries, separated imprint, privacy note, standalone advisory page.")
finally:
    server.shutdown()
    server.server_close()
