"""Update pinned public asset digests before deploying the Worker and publishing Pages."""
from pathlib import Path
import hashlib,json,re
ROOT=Path(__file__).resolve().parents[1]
paths=['/index.html','/kb.css','/smartadm/sales/index.html','/smartadm/sales/cloud.js','/smartadm/office/','/smartadm/office/sw.js','/smartadm/office/week-planner.js','/smartadm/office/vendor/xlsx-0.20.3.min.js','/smartadm/office/vendor/html2pdf.min.js']
digests={p:hashlib.sha256((ROOT/(p.lstrip('/')+'index.html' if p.endswith('/') else p.lstrip('/'))).read_bytes()).hexdigest() for p in paths}
worker=ROOT/'cloudflare/smartadm-office-api/worker.js'
s=worker.read_text();s=re.sub(r'const MONITORED_ASSETS = .*?;\n// END MONITORED_ASSETS', 'const MONITORED_ASSETS = '+json.dumps(digests,indent=2)+';\n// END MONITORED_ASSETS',s,flags=re.S);worker.write_text(s)
print(f'Pinned {len(digests)} public asset digests.')
