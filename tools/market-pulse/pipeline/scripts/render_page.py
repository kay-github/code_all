"""Render the daily market-pulse HTML from analysis.json + template.html."""
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))


def main(date: str | None = None):
    if date is None:
        date = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MP_DATE") or datetime.now().strftime("%Y-%m-%d")
    data_path = ROOT / "data" / date / "analysis.json"
    if not data_path.exists():
        raise SystemExit(f"missing {data_path}")
    data = json.loads(data_path.read_text(encoding="utf-8"))
    data["rendered_at"] = datetime.now().isoformat(timespec="seconds")
    template = (ROOT / "template.html").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if "</script" in payload.lower():
        raise SystemExit("data contains </script>, cannot inline safely")

    online = os.environ.get("MP_ONLINE") == "1"
    if online:
        echarts_tag = '<script src="vendor/echarts.min.js"></script>'
    else:
        echarts = (ROOT / "vendor" / "echarts.min.js").read_text(encoding="utf-8")
        if "</script" in echarts.lower():
            raise SystemExit("echarts contains </script>, cannot inline safely")
        echarts_tag = f"<script>{echarts}</script>"

    html = template.replace("__ECHARTS_TAG__", echarts_tag).replace("__DATA_JSON__", payload)
    if "__ECHARTS_TAG__" in html or "__DATA_JSON__" in html:
        raise SystemExit("placeholder left unreplaced")

    out = ROOT / f"盘面说明_{date}.html"
    out.write_text(html, encoding="utf-8")
    print(f"written {out} {out.stat().st_size} bytes")

    out_dir = os.environ.get("MP_OUT_DIR")
    if out_dir:
        target = Path(out_dir)
        target.mkdir(parents=True, exist_ok=True)
        (target / "index.html").write_text(html, encoding="utf-8")
        data_dir = target / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / "latest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        archive = data_dir / "archive"
        archive.mkdir(parents=True, exist_ok=True)
        (archive / f"{date}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        vendor = ROOT / "vendor" / "echarts.min.js"
        if online and vendor.exists():
            (target / "vendor").mkdir(parents=True, exist_ok=True)
            shutil.copy2(vendor, target / "vendor" / "echarts.min.js")
        print(f"online {target / 'index.html'} {html.__len__()} chars; data latest + archive {date}")


if __name__ == "__main__":
    main()
