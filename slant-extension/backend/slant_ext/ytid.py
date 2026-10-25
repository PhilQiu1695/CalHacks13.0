"""Strict YouTube video URL parsing. Mirrors extension/lib/ytid.js (shared fixture: tests/fixtures/ytid_cases.json).

Accepted (https only, exact hostnames, 11-character IDs):
  youtube.com | www.youtube.com | m.youtube.com : /watch?v=ID, /shorts/ID, /live/ID
  youtu.be : /ID
"""
import re
from urllib.parse import parse_qs, urlsplit

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
WATCH_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}
SHORTLINK_HOSTS = {"youtu.be"}


def parse(url):
    """Return {videoId, kind, canonicalUrl, isShort} for a YouTube video URL, else None."""
    if not isinstance(url, str) or not url or len(url) > 2048:
        return None
    s = url.strip()
    try:
        parts = urlsplit(s)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or parts.username or parts.password or port not in (None, 443):
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    segs = [p for p in parts.path.split("/") if p]
    vid = None
    kind = None
    if host in SHORTLINK_HOSTS:
        if len(segs) == 1:
            vid, kind = segs[0], "shortlink"
    elif host in WATCH_HOSTS:
        if segs == ["watch"]:
            vals = parse_qs(parts.query, keep_blank_values=True).get("v") or []
            if vals:
                vid, kind = vals[0], "watch"
        elif len(segs) == 2 and segs[0] in ("shorts", "live"):
            vid, kind = segs[1], segs[0]
    if not vid or not ID_RE.match(vid):
        return None
    is_short = kind == "shorts"
    canonical = ("https://www.youtube.com/shorts/" if is_short else "https://www.youtube.com/watch?v=") + vid
    return {"videoId": vid, "kind": kind, "canonicalUrl": canonical, "isShort": is_short}
