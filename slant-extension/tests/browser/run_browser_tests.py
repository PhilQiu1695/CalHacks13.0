#!/usr/bin/env python3
"""LEGACY (extension ≤1.3, side panel): its scenarios no longer apply to 1.4; run tests/browser/run_card_tests.py instead.
The helpers here (saved_videos, admin_code, backend_jobs, Cdp) are shared with run_card_tests.py.

Real-browser checks for the Slant extension: bundled Chromium (headed, under Xvfb) with the unpacked extension, the toolbar
action fired by a real keyboard gesture (Alt+Shift+S through xdotool, which grants activeTab like a click), the side panel driven
over the DevTools protocol, and the deployed slant-ext backend through its public ingress link.

Costs nothing: only videos that are already saved in Slant (cached) are analyzed, and in-progress behaviour uses the backend's
simulated jobs, which are available only to test browsers paired with an admin-minted test code. Test keys are revoked at the end.
Run: /workspace/.venv/bin/python tests/browser/run_browser_tests.py
"""
import glob
import json
import os
import subprocess
import sys
import time
import traceback

import requests
from playwright.sync_api import sync_playwright
from websockets.sync.client import connect as wsconnect

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXT = os.path.join(ROOT, "extension")
SHOTS = os.path.join(ROOT, "tests", "browser", "shots")
LOCAL = "http://127.0.0.1:" + open(os.path.join(ROOT, "backend", "data", "port")).read().strip()
ADMIN = {"X-Slant-Admin": open(os.path.join(ROOT, "backend", "data", "admin.token")).read().strip()}
DEVTOOLS = "http://127.0.0.1:9334"
sys.path.append("/opt/sandbox_libs")
from ingress.utils import mint_ingress_token  # noqa: E402

RESULTS, CREDS = [], []


def record(name, ok, detail=""):
    RESULTS.append({"scenario": name, "pass": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (" :: " + detail if detail else ""), flush=True)


def wait_until(fn, timeout=20, step=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(step)
    raise TimeoutError(f"timed out; last={last!r}"[:300])


def admin_code(test=True):
    r = requests.post(LOCAL + "/v1/owner/pairing-codes", json={"label": "browser test", "test": test}, headers=ADMIN, timeout=20)
    r.raise_for_status()
    return r.json()["code"]


def backend_jobs():
    return requests.get(LOCAL + "/v1/owner/status", headers=ADMIN, timeout=30).json()["jobs"]


class Cdp:
    def __init__(self, ws_url):
        self.ws = wsconnect(ws_url, max_size=64_000_000, open_timeout=10)
        self.i = 0

    def call(self, method, params=None, timeout=30):
        self.i += 1
        mid = self.i
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv(timeout=timeout))
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def eval(self, expr, timeout=30):
        r = self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, timeout)
        if r.get("exceptionDetails"):
            raise RuntimeError(r["exceptionDetails"].get("text", "") + " " + json.dumps(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


class Panel:
    """The side panel, reached over DevTools. Reconnects when the panel is closed and reopened."""
    def __init__(self):
        self.cdp, self.tid = None, None

    def target(self):
        for t in requests.get(DEVTOOLS + "/json/list", timeout=10).json():
            if t["type"] == "page" and t["url"].endswith("/sidepanel.html"):
                return t
        return None

    def conn(self):
        t = wait_until(self.target, 15)
        if t["id"] != self.tid:
            if self.cdp:
                self.cdp.close()
            self.cdp, self.tid = Cdp(t["webSocketDebuggerUrl"]), t["id"]
            wait_until(lambda: self.cdp.eval("!!(globalThis.__slant && document.readyState === 'complete')"), 15)
        return self.cdp

    def ev(self, expr):
        return self.conn().eval(expr)

    def state(self):
        return json.loads(self.ev("JSON.stringify(__slant.state())"))

    def text(self):
        return self.ev("document.getElementById('app').innerText")

    def has(self, sel):
        return self.ev(f"!!document.querySelector({json.dumps(sel)})")

    def click(self, sel):
        return self.ev(f"(() => {{ const el = document.querySelector({json.dumps(sel)}); if (!el) return false; el.click(); return true; }})()")

    def fill(self, sel, value):
        return self.ev(f"(() => {{ const el = document.querySelector({json.dumps(sel)}); el.value = {json.dumps(value)}; "
                       "el.dispatchEvent(new Event('input', {bubbles: true})); return true; })()")

    def shot(self, name):
        os.makedirs(SHOTS, exist_ok=True)
        import base64
        data = self.conn().call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})["data"]
        p = os.path.join(SHOTS, name + ".png")
        open(p, "wb").write(base64.b64decode(data))
        return p

    def close_panel(self):
        t = self.target()
        if t:
            requests.get(DEVTOOLS + "/json/close/" + t["id"], timeout=10)
            wait_until(lambda: self.target() is None, 10)


def saved_videos():
    """Videos with a saved analysis in Slant right now, newest first: [(videoId, isShort)]."""
    from firebase_helper import firebase
    import env  # noqa: F401
    uid = os.environ["SANDBOX_USER_ID"]
    recs = firebase.read(f"{uid}/file-system/apps/slant/app/analyses") or {}
    rows = sorted(((v.get("metadata") or {}).get("createdAt", 0), v.get("videoId"), "/shorts/" in (v.get("url") or ""))
                  for v in recs.values() if isinstance(v, dict) and v.get("videoId") and v.get("result"))
    seen, out = set(), []
    for _, vid, short in reversed(rows):
        if vid not in seen:
            seen.add(vid)
            out.append((vid, short))
    return out


def is_saved(vid):
    return any(v == vid for v, _ in saved_videos())


class YtTab:
    """The browser tab, driven over its own DevTools target; Chrome's view of the tab is the source of truth."""
    def target(self):
        for t in requests.get(DEVTOOLS + "/json/list", timeout=10).json():
            if t["type"] == "page" and not t["url"].startswith(("chrome-extension://", "devtools://")):
                return t
        raise RuntimeError("no tab")

    def nav(self, url):
        c = Cdp(self.target()["webSocketDebuggerUrl"])
        try:
            c.call("Page.navigate", {"url": url})
            wait_until(lambda: c.eval("document.readyState") in ("interactive", "complete") and c.eval("location.href").startswith(url[:40]), 30)
        finally:
            c.close()
        time.sleep(0.8)

    def eval(self, js):
        c = Cdp(self.target()["webSocketDebuggerUrl"])
        try:
            return c.eval(js)
        finally:
            c.close()


def main():
    os.environ["DISPLAY"] = ":98"
    xvfb = subprocess.Popen(["Xvfb", ":98", "-screen", "0", "1440x900x24", "-nolisten", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    chromium = glob.glob("/workspace/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")[0]
    prof = "/tmp/slant-browser-test-profile"
    subprocess.run(["rm", "-rf", prof])
    pw = sync_playwright().start()
    ctx = pw.chromium.launch_persistent_context(prof, headless=False, executable_path=chromium, viewport=None, env={**os.environ},
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-first-run", "--window-size=1400,880",
              "--window-position=0,0", "--remote-debugging-port=9334"])
    panel, yt = Panel(), YtTab()
    if not ctx.pages:
        ctx.new_page()
    saved = saved_videos()
    watch = [v for v, short in saved if not short]
    shorts = [v for v, short in saved if short]
    A = "lmjHE8CEhPM" if "lmjHE8CEhPM" in watch else watch[0]
    pool = [v for v in watch if v != A]
    print(f"saved videos: {len(saved)} (watch {len(watch)}, shorts {len(shorts)}); A={A}", flush=True)

    def press_action():
        w = subprocess.run(["xdotool", "search", "--onlyvisible", "--class", "chromium"], capture_output=True, text=True).stdout.split()
        subprocess.run(["xdotool", "windowactivate", "--sync", w[-1]], capture_output=True)
        subprocess.run(["xdotool", "key", "--clearmodifiers", "alt+shift+s"], capture_output=True)

    def handled():
        try:
            return panel.ev("chrome.storage.session.get('handled').then(o => o.handled || null)") if panel.target() else None
        except Exception:
            return None

    def press_and_claim():
        before = handled()
        press_action()
        return wait_until(lambda: (lambda h: h if h and h != before else None)(handled()), 15)

    def req_is(vid, state):
        s = panel.state()
        return s if s["req"] and s["req"]["videoId"] == vid and s["req"]["job"] and s["req"]["job"]["state"] == state else None

    def safe(vid):
        if not is_saved(vid):
            raise RuntimeError(f"skipped: {vid} is no longer saved in Slant, so analyzing it would cost credits")
        return vid

    def tab_url(tab_id):
        return panel.ev(f"chrome.tabs.get({tab_id}).then(t => t.url || null).catch(() => null)")

    def ntabs():
        return panel.ev("chrome.tabs.query({}).then(ts => ts.length)")

    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        day_link = mint_ingress_token("slant-ext", ttl_seconds=86400)["ingress_url"]

        name = "S1 pair via pasted link; the pending toolbar click is analyzed (cached)"
        try:
            yt.nav("https://www.youtube.com/watch?v=" + safe(A))
            press_action()
            wait_until(lambda: panel.has("#link"), 15)
            note = "Your click is saved" in panel.text()
            panel.shot("01-setup")
            panel.fill("#link", day_link + "#pair=" + admin_code(test=True))
            panel.fill("#label", "Browser test (Chromium)")
            panel.click("#connect")
            s = wait_until(lambda: req_is(A, "done"), 30)
            CREDS.append(s["conn"]["credentialId"])
            sync = panel.ev("chrome.storage.sync.get(null).then(o => Object.keys(o).length)")
            local_key = panel.ev("chrome.storage.local.get('conn').then(o => !!(o.conn && o.conn.key))")
            panel.shot("02-watch-result")
            record(name, note and s["req"]["job"]["cached"] and sync == 0 and local_key,
                   f"saved-click note={note}, cached={s['req']['job']['cached']}, key in local storage={local_key}, sync items={sync}")
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S2 summary: lean, slant score, five signals (tap to expand), summary, full-report link, disclosures"
        try:
            t = panel.text()
            checks = {"lean": panel.has("#lean") or "Not political" in t, "overall": panel.has("#overall"),
                      "five signals": panel.ev("document.querySelectorAll('#signals .dim').length") == 5,
                      "headline+summary": panel.ev("document.querySelector('.headline').innerText.length > 5"),
                      "full report link": panel.has("#open-full"),
                      "signal expands on tap": panel.ev("(() => { const b = document.querySelector('#signals .dim-row'); b.click(); return document.querySelector('#signals .dim-row').getAttribute('aria-expanded') === 'true'; })()"),
                      "source disclosure": panel.ev("document.getElementById('disclosure').innerText.length > 10"),
                      "Open in Slant under the status line": panel.ev("(() => { const b = document.getElementById('open-mana'); const s = document.getElementById('status'); return !!b && b.textContent.trim() === 'Open in Slant' && !!b.closest('#video-header') && !!s && !!(s.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })()"),
                      "not in footer": panel.ev("!document.querySelector('#disclosure #open-mana')"),
                      "saved label": "Saved analysis" in t}
            record(name, all(checks.values()), json.dumps(checks))
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S3 'Open full report' and 'Open in Slant' open this analysis on the Slant website in a new tab"
        try:
            n = ntabs()
            panel.click("#open-full")
            wait_until(lambda: ntabs() > n, 10)
            pages = [p for p in requests.get(DEVTOOLS + "/json/list", timeout=10).json() if p["type"] == "page" and "mana.space" in p["url"]]
            ok = any("apps/slant?slant=" in p["url"] for p in pages)
            for p in pages:
                requests.get(DEVTOOLS + "/json/close/" + p["id"], timeout=10)
            # 1.3.1: "Open in Slant" (header) opens this exact analysis too
            rid = panel.state()["req"]["job"]["result"]["recordId"]
            n = ntabs()
            panel.click("#open-mana")
            wait_until(lambda: ntabs() > n, 10)
            pages2 = [p for p in requests.get(DEVTOOLS + "/json/list", timeout=10).json() if p["type"] == "page" and "mana.space" in p["url"]]
            ok2 = any(("apps/slant?slant=" + rid) in p["url"] for p in pages2)
            for p in pages2:
                requests.get(DEVTOOLS + "/json/close/" + p["id"], timeout=10)
            record(name, ok and ok2, f"full report={pages[0]['url'][-40:] if pages else 'no tab'}; Open in Slant opened slant={rid}: {ok2}")
            time.sleep(1)
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S4 SPA navigation keeps the old result labelled; its timestamps open a new tab; a click analyzes the new video"
        try:
            B, C = safe(pool[0]), safe(pool[1])
            yt.nav("https://www.youtube.com/watch?v=" + A)
            press_and_claim()
            wait_until(lambda: req_is(A, "done"), 20)
            tid = panel.state()["req"]["tabId"]
            yt.eval(f"history.pushState({{}}, '', '/watch?v={B}')")
            wait_until(lambda: panel.has("#stale"), 10)
            header_vid = panel.ev("document.getElementById('video-header').dataset.video")
            stale_text = panel.ev("document.getElementById('stale').innerText")
            panel.shot("03-spa-stale")
            opened = ["(timestamps moved to the full report in 1.3.0)"]
            untouched = B in (tab_url(tid) or "")
            panel.ev(f"chrome.tabs.update({tid}, {{active: true}})")
            time.sleep(1)
            press_and_claim()
            wait_until(lambda: req_is(B, "done"), 30)
            ok = header_vid == A and "still for" in stale_text and untouched and len(opened) == 1
            record(name, ok, f"label kept={header_vid == A}, banner='{stale_text[:60]}', other-video tab untouched={untouched}, "
                             "timestamps now live on the full report")
            yt.eval(f"history.pushState({{}}, '', '/watch?v={C}')")
            wait_until(lambda: panel.has("#analyze-current"), 10)
            panel.click("#analyze-current")
            wait_until(lambda: req_is(C, "done"), 30)
            record("S4b 'Analyze the current video' (in the panel) reads the tab's URL at click time", True, C)
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S5 Short analyzed with the Short layout; a repeat click submits nothing"
        try:
            if not shorts:
                raise RuntimeError("skipped: no saved Short in Slant right now")
            S = safe(shorts[0])
            yt.nav("https://www.youtube.com/shorts/" + S)
            press_and_claim()
            s = wait_until(lambda: req_is(S, "done"), 30)
            short_layout = panel.ev("document.getElementById('video-header').classList.contains('short')")
            jid, n_jobs = s["req"]["jobId"], len(backend_jobs())
            panel.shot("04-short")
            press_and_claim()
            time.sleep(2)
            same = panel.state()["req"]["jobId"] == jid and len(backend_jobs()) == n_jobs
            record(name, short_layout and same, f"Short layout={short_layout}, same job and no new backend job={same}")
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S6 non-video pages show 'Open a YouTube video to analyze it.'"
        try:
            outcomes = []
            for url in ("https://example.com/", "https://www.youtube.com/"):
                n_jobs = len(backend_jobs())
                yt.nav(url)
                press_and_claim()
                wait_until(lambda: panel.has("#not-video"), 10)
                outcomes.append("Open a YouTube video to analyze it." in panel.text() and len(backend_jobs()) == n_jobs and not panel.has("#open-mana"))
            panel.shot("05-not-video")
            record(name, all(outcomes), f"example.com, youtube.com home: {outcomes}")
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S7 out-of-credits and rate-limit errors render; retry offered only when it helps"
        try:
            seen, no_open = {}, []
            for sim, vid in (("fail-credits", pool[2]), ("fail-rate", pool[3])):
                safe(vid)
                panel.ev(f"chrome.storage.local.set({{debug: {{simulate: '{sim}'}}}})")
                yt.nav("https://www.youtube.com/watch?v=" + vid)
                press_and_claim()
                wait_until(lambda: req_is(vid, "failed"), 25)
                seen[sim] = {"code": panel.ev("document.getElementById('error').dataset.code"), "retry": panel.has("#retry")}
                no_open.append(not panel.has("#open-mana"))
                panel.shot("06-error-" + sim)
            ok = seen["fail-credits"] == {"code": "insufficient_credits", "retry": False} and seen["fail-rate"] == {"code": "rate_limited", "retry": True}
            record(name, ok and all(no_open), json.dumps(seen) + f"; no Open in Slant after errors={all(no_open)}")
        except Exception as e:
            record(name, False, repr(e)[:300])
        finally:
            panel.ev("chrome.storage.local.remove('debug')")

        name = "S8 panel closed + service worker stopped mid-job: reopening resumes the same job"
        try:
            V = safe(pool[4])
            t_start = int(time.time() * 1000)
            panel.ev("chrome.storage.local.set({debug: {simulate: 'slow-success'}})")
            yt.nav("https://www.youtube.com/watch?v=" + V)
            press_and_claim()
            wait_until(lambda: req_is(V, "running"), 15)
            running_hidden = not panel.has("#open-mana")
            jid = panel.state()["req"]["jobId"]
            panel.shot("07-progress")
            panel.close_panel()
            bws = Cdp(requests.get(DEVTOOLS + "/json/version", timeout=10).json()["webSocketDebuggerUrl"])
            for t in bws.call("Target.getTargets")["targetInfos"]:
                if t["type"] == "service_worker" and ext_id in t["url"]:
                    bws.call("Target.closeTarget", {"targetId": t["targetId"]})
            sw_gone = wait_until(lambda: not [t for t in requests.get(DEVTOOLS + "/json/list", timeout=10).json()
                                              if t["type"] == "service_worker" and ext_id in t["url"]], 10)
            bws.close()
            time.sleep(2)
            press_action()
            s = wait_until(lambda: req_is(V, "done"), 40)
            same_job = s["req"]["jobId"] == jid
            sims = [j for j in backend_jobs() if j["video_id"] == V and j["simulate"] == "slow-success" and j["created_at"] >= t_start]
            panel.shot("08-resumed-result")
            sim_hidden = wait_until(lambda: panel.has("#result") or None, 10) and not panel.has("#open-mana")
            record(name, same_job and len(sims) == 1 and s["req"]["job"]["simulated"] and running_hidden and sim_hidden,
                   f"worker stopped={bool(sw_gone)}, same job={same_job}, backend jobs for this video={len(sims)}, "
                   f"Open in Slant hidden while running={running_hidden} and on the simulated result={sim_hidden}")
        except Exception as e:
            record(name, False, repr(e)[:300])
        finally:
            panel.ev("chrome.storage.local.remove('debug')")

        name = "S11 Analyze again still works (simulated, free); Open in Slant hides while it runs and returns on the saved result"
        try:
            yt.nav("https://www.youtube.com/watch?v=" + A)
            press_and_claim()
            wait_until(lambda: req_is(A, "done"), 20)
            shown_before = panel.has("#video-header #open-mana")
            panel.ev("chrome.storage.local.set({debug: {simulate: 'slow-success'}})")
            panel.click("#again"); time.sleep(0.3)
            confirm_shown = panel.has("#confirm-again")
            panel.click("#confirm-again")
            s = wait_until(lambda: req_is(A, "running"), 15)
            fresh_mode = s["req"]["job"].get("mode") in (None, "fresh") or s["req"].get("mode") == "fresh"
            hidden_running = not panel.has("#open-mana")
            s = wait_until(lambda: req_is(A, "done"), 40)
            hidden_sim = not panel.has("#open-mana")
            panel.ev("chrome.storage.local.remove('debug')")
            P0 = safe(pool[0])                      # a repeat click on the same video reuses its result, so open another saved one first
            yt.nav("https://www.youtube.com/watch?v=" + P0)
            press_and_claim()
            wait_until(lambda: req_is(P0, "done"), 20)
            yt.nav("https://www.youtube.com/watch?v=" + A)
            press_and_claim()
            wait_until(lambda: req_is(A, "done") and panel.has("#video-header #open-mana") or None, 20)
            back = panel.has("#video-header #open-mana") and not panel.has("#disclosure #open-mana")
            panel.shot("11-open-in-slant")
            record(name, shown_before and confirm_shown and s["req"]["job"]["simulated"] and hidden_running and hidden_sim and back,
                   f"shown on saved={shown_before}, confirm={confirm_shown}, simulated fresh run done={s['req']['job']['simulated']}, "
                   f"hidden while running={hidden_running}, hidden on simulated={hidden_sim}, back on saved result={back}")
        except Exception as e:
            record(name, False, repr(e)[:300])
        finally:
            panel.ev("chrome.storage.local.remove('debug')")

        name = "S12 at 320 px wide the header doesn't overflow and Open in Slant fits"
        try:
            c = panel.conn()
            c.call("Emulation.setDeviceMetricsOverride", {"width": 320, "height": 760, "deviceScaleFactor": 1, "mobile": False})
            time.sleep(0.6)
            m = json.loads(panel.ev("JSON.stringify((() => { const hd = document.getElementById('video-header'); const b = document.getElementById('open-mana'); "
                                    "const r = b ? b.getBoundingClientRect() : null; const hr = hd.getBoundingClientRect(); "
                                    "return {docW: document.documentElement.scrollWidth, vw: innerWidth, hdRight: hr.right, hdScroll: hd.scrollWidth - hd.clientWidth, "
                                    "btnRight: r && r.right, btnH: r && r.height}; })())"))
            panel.shot("12-320px")
            c.call("Emulation.clearDeviceMetricsOverride")
            ok = m["docW"] <= 320 and m["hdRight"] <= 320.5 and m["hdScroll"] <= 0 and m["btnRight"] is not None and m["btnRight"] <= 320
            record(name, ok, json.dumps(m))
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S9 revoked key shows 'This browser was disconnected' and asks to pair again"
        try:
            V9 = safe(pool[5])
            cid = panel.state()["conn"]["credentialId"]
            requests.post(f"{LOCAL}/v1/owner/credentials/{cid}/revoke", json={}, headers=ADMIN, timeout=20)
            yt.nav("https://www.youtube.com/watch?v=" + V9)
            press_and_claim()
            wait_until(lambda: "This browser was disconnected" in panel.text(), 15)
            panel.shot("09-revoked")
            record(name, True)
        except Exception as e:
            record(name, False, repr(e)[:300])

        name = "S10 expired link detected (by the panel and by the gateway); a reconnect link restores it with the same key"
        try:
            V9, V10, V11 = safe(pool[5]), safe(pool[6]), safe(pool[7])
            short_link = mint_ingress_token("slant-ext", ttl_seconds=25)["ingress_url"]
            panel.fill("#link", short_link + "#pair=" + admin_code(test=True))
            panel.click("#connect")
            s = wait_until(lambda: req_is(V9, "done"), 30)        # the request refused in S9 resumes with its same key
            CREDS.append(s["conn"]["credentialId"])
            key_before = s["conn"]["credentialId"]
            time.sleep(27)
            yt.nav("https://www.youtube.com/watch?v=" + V10)
            press_and_claim()
            wait_until(lambda: "Connection link expired" in panel.text(), 15)
            panel.shot("10-expired")
            panel.fill("#link", day_link)
            panel.click("#connect")
            s = wait_until(lambda: req_is(V10, "done"), 30)
            same_key = s["conn"]["credentialId"] == key_before
            panel.ev(f"chrome.storage.local.get('conn').then(o => chrome.storage.local.set({{conn: {{...o.conn, base: {json.dumps(short_link)}, linkExp: null}}}}))")
            time.sleep(0.5)
            yt.nav("https://www.youtube.com/watch?v=" + V11)
            press_and_claim()
            wait_until(lambda: "Connection link expired" in panel.text(), 15)
            panel.fill("#link", day_link)
            panel.click("#connect")
            wait_until(lambda: req_is(V11, "done"), 30)
            record(name, same_key, f"key kept across reconnect={same_key}")
        except Exception as e:
            record(name, False, repr(e)[:300])
    finally:
        for cid in CREDS:
            try:
                requests.post(f"{LOCAL}/v1/owner/credentials/{cid}/revoke", json={}, headers=ADMIN, timeout=20)
            except Exception:
                pass
        try:
            ctx.close()
            pw.stop()
        except Exception:
            pass
        xvfb.terminate()
        subprocess.run(["rm", "-rf", prof])
    passed = sum(r["pass"] for r in RESULTS)
    out = {"chromium": os.path.basename(os.path.dirname(os.path.dirname(chromium))), "passed": passed, "total": len(RESULTS),
           "results": RESULTS, "ranAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")}
    json.dump(out, open(os.path.join(ROOT, "tests", "browser", "last_run.json"), "w"), indent=1)
    print(f"\n{passed}/{len(RESULTS)} browser scenarios passed")


if __name__ == "__main__":
    main()
