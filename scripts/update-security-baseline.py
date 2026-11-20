"""Pin the bytes Git will publish. Stage asset edits before running locally."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
worker = ROOT / "cloudflare/smartadm-office-api/worker.js"
source = worker.read_bytes()
pattern = rb"(// BEGIN MONITORED_ASSETS[^\n]*\nconst MONITORED_ASSETS = )(\{.*?\})(;\r?\n// END MONITORED_ASSETS)"
block = re.search(pattern, source, re.S)
if not block:
    raise SystemExit("Cannot find monitored asset list in Office Worker")

digests = {}
for url in json.loads(block[2]):
    path = url.lstrip("/") + ("index.html" if url.endswith("/") else "")
    # The Git index contains the release bytes, even in a Windows CRLF checkout.
    content = subprocess.check_output(["git", "show", ":" + path], cwd=ROOT)
    digests[url] = hashlib.sha256(content).hexdigest()

manifest = json.dumps(digests, indent=2).encode()
if b"\r\n" in block[2]:
    manifest = manifest.replace(b"\n", b"\r\n")
worker.write_bytes(source[:block.start(2)] + manifest + source[block.end(2):])
print(f"Pinned {len(digests)} public assets from the Git index.")
