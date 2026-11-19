# -*- coding: utf-8 -*-
"""Top Radar portable config. Pure relative paths: works on GitHub Actions."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # apps/top-radar
DATA = ROOT / "data"
POOLS = ROOT / "pools"
BARS = DATA / "bars"
SECTORS = DATA / "sectors"
REGISTRY = ROOT / "registry.json"
MARKET_AMOUNT = DATA / "market_amount.csv"

SITE = os.environ.get("TOP_RADAR_SITE", "https://1.688680.xyz/taoding")
CONFIG_API = os.environ.get("TOP_RADAR_CONFIG_API", "https://1.688680.xyz/api/top-radar")
NOTIFY_URL = os.environ.get("TOP_RADAR_NOTIFY_URL", "https://1.688680.xyz/api/top-radar?action=notify")

TENCENT_KLINE = "https://ifzq.gtimg.cn/appstock/app/fqkline/get"
TENCENT_QUOTE = "https://qt.gtimg.cn/q="
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}

PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or ""
PROXIES = {"http": PROXY, "https": PROXY} if PROXY else None

BENCH_SYMBOL = "sz399006"

TIER_NAME = {0: "正常", 1: "观察", 2: "橙色预警", 3: "红色高危", 4: "深红清仓"}
TIER_ACTION = {
    0: "正常持有",
    1: "正常持有，停止加仓",
    2: "停止加仓；止损上移至最近 10 日低点",
    3: "减仓 1/3（保守可减 1/2）；剩余止损设 MA20 下方 2%",
    4: "再减 1/3 或清仓；不接飞刀，等重新站上 MA20 且广度恢复",
}
