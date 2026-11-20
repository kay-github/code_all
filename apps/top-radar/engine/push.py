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


def escape_color(state):
    return {
        "watch": "#C77A2E",
        "warn": "#B3392C",
        "confirm": "#7A1F1A",
        "trend": "#3E6B52",
        "failed": "#6D675B",
        "waiting": "#8A7A55",
        "idle": "#6D675B",
    }.get(state, "#6D675B")


def escape_card(entry, ref=None):
    state = entry.get("state") or "waiting"
    color = escape_color(state)
    name = escape(str(entry.get("name") or entry.get("id") or "—"))
    state_name = escape(str(entry.get("state_name") or state))
    action = escape(str(entry.get("action") or "—"))
    trigger = escape(str(entry.get("trigger") or "—"))
    idx = entry.get("index")
    idx_s = f"{idx:.3f}" if isinstance(idx, (int, float)) else "—"
    def pct(x):
        return f"{x*100:.1f}%" if isinstance(x, (int, float)) else "—"
    ref_line = ""
    if ref:
        ref_line = (f'<div style="margin-top:8px;font-size:11px;color:#8A8172;">'
                    f'创业板参照：{escape(str(ref.get("state_name") or "—"))} · '
                    f'深跌 {pct(ref.get("crash_dd"))} · 反弹 {pct(ref.get("rebound_gain"))}</div>')
    return f"""<div style="margin:0;padding:0;background:#EFE8DB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1A17;">
  <div style="max-width:560px;margin:0 auto;background:#F7F2E8;border:1px solid #DED3C1;">
    <div style="background:#171411;color:#F7F1E6;padding:16px 20px 14px;">
      <div style="font-size:10px;letter-spacing:.18em;color:#A79D8C;">ESCAPE TOP · 阶段反弹逃命顶</div>
      <div style="margin-top:7px;font-size:21px;line-height:1.3;font-weight:700;">{name}</div>
      <div style="margin-top:9px;">
        <span style="display:inline-block;background:{color};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;">{state_name}</span>
        <span style="font-size:12px;color:#A79D8C;margin-left:8px;">{entry.get('as_of', '—')}</span>
      </div>
      <div style="margin-top:14px;font-size:34px;font-weight:700;letter-spacing:-1px;line-height:1;">{idx_s}<span style="font-size:12px;font-weight:400;color:#A79D8C;"> · 指数</span></div>
      <div style="font-size:12px;color:#A79D8C;margin-top:5px;">深跌 {pct(entry.get('crash_dd'))} · 反弹 {pct(entry.get('rebound_gain'))} · 修复 {pct(entry.get('retracement'))}</div>
    </div>
    <div style="padding:16px 20px 14px;background:#FFFDF7;">
      <div style="font-size:10px;letter-spacing:.14em;color:#8E8474;">现在该做什么</div>
      <div style="margin-top:7px;font-size:17px;font-weight:700;line-height:1.55;color:{color};">{action}</div>
      <div style="margin-top:14px;padding:10px 12px;background:#F4EDE0;border-left:3px solid {color};font-size:12px;line-height:1.7;color:#4A4238;">
        <b>触发</b>　{trigger}<br>
        <b>自反弹高点</b>　{pct(entry.get('high_drawdown'))}
      </div>
      {ref_line}
      <a href="{SITE}" style="display:inline-block;margin-top:12px;color:{color};font-weight:700;text-decoration:none;font-size:13px;">打开逃顶雷达 →</a>
    </div>
    <div style="padding:10px 20px 13px;background:#EFE8DB;color:#8A8172;font-size:10px;line-height:1.6;">
      只跟踪“大跌后的阶段反弹顶”，不是下一轮牛市顶部；预警是分批减仓，不是一次清仓。不构成买卖建议。
    </div>
  </div>
</div>"""


def push_escape(dry_run=False):
    """Push only on escape-state transitions. Independent of legacy tiers."""
    path = DATA / "escape_shadow.json"
    if not path.exists():
        print("[escape push] no escape_shadow.json; skip")
        return False
    try:
        shadow = json.load(open(path, encoding="utf-8"))
    except Exception as exc:
        print(f"[escape push] read failed: {exc}")
        return False
    state_path = DATA / "escape_push_state.json"
    state = json.load(open(state_path, encoding="utf-8")) if state_path.exists() else {}
    ref = shadow.get("reference")
    changed = False
    for s in shadow.get("sectors", []):
        sid = s.get("id")
        if not sid:
            continue
        st = state.setdefault(sid, {})
        key = f"{sid}|{s.get('as_of')}|{s.get('state')}"
        if st.get("last_event_key") == key:
            continue
        old_state = st.get("last_state")
        new_state = s.get("state")
        trigger = str(s.get("trigger") or "")
        is_cancel = (new_state == "watch" and "撤销" in trigger)
        should = False
        if old_state is None:
            should = new_state in ("watch", "warn", "confirm")
        else:
            should = (new_state in ("watch", "warn", "confirm", "trend", "failed")
                      and new_state != old_state) or is_cancel
        if not should:
            st["last_state"] = new_state
            st["last_event_key"] = key
            changed = True
            continue
        title_map = {
            "watch": "进入观察" if not is_cancel else "预警撤销",
            "warn": "逃命预警",
            "confirm": "逃命确认",
            "trend": "结束跟踪（趋势反转）",
            "failed": "结束跟踪（反弹失败）",
        }
        label = title_map.get(new_state, new_state)
        title = f"逃命顶 · {s.get('name') or sid} · {label} · {s.get('as_of') or ''}"
        ok = send(title, escape_card(s, ref), sid, 0, dry_run=dry_run)
        if ok:
            st["last_state"] = new_state
            st["last_event_key"] = key
            st["last_push_at"] = date.today().isoformat()
            changed = True
    if changed and not dry_run:
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        print("[escape push] state saved")
    return changed


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

    push_escape(args.dry_run)


if __name__ == "__main__":
    main()
