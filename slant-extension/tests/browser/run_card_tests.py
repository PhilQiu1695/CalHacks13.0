#!/usr/bin/env python3
"""Real-browser checks for Slant for YouTube 1.6 (no side panel: the bear, its speech bubble and the card are the interface).
Bundled Chromium, headed under Xvfb, with the unpacked extension; the bear's closed shadow root is read through DevTools
(DOM.getDocument with pierce) and clicked with real mouse events; the setup page is driven directly.

Costs nothing: only videos already saved in Slant are analyzed (cached), and in-progress, error and "Analyze again" behaviour
uses the backend's simulated jobs, available only to browsers paired with an admin-minted test code. Test keys are revoked.
Run: /workspace/.venv/bin/python tests/browser/run_card_tests.py [extension dir]
"""
import json, os, subprocess, sys, time, glob, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_browser_tests as R   # shared helpers: saved_videos, admin_code, backend_jobs, LOCAL, ADMIN, mint_ingress_token
from playwright.sync_api import sync_playwright
from websockets.sync.client import connect as wsconnect
import requests

EXT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else R.EXT
SHOTS = os.path.join(R.SHOTS, "card")
RESULTS = []


def record(name, ok, detail=""):
    RESULTS.append({"scenario": name, "pass": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (" :: " + detail if detail else ""), flush=True)


wait_until = R.wait_until


class Bear:
    """The bear on a YouTube tab, read through its closed shadow root."""
    def __init__(self, page, ctx):
        self.page, self.cdp = page, ctx.new_cdp_session(page)

    def _shadow(self):
        doc = self.cdp.send("DOM.getDocument", {"depth": -1, "pierce": True})["root"]
        stack = [doc]
        while stack:
            n = stack.pop()
            attrs = n.get("attributes") or []
            if "id" in attrs[::2] and attrs[attrs[::2].index("id") * 2 + 1] == "slant-bear-host":
                return n["shadowRoots"][0]["nodeId"] if n.get("shadowRoots") else None
            stack.extend(n.get("children") or [])
        return None

    def call(self, sel, fn):
        sid = self._shadow()
        if not sid:
            return None
        nid = self.cdp.send("DOM.querySelector", {"nodeId": sid, "selector": sel}).get("nodeId")
        if not nid:
            return None
        oid = self.cdp.send("DOM.resolveNode", {"nodeId": nid})["object"]["objectId"]
        r = self.cdp.send("Runtime.callFunctionOn", {"objectId": oid, "functionDeclaration": fn, "returnByValue": True})
        return r.get("result", {}).get("value")

    def all(self, sel, fn):
        return self.call(".col", "function(){ return [...this.querySelectorAll(%s)].map(%s); }" % (json.dumps(sel), fn))

    def text(self, sel):
        return self.call(sel, "function(){ return this.hidden || getComputedStyle(this).display === 'none' ? null : this.innerText; }")

    def rect(self, sel):
        return self.call(sel, "function(){ const r = this.getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width, h:r.height, r:r.right, b:r.bottom}; }")

    def visible(self, sel):
        r = self.call(sel, "function(){ const r = this.getBoundingClientRect(); return !this.hidden && r.width > 0 && r.height > 0; }")
        return bool(r)

    def click(self, sel):
        self.call(sel, "function(){ this.scrollIntoView({block: 'nearest'}); }")
        r = self.rect(sel)
        if not r or not r["w"]:
            raise RuntimeError("not clickable: " + sel)
        self.page.mouse.click(r["x"] + r["w"] / 2, r["y"] + min(r["h"] / 2, 60))

    def tip(self):
        return self.text(".tip")

    def card_open(self):
        return self.visible(".card")

    def shot(self, name):
        os.makedirs(SHOTS, exist_ok=True)
        r = self.rect(".col")
        if not r:
            return None
        bottom = max(r["b"], (self.rect(".card") or {}).get("b", 0) if self.card_open() else 0)
        p = os.path.join(SHOTS, name + ".png")
        self.page.screenshot(path=p, clip={"x": r["x"] - 12, "y": max(0, r["y"] - 12), "width": r["w"] + 24, "height": bottom - r["y"] + 24})
        return p


def main():
    os.environ["DISPLAY"] = ":97"
    xvfb = subprocess.Popen(["Xvfb", ":97", "-screen", "0", "1440x900x24", "-nolisten", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    chromium = glob.glob("/workspace/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")[0]
    prof = "/tmp/slant-card-test-profile"
    subprocess.run(["rm", "-rf", prof])
    pw = sync_playwright().start()
    ctx = pw.chromium.launch_persistent_context(prof, headless=False, executable_path=chromium, viewport={"width": 1400, "height": 860},
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-first-run", "--window-size=1400,900",
              "--window-position=0,0", "--remote-debugging-port=9335"])
    creds = []
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        day_link = R.mint_ingress_token("slant-ext", ttl_seconds=86400)["ingress_url"]
        saved = R.saved_videos()
        watch = [v for v, s in saved if not s]
        shorts = [v for v, s in saved if s]
        A = "AyMHJBLc_tA" if "AyMHJBLc_tA" in watch else watch[0]
        pool = [v for v in watch if v != A]
        print(f"saved: {len(saved)} (watch {len(watch)}, shorts {len(shorts)}); A={A}", flush=True)

        def safe(vid):
            if not any(v == vid for v, _ in R.saved_videos()):
                raise RuntimeError(f"skipped: {vid} is no longer saved in Slant, so analyzing it would cost credits")
            return vid

        yt = ctx.pages[0] if ctx.pages else ctx.new_page()
        bear = Bear(yt, ctx)
        ext = None   # an extension page (setup.html) used to read and write chrome.storage

        def ext_eval(js):
            return ext.evaluate(js)

        def req(vid):
            return ext_eval(f"chrome.storage.local.get('reqs').then(o => (o.reqs || {{}})[{json.dumps(vid)}] || null)")

        def nav(vid, short=False):
            yt.goto(("https://www.youtube.com/shorts/" if short else "https://www.youtube.com/watch?v=") + vid, wait_until="domcontentloaded")
            yt.bring_to_front()
            wait_until(lambda: bear.visible(".wrap"), 30)
            time.sleep(0.6)

        def done_tip():
            t = bear.tip() or ""
            return t if ("Tap me for results" in t or "Tap me again to hide" in t) else None

        # ---------------- C1 ----------------
        name = "C1 unpaired: the bear says 'Set up Slant'; a tap opens the setup page; pairing analyzes the waiting video (saved, free)"
        try:
            nav(safe(A))
            t0 = wait_until(lambda: (lambda t: t if t and "Set up Slant" in t else None)(bear.tip()), 15)
            with ctx.expect_page(timeout=15000) as pinfo:
                bear.click(".wrap")
            ext = pinfo.value
            ext.wait_for_load_state()
            finishing = wait_until(lambda: (lambda t: t if t and "Finish setup" in t else None)(bear.tip()), 10)
            ext.wait_for_selector("#setup[data-mode=pair]")
            ext.fill("#link", day_link + "#pair=" + R.admin_code(test=True))
            ext.click("#connect")
            ext.wait_for_selector("#connected-now", timeout=30000)
            msg = ext.inner_text("#connected-now")
            creds.append(ext_eval("chrome.storage.local.get('conn').then(o => o.conn.credentialId)"))
            t = wait_until(done_tip, 40)
            ext.screenshot(path=os.path.join(SHOTS, "setup-connected.png")) if os.makedirs(SHOTS, exist_ok=True) is None else None
            r = req(A)
            record(name, "being analyzed" in msg and r and r["job"]["state"] == "done" and r["job"].get("cached"),
                   f"tip before={t0!r}, after tap={finishing!r}, setup says={msg.splitlines()[1] if len(msg.splitlines())>1 else msg!r}, bear={t!r}, cached={r and r['job'].get('cached')}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()
        if ext is None:
            ext = ctx.new_page(); ext.goto(f"chrome-extension://{ext_id}/setup.html")

        # ---------------- C2 ----------------
        name = "C2 card: one centre line (bear, bubble, card), lean on the AllSides scale in words, five signals out of 10, equal Close / Full report buttons, no scrollbar, readable fonts"
        try:
            yt.bring_to_front()
            canvas = bear.rect("canvas"); tip = bear.rect(".tip")
            bear.click("canvas")
            wait_until(bear.card_open, 5)
            card = bear.rect(".card")
            txt = bear.text(".card")
            r = req(A)
            murl = r["job"]["result"]["manaUrl"]
            link = bear.call("#slant-report", "function(){ return {href: this.href, target: this.target, rel: this.rel}; }")
            btns = bear.all(".card .acts .btn", "e => { const r = e.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), x: r.x, r: r.right, t: e.textContent}; }")
            ov = bear.call(".card", "function(){ return this.scrollWidth - this.clientWidth; }")
            sigs = bear.all(".sig", "e => e.getAttribute('aria-label')")
            cx = lambda q: q["x"] + q["w"] / 2
            centred = abs(cx(card) - cx(canvas)) <= 1 and abs(cx(tip) - cx(canvas)) <= 1
            equal = len(btns) == 2 and abs(btns[0]["w"] - btns[1]["w"]) <= 1 and btns[0]["h"] == btns[1]["h"]
            inside = all(b["x"] >= card["x"] + 8 and b["r"] <= card["r"] - 8 for b in btns)
            words = all(s in txt for s in ("OTHER SIGNALS", "/ 10")) and \
                    (("POLITICAL LEAN" in txt and "AllSides scale" in txt and "−6 to +6" in txt) or "Not political" in txt)
            tip_hidden = "Tap me again to hide" in (bear.tip() or "")      # 1.6: the bubble stays and says how to hide the card
            nobar = bear.call(".card .body", "function(){ return this.offsetWidth - this.clientWidth; }")
            fonts = bear.call(".tip", "function(){ return [parseFloat(getComputedStyle(this.querySelector('.t1')).fontSize), parseFloat(getComputedStyle(this.querySelector('.t2')).fontSize)]; }")
            arrow = bear.rect(".ar-o")
            tip_hidden = tip_hidden and nobar == 0 and fonts[0] >= 22 and fonts[1] >= 18 and abs(cx(arrow) - cx(canvas)) <= 1
            in_view = card["b"] <= yt.viewport_size["height"]
            bear.shot("C2-card-" + A)
            record(name, centred and equal and inside and words and len(sigs) == 5 and link and link["href"] == murl and link["target"] == "_blank"
                   and "noopener" in link["rel"] and ov <= 0 and tip_hidden and in_view,
                   f"centres card/tip/bear {cx(card):.1f}/{cx(tip):.1f}/{cx(canvas):.1f}; buttons {[(b['t'], b['w']) for b in btns]}; inside={inside}; "
                   f"words={words}; signals={len(sigs)}; link={'ok' if link and link['href']==murl else link}; overflow={ov}; bubble/scrollbar/fonts ok={tip_hidden} (scrollbar {nobar}px, fonts {fonts}); in view={in_view}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()

        # ---------------- C3 ----------------
        name = "C3 interactions: Escape, Close and a second bear tap all hide the card; the card body scrolls with the wheel"
        step = "start"
        try:
            if not bear.card_open():
                bear.click("canvas"); wait_until(bear.card_open, 5)
            step = "wheel scroll"
            r = bear.rect(".card .body")
            yt.mouse.move(r["x"] + r["w"] / 2, r["y"] + r["h"] / 2)
            yt.mouse.wheel(0, 300); time.sleep(0.4)
            scrolled = bear.call(".card .body", "function(){ return this.scrollHeight <= this.clientHeight || this.scrollTop > 0; }")
            step = "escape"
            yt.keyboard.press("Escape")
            esc = wait_until(lambda: not bear.card_open() and "Tap me for results" in (bear.tip() or ""), 5)
            step = "reopen"
            bear.click("canvas"); wait_until(bear.card_open, 5)
            step = "close button"
            bear.click("#slant-close")
            closed = wait_until(lambda: not bear.card_open(), 5)
            step = "reopen 2"
            bear.click("canvas"); wait_until(bear.card_open, 5)
            step = "tap bear to hide"
            bear.click("canvas")
            toggled = wait_until(lambda: not bear.card_open() and bear.visible(".tip"), 5)
            record(name, scrolled and esc and closed and toggled, f"wheel scroll={scrolled}, escape={esc}, close={closed}, tap again={toggled}")
        except Exception as e:
            record(name, False, "at step " + step + ": " + repr(e)[:250]); traceback.print_exc()

        # ---------------- C4 ----------------
        name = "C4 toolbar shortcut Alt+Shift+S acts like a tap on the bear (opens and hides the card)"
        try:
            def press():
                w = subprocess.run(["xdotool", "search", "--onlyvisible", "--class", "chromium"], capture_output=True, text=True).stdout.split()
                subprocess.run(["xdotool", "windowactivate", "--sync", w[-1]], capture_output=True)
                subprocess.run(["xdotool", "key", "--clearmodifiers", "alt+shift+s"], capture_output=True)
            yt.bring_to_front(); time.sleep(0.3)
            if bear.card_open():
                bear.click("canvas"); wait_until(lambda: not bear.card_open(), 5)
            press(); a = wait_until(bear.card_open, 8)
            press(); b = wait_until(lambda: not bear.card_open(), 8)
            record(name, a and b)
        except Exception as e:
            record(name, False, repr(e)[:300])

        # ---------------- C5 ----------------
        name = "C5 analyzing (simulated, free): the bubble shows live steps and seconds in readable type; a simulated result hides the report link"
        try:
            ext_eval(f"chrome.storage.local.get(['reqs','bearCache']).then(o => {{ const r = o.reqs || {{}}, c = o.bearCache || {{}}; delete r[{json.dumps(A)}]; delete c[{json.dumps(A)}]; return chrome.storage.local.set({{reqs: r, bearCache: c}}); }})")
            ext_eval("chrome.storage.local.set({debug: {simulate: 'slow-success'}})")
            nav(A)
            wait_until(lambda: "Tap me to analyze" in (bear.tip() or ""), 10)
            bear.click("canvas")
            steps, secs = set(), set()
            def analyzing():
                t = bear.tip() or ""
                if "Analyzing" in t:
                    last = t.split("\n")[-1]
                    steps.add(last.split(" · ")[0])
                    if " · " in last and last.endswith(" s"): secs.add(last.split(" · ")[1])
                return "Analyzing" in t
            wait_until(analyzing, 10)
            sub_px = bear.call(".t2", "function(){ return parseFloat(getComputedStyle(this).fontSize); }")
            bear.shot("C5-analyzing")
            end = time.time() + 45
            while time.time() < end and not done_tip():
                analyzing(); time.sleep(0.3)
            r = req(A)
            bear.click("canvas"); wait_until(bear.card_open, 5)
            no_link = not bear.visible("#slant-report")
            one = bear.call(".card .acts", "function(){ return this.classList.contains('one'); }")
            note = bear.text(".card .note") or ""
            bear.shot("C5-simulated")
            record(name, r["job"]["simulated"] and no_link and one and "Simulated" in note and len(steps) >= 2 and len(secs) >= 2 and sub_px >= 18,
                   f"steps seen={sorted(steps)}, seconds seen={len(secs)}, step font={sub_px}px, simulated={r['job']['simulated']}, report link hidden={no_link}, single full-width Close={one}, note={note!r}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()
        finally:
            ext_eval("chrome.storage.local.remove('debug')")
            ext_eval(f"chrome.storage.local.get(['reqs','bearCache']).then(o => {{ const r = o.reqs || {{}}, c = o.bearCache || {{}}; delete r[{json.dumps(A)}]; delete c[{json.dumps(A)}]; return chrome.storage.local.set({{reqs: r, bearCache: c}}); }})")
            if bear.card_open(): bear.click("canvas")

        # ---------------- C6 ----------------
        name = "C6 errors: out of credits shows the reason with Close only; a rate limit offers Try again, which recovers (saved, free)"
        try:
            B, C = safe(pool[0]), safe(pool[1])
            seen = {}
            for sim, vid in (("fail-credits", B), ("fail-rate", C)):
                ext_eval(f"chrome.storage.local.set({{debug: {{simulate: '{sim}'}}}})")
                nav(vid)
                bear.click("canvas")
                wait_until(lambda: "Couldn" in (bear.tip() or ""), 30)
                bear.click("canvas"); wait_until(bear.card_open, 5)
                seen[sim] = {"title": bear.text(".card .big"), "retry": bear.visible("#slant-retry"), "close": bear.visible("#slant-close")}
                bear.shot("C6-" + sim)
            ext_eval("chrome.storage.local.remove('debug')")
            bear.click("#slant-retry")
            recovered = wait_until(done_tip, 40)
            rc = req(C)
            ok = seen["fail-credits"] == {"title": "Out of Mana credits", "retry": False, "close": True} and \
                 seen["fail-rate"]["title"] == "Slant is busy" and seen["fail-rate"]["retry"] and rc["job"].get("cached")
            record(name, ok, json.dumps(seen) + f"; after Try again: {recovered!r}, cached={rc['job'].get('cached')}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()
        finally:
            ext_eval("chrome.storage.local.remove('debug')")

        # ---------------- C7 ----------------
        name = "C7 Short: the bear and card work on /shorts/ with the same layout"
        try:
            S = safe(shorts[0])
            nav(S, short=True)
            bear.click("canvas")
            t = wait_until(done_tip, 40)
            bear.click("canvas"); wait_until(bear.card_open, 5)
            card, canvas = bear.rect(".card"), bear.rect("canvas")
            ok = abs((card["x"] + card["w"] / 2) - (canvas["x"] + canvas["w"] / 2)) <= 1 and bear.visible("#slant-report")
            bear.shot("C7-short")
            bear.click("canvas")
            record(name, ok, f"short={S}, label={t!r}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()

        # ---------------- C8 ----------------
        name = "C8 the service worker is stopped mid-job: the bear's nudge resumes the same job (no second submission)"
        try:
            D = safe(pool[2])
            ext_eval("chrome.storage.local.set({debug: {simulate: 'slow-success'}})")
            nav(D)
            t_start = int(time.time() * 1000)
            bear.click("canvas")
            wait_until(lambda: (req(D) or {}).get("jobId"), 15)
            ws = requests.get("http://127.0.0.1:9335/json/version", timeout=10).json()["webSocketDebuggerUrl"]
            c = wsconnect(ws, open_timeout=10)
            c.send(json.dumps({"id": 1, "method": "Target.getTargets"}))
            targets = json.loads(c.recv(timeout=10))["result"]["targetInfos"]
            swt = [t for t in targets if t["type"] == "service_worker" and ext_id in t["url"]]
            for i, t in enumerate(swt):
                c.send(json.dumps({"id": 10 + i, "method": "Target.closeTarget", "params": {"targetId": t["targetId"]}}))
                c.recv(timeout=10)
            c.close()
            killed = len(swt)
            done = wait_until(done_tip, 60)
            sims = [j for j in R.backend_jobs() if j["video_id"] == D and j["simulate"] == "slow-success" and j["created_at"] >= t_start - 2000]
            record(name, killed >= 1 and done and len(sims) == 1, f"workers stopped={killed}, label={done!r}, simulated jobs submitted={len(sims)}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()
        finally:
            ext_eval("chrome.storage.local.remove('debug')")

        # ---------------- C9 ----------------
        name = "C9 expired link: 'Reconnect Slant' opens the setup page in reconnect mode; pasting a reconnect link analyzes the waiting video (saved, free)"
        try:
            E2 = safe(pool[3])
            ext_eval("chrome.storage.local.get('conn').then(o => chrome.storage.local.set({conn: {...o.conn, linkExp: Date.now() - 1000}}))")
            nav(E2)
            t0 = wait_until(lambda: (lambda t: t if t and "Reconnect Slant" in t else None)(bear.tip()), 10)
            bear.click("canvas")      # the setup tab from C1 is still open, so Chrome brings it forward instead of opening another
            sp = ext
            sp.wait_for_selector("#setup[data-mode=expired]", timeout=15000)
            front = sp.evaluate("document.visibilityState")
            sp.screenshot(path=os.path.join(SHOTS, "setup-expired.png"))
            sp.fill("#link", day_link)
            sp.click("#connect")
            sp.wait_for_selector("#connected-now", timeout=30000)
            t = wait_until(done_tip, 40)
            record(name, bool(t0) and bool(t) and front == "visible", f"before={t0!r}, setup tab brought forward={front}, after={t!r}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()

        # ---------------- C10 ----------------
        name = "C10 short window (1100×620): the card stays on screen, its body scrolls and the Close / Full report buttons stay visible"
        try:
            yt.bring_to_front()
            yt.set_viewport_size({"width": 1100, "height": 620})
            time.sleep(0.5)
            if not bear.card_open():
                bear.click("canvas")
            wait_until(bear.card_open, 5)
            card = bear.rect(".card")
            scrolls = bear.call(".card .body", "function(){ return this.scrollHeight > this.clientHeight; }")
            ov = bear.call(".card", "function(){ return this.scrollWidth - this.clientWidth; }")
            bear.shot("C10-short-window")
            foot = bear.rect(".card .foot")
            ok = card["b"] <= 620 and scrolls and ov <= 0 and card["r"] <= 1100 and foot and foot["b"] <= 620
            record(name, ok, f"card bottom={card['b']:.0f}, right={card['r']:.0f}, scrolls={scrolls}, overflow={ov}")
        except Exception as e:
            record(name, False, repr(e)[:300]); traceback.print_exc()
    finally:
        for cid in [c for c in creds if c]:
            try: requests.post(f"{R.LOCAL}/v1/owner/credentials/{cid}/revoke", json={}, headers=R.ADMIN, timeout=20)
            except Exception: pass
        try: ctx.close(); pw.stop()
        except Exception: pass
        xvfb.terminate(); subprocess.run(["rm", "-rf", prof])
    passed = sum(r["pass"] for r in RESULTS)
    print(f"\n{passed}/{len(RESULTS)} passed")
    json.dump(RESULTS, open(os.path.join(R.ROOT, "tests", "browser", "card_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
