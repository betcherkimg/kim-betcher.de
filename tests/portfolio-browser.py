"""Check the Juschkin Labs preview (one-pager, detail page, legal pages) and the relocated advisory pages.

Run: python tests/portfolio-browser.py [screenshot-directory]
Requires Playwright and Chromium. The advisory booking test loads its existing CDNs.
No production API is called and no booking or email is submitted.
"""

from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import shutil
import sys
from threading import Thread
from urllib.parse import unquote, urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
PAGES = [f"1293e128973/{name}" for name in ("index.html", "datenintegration.html", "impressum.html", "datenschutz.html")]


class PageLinks(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.path = path

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key not in ("src", "href") or not value:
                continue
            url = urlsplit(value)
            if url.scheme or url.netloc or not url.path:
                continue
            target = (ROOT / unquote(url.path.lstrip("/"))) if url.path.startswith("/") else self.path.parent / unquote(url.path)
            assert target.exists(), f"Missing local resource in {self.path}: {value}"


for name in PAGES:
    source = (ROOT / name).read_text()
    PageLinks(ROOT / name).feed(source)
    # Only the business addresses belong on these pages.
    assert "gmail" not in source.lower(), f"Private address in {name}"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = f"http://127.0.0.1:{server.server_port}"
base = origin + "/1293e128973"
errors = []

try:
    with sync_playwright() as playwright:
        executable = shutil.which("chromium") or shutil.which("chromium-browser")
        browser = playwright.chromium.launch(executable_path=executable)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        context.add_init_script("Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (text) => { window.copiedEmail = text; }}})")
        video_requests = []
        context.route("https://www.youtube-nocookie.com/**", lambda route: route.fulfill(content_type="text/html", body="<!doctype html><title>Trailer test fixture</title><p>Video player</p>"))
        page = context.new_page()
        page.on("request", lambda request: video_requests.append(request.url) if "youtube" in request.url else None)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/", wait_until="networkidle")
        expect(page.get_by_role("heading", level=1)).to_contain_text("Arbeitsabläufe")
        expect(page.locator(".site-header .brand-logo")).to_have_attribute("alt", "Juschkin Labs")
        for project in ["iQuest", "SmartADM", "heimello", "Roadlands"]:
            expect(page.get_by_role("heading", name=project, exact=project != "heimello")).to_be_attached()
        for heading in ("Was wir für dich bauen.", "Deine Ansprechpartner."):
            expect(page.get_by_role("heading", name=heading)).to_be_visible()
        assert "Preise nennen wir dir im Gespräch" in page.locator("#web-apps").inner_text()

        # Character select: both partners are playable and switch the side panels.
        hero = page.locator(".hero")
        page.get_by_role("button", name="Maksim Juschkin").click()
        expect(hero).to_have_attribute("data-character", "maksim")
        expect(page.locator('.roster [data-character="maksim"]')).to_have_attribute("aria-pressed", "true")
        expect(page.locator('dl.stats[data-for="maksim"]')).to_be_visible()
        expect(page.locator('dl.stats[data-for="kim"]')).to_be_hidden()
        page.get_by_role("button", name="Kim Betcher").click()
        expect(hero).to_have_attribute("data-character", "kim")
        expect(page.locator('ul.skill-list[data-for="kim"]')).to_be_visible()

        # 3D editor (only where the browser offers WebGL).
        if page.evaluate("Boolean(document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl'))"):
            expect(page.locator(".stage")).to_have_class(re.compile(r"\bis-3d\b"), timeout=60000)
            page.get_by_role("button", name="Charakter erstellen").click()
            expect(page.locator('[data-editor="tabs"]')).to_be_visible()
            expect(page.locator(".hair-card")).to_have_count(12)
            expect(page.locator(".hair-card img")).to_have_count(12, timeout=30000)
            page.locator(".ed-tab[data-tab='haarfarbe']").click()
            expect(page.locator(".orb").first).to_be_disabled()
            expect(page.locator(".ed-lock")).to_contain_text("gesperrt")
            page.get_by_role("button", name="Andere Frisur wählen").click()
            page.get_by_role("button", name="Frisur: Kurz").click()
            expect(page.locator(".ed-options-value")).to_have_text("Kurz")
            page.locator(".ed-tab[data-tab='haarfarbe']").click()
            expect(page.locator(".orb").first).to_be_enabled()
            page.locator(".ed-tab[data-tab='Oberteil']").click()
            page.get_by_role("button", name="Oberteil: Gold").click()
            expect(page.get_by_role("button", name="Oberteil: Gold")).to_have_attribute("aria-pressed", "true")
            page.get_by_role("button", name="Fertig").click()
            expect(page.locator('[data-editor="tabs"]')).to_be_hidden()
            saved = page.evaluate("JSON.parse(localStorage.getItem('jl-figuren-v1'))")
            assert saved["fertig"] and saved["figuren"]["kim"]["frisur"] == "Kurz" and saved["figuren"]["kim"]["Oberteil"] == "Gold", saved
            page.evaluate("localStorage.clear()")
            page.reload(wait_until="networkidle")
        assert page.locator('a[href*="beratung"], a[href*="private-einblicke"], a[href*="/smartadm/"]').count() == 0
        expect(page.locator(".roadlands-copy")).to_contain_text("noch nicht spielbar")
        assert not any(name in page.locator(".roadlands-project").inner_text() for name in ("WoW", "Metin2", "GTA", "Steam"))

        for width in (320, 390, 760, 768, 1024, 1440):
            page.set_viewport_size({"width": width, "height": 1000})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow at {width}px"
        page.set_viewport_size({"width": 390, "height": 844})
        menu = page.get_by_role("button", name="Menü", exact=True)
        menu.click()
        expect(menu).to_have_attribute("aria-expanded", "true")
        page.keyboard.press("Escape")
        expect(menu).to_have_attribute("aria-expanded", "false")
        expect(menu).to_be_focused()
        menu.click()
        page.locator("#navigation").get_by_role("link", name="Projekte", exact=True).click()
        expect(menu).to_have_attribute("aria-expanded", "false")

        page.set_viewport_size({"width": 1440, "height": 1000})
        preview_link = page.locator(".project-card .text-link").first
        preview_link.click()
        expect(page.get_by_role("dialog")).to_be_visible()
        expect(page.locator("#preview-title")).to_have_text("SmartADM Sales")
        expect(page.locator(".preview-counter")).to_have_text("2 / 3")
        page.get_by_role("button", name="Nächstes Bild", exact=True).click()
        expect(page.locator("#preview-title")).to_have_text("SmartADM Office")
        page.keyboard.press("ArrowRight")
        expect(page.locator("#preview-title")).to_have_text("iQuest")
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_be_hidden()
        expect(preview_link).to_be_focused()

        expect(page.locator(".trailer-player iframe")).to_have_count(0)
        assert not video_requests, "YouTube contacted before a click"
        page.locator("[data-load-trailer]").click()
        player = page.locator(".trailer-player iframe")
        expect(player).to_have_count(1)
        assert player.get_attribute("src").startswith("https://www.youtube-nocookie.com/embed/m6fthG8m1qE?")
        expect(player).to_have_attribute("title", "iQuest-Trailer – YouTube-Video")
        assert player.get_attribute("allowfullscreen") is not None
        expect(page.frame_locator(".trailer-player iframe").locator("body")).to_contain_text("Video player")
        assert len(video_requests) == 1
        page.reload(wait_until="networkidle")
        expect(page.locator(".trailer-player iframe")).to_have_count(0)
        assert len(video_requests) == 1, "Reload unexpectedly contacted YouTube"
        page.locator(".heimello-world-board").click()
        expect(page.locator("#preview-title")).to_have_text("heimello. · Wochen-Rallye")
        seen = set()
        for _ in range(6):
            src = page.locator("#preview-image").get_attribute("src")
            assert "/assets/heimello/" in src
            seen.add(src)
            page.get_by_role("button", name="Nächstes Bild", exact=True).click()
        assert len(seen) == 6, "heimello gallery must contain six current motifs"
        page.keyboard.press("Escape")
        page.get_by_role("button", name="E-Mail-Adresse kopieren").click()
        expect(page.locator(".copy-status")).to_have_text("E-Mail-Adresse kopiert.")
        assert page.evaluate("window.copiedEmail") == "kontakt@juschkinlabs.de"

        page.goto(f"{base}/datenintegration.html", wait_until="networkidle")
        expect(page.get_by_role("heading", level=1)).to_contain_text("Daten verbinden")
        questions = page.locator(".faq summary")
        expect(questions).to_have_count(5)
        questions.first.click()
        expect(page.locator(".faq details").first).to_have_attribute("open", "")
        mail = page.locator(".contact-mail")
        assert mail.get_attribute("href").startswith("mailto:kontakt@juschkinlabs.de?subject=Datenintegration%20und%20Automatisierung")
        page.get_by_role("button", name="E-Mail-Adresse kopieren").click()
        assert page.evaluate("window.copiedEmail") == "kontakt@juschkinlabs.de"
        for width in (320, 390, 820, 1440):
            page.set_viewport_size({"width": width, "height": 1000})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow on detail page at {width}px"
        page.set_viewport_size({"width": 1440, "height": 1000})

        for name in ("impressum.html", "datenschutz.html"):
            page.goto(f"{base}/{name}", wait_until="networkidle")
            assert page.locator('a[href*="beratung"], a[href*="private-einblicke"]').count() == 0
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), name
        # The public homepage must remain the existing bank website during this preview.
        if (ROOT / "index.html").exists():
            page.set_viewport_size({"width": 1440, "height": 1000})
            page.goto(origin + "/", wait_until="networkidle")
            expect(page.get_by_role("heading", level=1)).to_contain_text("Vom Dach in die Bank")
            page.get_by_role("button", name="Termin buchen", exact=True).click()
            page.get_by_role("button", name="Immobilien finanzieren", exact=True).click()
            for answer in ("Neubau", "Nein, noch auf Suche", "In 2-5 Jahren"):
                page.get_by_role("button", name=answer, exact=True).click()
            expect(page.get_by_role("button", name="Anfrage absenden")).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.locator("#booking-modal")).to_be_hidden()

        plain = browser.new_context(java_script_enabled=False, viewport={"width": 390, "height": 844})
        no_js = plain.new_page()
        no_js.goto(base + "/")
        expect(no_js.locator("#navigation")).to_be_visible()
        expect(no_js.locator(".hero-lead")).to_be_visible()
        expect(no_js.locator(".trailer-poster")).to_have_attribute("href", "https://www.youtube.com/watch?v=m6fthG8m1qE")
        expect(no_js.locator(".trailer-player iframe")).to_have_count(0)
        plain.close()
        page.emulate_media(reduced_motion="reduce")
        page.goto(base + "/", wait_until="networkidle")
        assert page.evaluate("getComputedStyle(document.documentElement).scrollBehavior") == "auto"

        if OUTPUT:
            OUTPUT.mkdir(parents=True, exist_ok=True)
            for image in page.locator('img[loading="lazy"]').all():
                image.scroll_into_view_if_needed()
                image.evaluate("image => image.decode()")
            page.evaluate("window.scrollTo(0, 0)")
            page.screenshot(path=str(OUTPUT / "portfolio-desktop.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 1000})
            page.screenshot(path=str(OUTPUT / "portfolio-mobile.png"), full_page=True)
        browser.close()
    assert not errors, errors
    print("PASS: local links, no private addresses, responsive layouts, navigation, character select, 3D editor, project gallery, current heimello gallery, click-to-load trailer, contact, detail page with FAQ, legal pages, unchanged public homepage and booking flow, no-JS and reduced-motion support.")
finally:
    server.shutdown()
    server.server_close()
    thread.join()
