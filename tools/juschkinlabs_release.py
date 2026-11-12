"""Baut das Upload-Paket für juschkinlabs.de aus der Vorschau in 1293e128973/.

Aufruf: python3 tools/juschkinlabs_release.py
Ergebnis: dist/juschkinlabs.de/ und dist/JuschkinLabs_live.zip

- entfernt alles mit data-preview-only (noindex, Hinweise auf die Vorschau)
- legt robots.txt, sitemap.xml und .htaccess (alte Adresse fakten.html, MIME-Typen) dazu
- der Testbericht datenimport-arbeitsbeleg.5d3c9ccf91b5.pdf bleibt auf dem Server liegen und wird nicht überschrieben
"""
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "1293e128973"
DIST = ROOT / "dist"
TARGET = DIST / "juschkinlabs.de"
DOMAIN = "https://juschkinlabs.de"
PAGES = ["index.html", "datenintegration-automatisierung.html", "impressum.html", "datenschutz.html"]

if TARGET.exists():
    shutil.rmtree(TARGET)
shutil.copytree(SOURCE, TARGET, ignore=shutil.ignore_patterns("README.md", "*.json", ".DS_Store"))

for name in PAGES:
    path = TARGET / name
    html = path.read_text(encoding="utf-8")
    html = re.sub(r"\s*<meta[^>]*data-preview-only[^>]*>", "", html)
    html = re.sub(r"\s*<p data-preview-only>.*?</p>", "", html, flags=re.S)
    assert "1293e128973" not in html.replace("kim-betcher.de/1293e128973", ""), name
    assert "data-preview-only" not in html, name
    path.write_text(html, encoding="utf-8")

(TARGET / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {DOMAIN}/sitemap.xml\n", encoding="utf-8")
urls = "\n".join(f"  <url><loc>{DOMAIN}/{'' if page == 'index.html' else page}</loc></url>" for page in PAGES)
(TARGET / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}\n</urlset>\n', encoding="utf-8")
(TARGET / ".htaccess").write_text(
    "AddType model/gltf-binary .glb\n"
    "AddType image/webp .webp\n"
    "AddType audio/mpeg .mp3\n"
    "RewriteEngine On\n"
    "RewriteRule ^fakten\\.html$ /#team [R=301,NE,L]\n",
    encoding="utf-8",
)
archive = shutil.make_archive(str(DIST / "JuschkinLabs_live"), "zip", TARGET)
print("Fertig:", archive)
