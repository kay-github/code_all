# -*- coding: utf-8 -*-
"""Tier-change notification. Sends via the Vercel notify endpoint (PushPlus token stays in Vercel)."""
import argparse
import json
import os
from datetime import date, datetime

import requests

from config import DATA, NOTIFY_URL, REGISTRY, SITE, TIER_NAME


def card(sector, latest, tier):
    color, bg = {
        0: ("#2F6B4F", "#EAF4EE"),
        1: ("#2F6B4F", "#EAF4EE"),
        2: ("#C77A2E", "#FFF6E6"),
        3: ("#B3392C", "#FDECEC"),
        4: ("#7A1F1A", "#F3E4E2"),
    }[tier]
    ret250 = latest.get("ret250")
    ret250_s = f"{ret250*100:+.1f}%" if ret250 is not None else "—"
    dd250 = latest.get("dd250")
    dd250_s = f"{dd250*100:+.1f}%" if dd250 is not None else "—"
    crowd = latest.get("crowd_label") or "拥挤度"
    crowd_v = latest.get("crowd_value")
    if latest.get("amt_share") is not None:
        crowd_s = f"{crowd_v*100:.1f}%"
    else:
        crowd_s = f"{crowd_v:.2f}x" if crowd_v is not None else "—"
    return f"""<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;color:#1C1A17;">
  <div style="background:{bg};border:1px solid {color}33;border-left:4px solid {color};padding:16px;">
    <div style="font-size:12px;color:{color};font-weight:700;letter-spacing:.04em;">{sector} · {TIER_NAME[tier]}</div>
    <div style="font-size:21px;font-weight:700;margin:8px 0 4px;">{latest['date']}　指数 {latest['idx']:.3f}　R {latest['R']}</div>
    <div style="font-size:14px;line-height:1.6;color:#3A362C;">{latest['action']}</div>
    <div style="font-size:12px;color:#6D675B;margin-top:10px;line-height:1.8;">
      位置：ret250 {ret250_s} · 距 250 日高 {dd250_s}<br>
      情绪：RSI {latest['rsi14']} · 涨停 {latest['limit_up']} 家 · {crowd} {crowd_s}<br>
      确认：20 日内破位 {latest['break20_20d']} 天 · 反抽失败 {latest['rebreak20_20d']} 次 · E {latest['E']} / C {latest['C']}
    </div>
    <a href="{SITE}" style="display:inline-block;margin-top:12px;color:{color};font-weight:700;text-decoration:none;">打开逃顶雷达 →</a>
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

        title = f"{s['name']} · {TIER_NAME[new_tier]} · {s['as_of']}"
        if decision == "orange_weekly":
            title = f"{s['name']} · 橙色预警（仍在） · {s['as_of']}"
        elif decision == "orange_entry":
            title = f"{s['name']} · 橙色预警（进入） · {s['as_of']}"
        elif decision == "release":
            title = f"{s['name']} · 风险解除 · {s['as_of']}"
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
