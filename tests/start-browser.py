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
NEW_PAGES = ["index.html", "private-einblicke.html", "impressum.html", "datenschutz.html"]

for name in ("index.html", "private-einblicke.html"):
    source = (ROOT / name).read_text()
    # The personal pages may mention the employer but never show its material or link the advisory page.
    for banned in ("SH_", "fuchs", "qr-visitenkarte", "finanzprofi", "beratung.html", "volksbank", "gmail"):
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
        assert not external, f"Start page loads external content: {external}"
        expect(page.locator(".roster")).to_have_count(0)
        if page.evaluate("Boolean(document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl'))"):
            expect(page.locator(".stage")).to_have_class(re.compile(r"\bis-3d\b"), timeout=60000)
            expect(page.locator(".lab")).to_have_class(re.compile(r"\bis-live\b"))
            page.get_by_role("button", name="Charakter erstellen").click()
            expect(page.locator(".hair-card")).to_have_count(12)
            page.get_by_role("button", name="Frisur: Kurz").click()
            page.get_by_role("button", name="Fertig").click()
            saved = page.evaluate("JSON.parse(localStorage.getItem('kb-figur-v1'))")
            assert saved["fertig"] and saved["figuren"]["kim"]["frisur"] == "Kurz" and "maksim" not in saved["figuren"], saved
            page.evaluate("localStorage.clear()")
        assert "Steine" not in page.locator("main").inner_text(), "Advisory slogan on the personal page"
        page.locator('.build-shot[data-gallery="smartadm"]').click()
        expect(page.locator("#preview-title")).to_have_text("SmartADM 5")
        expect(page.locator(".preview-counter")).to_have_text("1 / 2")
        page.keyboard.press("Escape")
        # Every project opens a gallery; BlankofleX is linked in its card only, not in the footer.
        expect(page.locator(".build-shot[data-preview]")).to_have_count(5)
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
