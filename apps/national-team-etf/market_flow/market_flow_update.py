#!/usr/bin/env python3
"""Run the SkillHub china-etf-flow-premarket report and store it as auxiliary data.

This is deliberately outside the authoritative 15-ETF release gate.  It only
produces the all-market non-money ETF background used by the GJD page.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
SKILL_SCRIPT = HERE / "etf_flow_premarket.py"
DEFAULT_OUT = HERE.parent / "data" / "market_flow"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trade-date", help="Completed trading day YYYYMMDD; defaults to skill resolver")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Auxiliary data directory")
    parser.add_argument("--top", type=int, default=10, help="Rows in each ranking")
    return parser.parse_args()


def run_skill(trade_date: str | None, tmp: Path, top: int) -> dict[str, Any]:
    cmd = [
        sys.executable,
        "-X",
        "utf8",
        str(SKILL_SCRIPT),
        "--output-dir",
        str(tmp),
        "--top",
        str(top),
    ]
    if trade_date:
        cmd.extend(["--trade-date", trade_date])
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(cmd, text=True, capture_output=True, env=env)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"skill script failed ({proc.returncode}): {detail[-2000:]}")
    files = sorted(tmp.glob("etf_flow_*.json"))
    if not files:
        raise RuntimeError("skill script produced no etf_flow_*.json")
    report = json.loads(files[-1].read_text(encoding="utf-8"))
    return report


def write_history(path: Path, report: dict[str, Any]) -> None:
    summary = report.get("summary") or {}
    quality = report.get("quality") or {}
    row = {
        "trade_date": report.get("trade_date"),
        "previous_trade_date": report.get("previous_trade_date"),
        "net_flow_yi": summary.get("net_flow_yi"),
        "stock_net_flow_yi": summary.get("stock_net_flow_yi"),
        "gross_subscription_yi": summary.get("gross_subscription_yi"),
        "gross_redemption_yi": summary.get("gross_redemption_yi"),
        "included_etfs": quality.get("included_etfs"),
        "excluded_money_etfs": quality.get("excluded_money_etfs"),
        "exchange_unmatched_etfs": quality.get("exchange_unmatched_etfs"),
        "unvalued_changed_etfs": quality.get("unvalued_changed_etfs"),
        "akshare_version": report.get("akshare_version"),
        "generated_at": report.get("generated_at"),
    }
    old: list[dict[str, Any]] = []
    if path.exists():
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            old = list(csv.DictReader(f))
    old = [x for x in old if x.get("trade_date") != row["trade_date"]]
    old.append({k: "" if v is None else v for k, v in row.items()})
    old.sort(key=lambda x: str(x.get("trade_date") or ""))
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(row))
        writer.writeheader()
        writer.writerows(old)


def main() -> int:
    args = parse_args()
    out = Path(args.out).resolve()
    reports = out / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="etf_flow_") as raw_tmp:
        tmp = Path(raw_tmp)
        report = run_skill(args.trade_date, tmp, args.top)
        trade_date = str(report.get("trade_date") or "")
        if not trade_date:
            raise RuntimeError("skill report has no trade_date")
        quality = report.get("quality") or {}
        if int(quality.get("included_etfs") or 0) <= 0:
            raise RuntimeError("skill report included no ETFs")
        if int(quality.get("unvalued_changed_etfs") or 0) > 0:
            raise RuntimeError(
                "skill report has changed ETFs without valuation; refusing to overwrite latest"
            )
        report["status"] = "ok"
        report["integration"] = {
            "role": "all-market-background",
            "authority": "not authoritative; core15 official shares and 10-point inventory remain the release gate",
            "identity": "I0; no buyer/seller identity",
            "valuation": "share change x AkShare NAV, fallback market price",
        }
        stem = f"etf_flow_{trade_date}"
        for suffix in (".json", ".csv", ".md"):
            source = tmp / f"{stem}{suffix}"
            if source.exists():
                shutil.copyfile(source, reports / f"{stem}{suffix}")
        latest = out / "latest.json"
        latest.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        latest_md = out / "latest.md"
        if (reports / f"{stem}.md").exists():
            shutil.copyfile(reports / f"{stem}.md", latest_md)
        write_history(out / "history.csv", report)
    summary = report.get("summary") or {}
    quality = report.get("quality") or {}
    print(
        json.dumps(
            {
                "trade_date": report.get("trade_date"),
                "net_flow_yi": summary.get("net_flow_yi"),
                "stock_net_flow_yi": summary.get("stock_net_flow_yi"),
                "included_etfs": quality.get("included_etfs"),
                "unvalued_changed_etfs": quality.get("unvalued_changed_etfs"),
                "out": str(out),
                "latest": str(out / "latest.json"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
