"""Render the daily market-pulse HTML from analysis.json + template.html."""
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))


def main(date: str | None = None):
    if date is None:
        date = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MP_DATE") or datetime.now().strftime("%Y-%m-%d")
    session = os.environ.get("MP_SESSION", "pm").lower()
    if session not in ("am", "pm"):
        session = "pm"
    data_path = ROOT / "data" / date / "analysis.json"
    if not data_path.exists():
        raise SystemExit(f"missing {data_path}")
    data = json.loads(data_path.read_text(encoding="utf-8"))
    data["rendered_at"] = datetime.now().isoformat(timespec="seconds")
    template = (ROOT / "template.html").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if "</script" in payload.lower():
        raise SystemExit("data contains </script>, cannot inline safely")

    app_match = re.search(
        r"<!-- APP_SCRIPT_START -->\s*<script>\s*(.*?)\s*</script>\s*<!-- APP_SCRIPT_END -->",
        template,
        re.S,
    )
    if not app_match:
        raise SystemExit("APP_SCRIPT markers missing from template")
    app_js = app_match.group(1)

    online = os.environ.get("MP_ONLINE") == "1"
    if online:
        # Load ECharts asynchronously from a small same-origin boot script. Do
        # not put a blocking 1MB <script src> here: self-hosted ECharts can
        # stall inside the root-site iframe, and a blocking CDN tag makes the
        # whole report wait on a third-party request.
        echarts_tag = '<script src="/tools/market-pulse/echarts-boot.js"></script>'
        data_script = (
            '<script src="/tools/market-pulse/data/latest.js"></script>'
            '<script src="/tools/market-pulse/data/am/latest.js"></script>'
        )
        app_script = '<script src="/tools/market-pulse/app.js"></script>'
    else:
        echarts = (ROOT / "vendor" / "echarts.min.js").read_text(encoding="utf-8")
        if "</script" in echarts.lower():
            raise SystemExit("echarts contains </script>, cannot inline safely")
        echarts_tag = f"<script>{echarts}</script>"
        if session == "am":
            data_script = f"<script>window.DATA_AM = {payload};</script>"
        else:
            data_script = f"<script>window.DATA = {payload};</script>"
        app_script = f"<script>{app_js}</script>"

    html = template.replace("__ECHARTS_TAG__", echarts_tag)
    html = re.sub(r"<!-- DATA_SCRIPT_START -->.*?<!-- DATA_SCRIPT_END -->", lambda _: data_script, html, flags=re.S)
    html = re.sub(r"<!-- APP_SCRIPT_START -->.*?<!-- APP_SCRIPT_END -->", lambda _: app_script, html, flags=re.S)
    html = html.replace("__DATA_JSON__", payload)
    if "__ECHARTS_TAG__" in html or "__DATA_JSON__" in html:
        raise SystemExit("placeholder left unreplaced")

    # Online builds are deployed from MP_OUT_DIR; never overwrite the local standalone
    # single-file page with the external-ECharts variant.
    if not online:
        suffix = "_午盘" if session == "am" else ""
        out = ROOT / f"盘面说明_{date}{suffix}.html"
        out.write_text(html, encoding="utf-8")
        print(f"written {out} {out.stat().st_size} bytes")

    out_dir = os.environ.get("MP_OUT_DIR")
    if out_dir:
        target = Path(out_dir)
        target.mkdir(parents=True, exist_ok=True)
        if session == "am":
            data_dir = target / "data" / "am"
        else:
            data_dir = target / "data"
            # The page itself is only rebuilt by the closing (pm) run. The am
            # run must not overwrite it with a snapshot-only view.
            (target / "index.html").write_text(html, encoding="utf-8")
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / "latest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        archive = data_dir / "archive"
        archive.mkdir(parents=True, exist_ok=True)
        (archive / f"{date}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        if online:
            key = "DATA_AM" if session == "am" else "DATA"
            (data_dir / "latest.js").write_text(f"window.{key} = {payload};\n", encoding="utf-8")
            (target / "app.js").write_text(app_js, encoding="utf-8")
            (target / "echarts-boot.js").write_text(
                """(function(){
  var sources = [
    'https://fastly.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js',
    '/tools/market-pulse/vendor/echarts.min.js'
  ];
  var i = 0;
  function ready(){
    if (window.__pulseOnReady) { window.__pulseOnReady(); return; }
    setTimeout(ready, 100);
  }
  function next(){
    if (window.echarts && !window.echarts.__shim) { ready(); return; }
    if (i >= sources.length) return;
    var src = sources[i++], done = false;
    var s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = function(){ if (!done) { done = true; setTimeout(next, 0); } };
    s.onerror = function(){ if (!done) { done = true; setTimeout(next, 0); } };
    document.head.appendChild(s);
    setTimeout(function(){ if (!done) { done = true; setTimeout(next, 0); } }, 10000);
  }
  next();
})();
""",
                encoding="utf-8",
            )
        vendor = ROOT / "vendor" / "echarts.min.js"
        if online and vendor.exists():
            (target / "vendor").mkdir(parents=True, exist_ok=True)
            shutil.copy2(vendor, target / "vendor" / "echarts.min.js")
        print(f"online {session} data {data_dir} ({date}); page rewritten={session == 'pm'}")


if __name__ == "__main__":
    main()
