#!/usr/bin/env python3
"""Bias Lens transcript service. GET /healthz, GET /transcript?url=<youtube url>.
Returns {videoId,title,author,thumbnail,language,languageCode,isGenerated,snippets:[{t,d,text}]}"""
import json, re, sys, urllib.parse, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from youtube_transcript_api import YouTubeTranscriptApi

PORT = int(open("/workspace/yt-bias/port").read().strip())
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

def video_id(s):
    s = (s or "").strip()
    if ID_RE.match(s): return s
    try: u = urllib.parse.urlparse(s if "://" in s else "https://" + s)
    except Exception: return None
    host = (u.hostname or "").lower()
    if host.endswith("youtu.be"):
        c = u.path.strip("/").split("/")[0]
        return c if ID_RE.match(c) else None
    if "youtube" in host:
        q = urllib.parse.parse_qs(u.query).get("v")
        if q and ID_RE.match(q[0]): return q[0]
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v") and ID_RE.match(parts[1]): return parts[1]
    return None

def oembed(vid):
    try:
        url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + vid)
        with urllib.request.urlopen(url, timeout=10) as r: return json.loads(r.read().decode())
    except Exception: return {}

def transcript(vid):
    api = YouTubeTranscriptApi()
    tl = api.list(vid)
    items = list(tl)
    pick = None
    for want_manual in (True, False):
        for t in items:
            if t.is_generated != want_manual and t.language_code.split("-")[0] == "en": pick = t; break
        if pick: break
    if not pick:
        manual = [t for t in items if not t.is_generated]
        pick = (manual or items)[0]
    f = pick.fetch()
    return pick, [{"t": round(s.start, 2), "d": round(s.duration, 2), "text": s.text} for s in f.snippets]

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*"); self.end_headers()
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path in ("/healthz", "/"): return self._send(200, {"ok": True})
        if u.path != "/transcript": return self._send(404, {"error": "not found"})
        q = urllib.parse.parse_qs(u.query)
        vid = video_id((q.get("url") or [""])[0])
        if not vid: return self._send(400, {"error": "That doesn't look like a YouTube link."})
        meta = oembed(vid)
        try:
            pick, snippets = transcript(vid)
        except Exception as e:
            name = type(e).__name__
            msg = {"TranscriptsDisabled": "Captions are turned off for this video.",
                   "NoTranscriptFound": "No transcript exists for this video.",
                   "VideoUnavailable": "This video is unavailable.",
                   "AgeRestricted": "This video is age-restricted.",
                   "RequestBlocked": "YouTube blocked the transcript request.",
                   "IpBlocked": "YouTube blocked the transcript request."}.get(name, "Couldn't fetch captions (" + name + ").")
            return self._send(422, {"error": msg, "kind": name, "videoId": vid, "title": meta.get("title"), "author": meta.get("author_name")})
        self._send(200, {"videoId": vid, "title": meta.get("title"), "author": meta.get("author_name"),
            "thumbnail": meta.get("thumbnail_url"), "language": pick.language, "languageCode": pick.language_code,
            "isGenerated": pick.is_generated, "snippets": snippets})

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
