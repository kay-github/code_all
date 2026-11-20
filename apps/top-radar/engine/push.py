# -*- coding: utf-8 -*-
"""Tier-change notification. Sends via the Vercel notify endpoint (PushPlus token stays in Vercel)."""
import argparse
import json
import os
from datetime import date, datetime
from html import escape

import requests

from config import DATA, NOTIFY_URL, REGISTRY, SITE, TIER_NAME


def card(sector, latest, tier):
    color, bg = {
        0: ("#2F6B4F", "#EAF4EE"),
        1: ("#2F6B4F", "#EAF4EE"),
        2: ("#B26A11", "#FFF3DF"),
        3: ("#B3392C", "#FDECEC"),
        4: ("#7A1F1A", "#F3E4E2"),
    }[tier]
    sector_s = escape(str(sector))
    action_s = escape(str(latest.get("action") or "—"))
    idx = latest.get("idx")
    idx_s = f"{idx:.3f}" if isinstance(idx, (int, float)) else "—"
    reason = {
        4: "红色条件延续 · 跌破一年高 8% · 技术确认",
        3: "R≥75 · 情绪过热 · 仍在一年高附近 · 技术确认",
        2: "R≥70 · 情绪过热 · 仍在一年高附近",
    }.get(tier, "风险指标回到正常区")
    return f"""<div style="margin:0;padding:0;background:#EFE8DB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1A17;">
  <div style="max-width:560px;margin:0 auto;background:#F7F2E8;border:1px solid #DED3C1;">
    <div style="background:#171411;color:#F7F1E6;padding:16px 20px 14px;">
      <div style="font-size:10px;letter-spacing:.18em;color:#A79D8C;">TOP RADAR · 实时信号</div>
      <div style="margin-top:7px;font-size:21px;line-height:1.3;font-weight:700;">{sector_s}</div>
      <div style="margin-top:9px;">
        <span style="display:inline-block;background:{color};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;">{TIER_NAME[tier]}</span>
        <span style="font-size:12px;color:#A79D8C;margin-left:8px;">{latest.get('date', '—')}</span>
      </div>
      <div style="margin-top:14px;font-size:36px;font-weight:700;letter-spacing:-1px;line-height:1;">R {latest.get('R', '—')}<span style="font-size:12px;font-weight:400;color:#A79D8C;"> / 100</span></div>
      <div style="font-size:12px;color:#A79D8C;margin-top:5px;">指数 {idx_s} · 越高越像顶</div>
    </div>
    <div style="padding:16px 20px 14px;background:#FFFDF7;">
      <div style="font-size:10px;letter-spacing:.14em;color:#8E8474;">现在该做什么</div>
      <div style="margin-top:7px;font-size:17px;font-weight:700;line-height:1.55;color:{color};">{action_s}</div>
      <div style="margin-top:14px;padding:10px 12px;background:{bg};border-left:3px solid {color};font-size:12px;line-height:1.7;color:#4A4238;">
        <b>触发</b>　{reason}
      </div>
      <a href="{SITE}" style="display:inline-block;margin-top:12px;color:{color};font-weight:700;text-decoration:none;font-size:13px;">打开实时雷达 →</a>
    </div>
    <div style="padding:10px 20px 13px;background:#EFE8DB;color:#8A8172;font-size:10px;line-height:1.6;">
      只做顶部风险提示，不构成买卖建议；减仓比例按个人风险承受调整。
    </div>
  </div>
</div>"""


def send(title, content, sector, tier, dry_run=False):
    if dry_run:
        print(f"[dry-run] would push: {title}")
        return True
    secret = os.environ.get("MONITOR_SECRET", "")
    if not secret:
        print("[push] skip: MONITOR_SECRET not set")
        return False
    try:
        r = requests.post(
            NOTIFY_URL,
            headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
            json={"title": title, "content": content, "sector": sector, "tier": tier},
            timeout=20,
        )
        print(f"[push] {r.status_code} {r.text[:200]}")
        return r.ok
    except Exception as exc:
        print(f"[push] failed: {exc}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    new = json.load(open(DATA / "summary.json", encoding="utf-8"))
    prev_path = DATA / "_prev_summary.json"
    if not prev_path.exists():
        print("[push] no previous summary; first run, no push")
        return
    prev = json.load(open(prev_path, encoding="utf-8"))
    old_by_id = {s["id"]: s for s in prev.get("sectors", [])}

    try:
        registry = json.load(open(REGISTRY, encoding="utf-8"))
    except Exception:
        registry = {"sectors": []}
    push_cfg = {}
    if isinstance(registry.get("push"), dict):
        global_cfg = registry["push"]
        push_cfg = {s["id"]: {**global_cfg, **(s.get("push") or {})} for s in registry.get("sectors", [])}

    state_path = DATA / "push_state.json"
    state = json.load(open(state_path, encoding="utf-8")) if state_path.exists() else {}
    today = date.today()

    changed = False
    for s in new.get("sectors", []):
        if not s.get("enabled") or s.get("status") != "ok":
            continue
        if s.get("stale"):
            print(f"[push] skip stale sector {s['id']} ({s.get('as_of')})")
            continue
        cfg = push_cfg.get(s["id"], {})
        if not cfg.get("enabled", True):
            continue
        old = old_by_id.get(s["id"])
        old_tier = old.get("tier") if old and old.get("status") == "ok" else None
        new_tier = s.get("tier")
        if old_tier is None or new_tier is None:
            state.setdefault(s["id"], {})["last_tier"] = new_tier
            changed = True
            continue

        st = state.setdefault(s["id"], {})
        last_orange = st.get("last_orange_at")
        orange_gap = None
        if last_orange:
            try:
                orange_gap = (today - date.fromisoformat(last_orange)).days
            except Exception:
                orange_gap = None

        decision = None
        if new_tier >= 3 and old_tier < 3:
            decision = "red"
        elif new_tier == 4 and old_tier == 3:
            decision = "deep"
        elif new_tier == 2 and old_tier < 2:
            decision = "orange_entry"
        elif new_tier == 2 and old_tier == 2:
            if orange_gap is None or orange_gap >= 7:
                decision = "orange_weekly"
        elif new_tier <= 1 and old_tier >= 2:
            decision = "release"

        if not decision:
            st["last_tier"] = new_tier
            changed = True
            continue

        latest = {
            "date": s["as_of"], "idx": s["idx"], "R": s["R"], "action": s["action"],
            "ret250": None, "dd250": s.get("dd250"), "rsi14": None, "limit_up": None,
            "break20_20d": None, "rebreak20_20d": None, "E": None, "C": None,
            "crowd_label": None, "crowd_value": None, "amt_share": None,
        }
        # summary only carries a subset; use the sector JSON for the card.
        try:
            detail = json.load(open(DATA / "sectors" / f"{s['id']}.json", encoding="utf-8"))["latest"]
            latest.update(detail)
        except Exception:
            pass

        title = f"逃顶雷达 · {s['name']} · {TIER_NAME[new_tier]} · {s['as_of']}"
        if decision == "orange_weekly":
            title = f"逃顶雷达 · {s['name']} · 橙色预警（仍在） · {s['as_of']}"
        elif decision == "orange_entry":
            title = f"逃顶雷达 · {s['name']} · 橙色预警（进入） · {s['as_of']}"
        elif decision == "release":
            title = f"逃顶雷达 · {s['name']} · 风险解除 · {s['as_of']}"
        content = card(s["name"], latest, new_tier)
        ok = send(title, content, s["id"], new_tier, dry_run=args.dry_run)
        if ok:
            st["last_tier"] = new_tier
            st["last_push_at"] = today.isoformat()
            if new_tier == 2:
                st["last_orange_at"] = today.isoformat()
            changed = True

    if changed and not args.dry_run:
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        print("[push] state saved", state)


if __name__ == "__main__":
    main()
