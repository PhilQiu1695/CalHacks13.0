"""Builds dist/slant-for-youtube-<v>.zip (manifest.json at the root, load unpacked) and dist/slant-extension-source-<v>.zip,
then refuses to finish if either archive contains a real secret (admin token, pepper, browser keys, ingress tokens)."""
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
DIST = os.path.join(ROOT, "dist")
PUBLISH = "/cloudspace/app-storage/apps/slant-extension/console/dist"


def files(base, skip_dirs=(), skip_names=()):
    for d, dirs, fs in os.walk(base):
        dirs[:] = [x for x in dirs if not x.startswith(".") and os.path.relpath(os.path.join(d, x), ROOT) not in skip_dirs and x not in ("__pycache__", "node_modules")]
        for f in fs:
            if not f.startswith(".") and f not in skip_names and not f.endswith((".pyc", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm")):
                yield os.path.join(d, f)


def main():
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "build_core.py")], check=True)
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "build_bear.py")], check=True)
    m = json.load(open(os.path.join(EXT, "manifest.json")))
    v = m["version"]
    os.makedirs(DIST, exist_ok=True)
    ext_zip = os.path.join(DIST, f"slant-for-youtube-{v}.zip")
    src_zip = os.path.join(DIST, f"slant-extension-source-{v}.zip")
    with zipfile.ZipFile(ext_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(files(EXT)):
            z.write(f, os.path.relpath(f, EXT))
    with zipfile.ZipFile(src_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for top in ("extension", "backend", "spec", "tests", "scripts", "docs", "reference"):
            for f in sorted(files(os.path.join(ROOT, top), skip_dirs=("backend/data",))):
                z.write(f, os.path.join("slant-extension", os.path.relpath(f, ROOT)))
        z.write(os.path.join(ROOT, "README.md"), "slant-extension/README.md")
    secrets = [open(os.path.join(ROOT, "backend", "data", n)).read().strip() for n in ("admin.token", "pepper")]
    patterns = [re.compile(r"slk_[A-Za-z0-9_-]{30,}"), re.compile(r"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}")]
    for zp in (ext_zip, src_zip):
        with zipfile.ZipFile(zp) as z:
            names = z.namelist()
            if zp == ext_zip:
                assert "manifest.json" in names, "manifest.json must be at the root"
            for n in names:
                data = z.read(n).decode("utf-8", "ignore")
                assert not any(s and s in data for s in secrets), f"secret found in {zp}:{n}"
                assert not any(p.search(data) for p in patterns), f"token-like string in {zp}:{n}"
                assert "backend/data/" not in n, n
    os.makedirs(PUBLISH, exist_ok=True)
    for zp in (ext_zip, src_zip):
        shutil.copyfile(zp, os.path.join(PUBLISH, os.path.basename(zp)))
    print(json.dumps({"version": v, "extension": {"file": os.path.basename(ext_zip), "bytes": os.path.getsize(ext_zip), "entries": len(zipfile.ZipFile(ext_zip).namelist())},
                      "source": {"file": os.path.basename(src_zip), "bytes": os.path.getsize(src_zip)}, "published_to": PUBLISH}))


if __name__ == "__main__":
    main()
