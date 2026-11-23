# -*- coding: utf-8 -*-
"""One-command daily market-pulse pipeline.

Usage:
    python scripts/run_daily.py 2026-11-23

Run after the A-share close (16:10+ is safest: THS snapshot stabilises, LHB is still
before its 17:00 disclosure, margin is T+1 so it will use the latest disclosed day).
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
DATE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MP_DATE") or datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
START = (datetime.strptime(DATE, "%Y-%m-%d") - timedelta(days=18)).strftime("%Y%m%d")
STATUS_PATH = ROOT / "run_status.json"
STATUS = {"date": DATE, "started_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
          "current": None, "steps": []}


def save_status():
    STATUS_PATH.write_text(json.dumps(STATUS, ensure_ascii=False, indent=2), encoding="utf-8")


save_status()

env = os.environ.copy()
env["MP_DATE"] = DATE
env["MP_START"] = START
env["MP_ROOT"] = str(ROOT)
env["PYTHONIOENCODING"] = "utf-8"

STEPS = [
    ("0/8 东财沪市主力资金快照（可选，失败不阻断）", "fetch_em_flow.py", False),
    ("1/8 基础行情 / 行业 / 概念 / 涨停 / 两融", "fetch_daily.py", True),
    ("2/8 同花顺个股资金流（收盘后重抓，避免分页漂移）", "refetch_ths_stock.py", False),
    ("3/8 新浪全 A 超大单", "fetch_sina_flow.py", True),
    ("4/8 同花顺 5 日 / 10 日排行", "fetch_multiday_flow.py", True),
    ("5/8 深交所两融明细序列", "fetch_margin_series.py", False),
    ("6/8 龙虎榜机构席位（未披露则沿用最近披露日）", "fetch_margin_lhb.py", False),
    ("7/8 结构化数据 + 页面", "build_analysis.py", True),
    ("8/8 渲染单文件 / 线上页面", "render_page.py", True),
]

for label, script, critical in STEPS:
    path = ROOT / "scripts" / script
    print(f"\n=== {label} ===")
    STATUS["current"] = label
    save_status()
    r = subprocess.run(
        [sys.executable, "-X", "utf8", str(path), DATE],
        cwd=str(ROOT), env=env, capture_output=True, text=True, encoding="utf-8",
    )
    out = (r.stdout or "") + (r.stderr or "")
    print(out.strip()[-1600:])
    STATUS["steps"].append({"label": label, "script": script, "critical": critical,
                            "returncode": r.returncode, "ok": r.returncode == 0,
                            "tail": out.strip()[-2500:]})
    save_status()
    if r.returncode != 0:
        print(f"[FAIL] {script} exit={r.returncode}")
        if critical:
            STATUS["current"] = f"FAILED: {script}"
            STATUS["finished_at"] = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
            save_status()
            raise SystemExit(f"critical step failed: {script}")

STATUS["current"] = None
STATUS["finished_at"] = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
STATUS["ok"] = True
save_status()
print(f"\nDONE. Open: {ROOT / f'盘面说明_{DATE}.html'}")
