"""Check that every file embedded in a built artifact matches the commit byte for byte, and that none is missing."""
import base64, hashlib, json, re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build import committed_files

html = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
commit = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
raw = re.search(r'<script type="application/json" id="files">(.*?)</script>', html, re.S).group(1)
embedded = json.loads(raw)   # "<\/" is a valid JSON escape for "</", so this restores the originals
want = dict(committed_files(commit))
bad = 0
for path, data in sorted(want.items()):
    e = embedded.get(path)
    got = None if e is None else (e["text"].encode("utf-8") if "text" in e else base64.b64decode(e["base64"]))
    ok = got == data
    bad += not ok
    print(f"{'ok  ' if ok else 'DIFF'} {hashlib.sha256(data).hexdigest()[:16]} {path}")
extra = set(embedded) - set(want)
for p in sorted(extra):
    print(f"EXTRA {p}")
print(f"\n{len(want) - bad} of {len(want)} files identical to {commit}" + (f", {len(extra)} extra" if extra else ""))
sys.exit(1 if bad or extra else 0)
