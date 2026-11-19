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

    def pct(value):
        return f"{value * 100:+.1f}%" if value is not None else "—"

    ret250_s = pct(latest.get("ret250"))
    dd250_s = pct(latest.get("dd250"))
    rsi_s = latest.get("rsi14") if latest.get("rsi14") is not None else "—"
    limit_s = latest.get("limit_up") if latest.get("limit_up") is not None else "—"
    break_s = latest.get("break20_20d") if latest.get("break20_20d") is not None else "—"
    rebreak_s = latest.get("rebreak20_20d") if latest.get("rebreak20_20d") is not None else "—"
    c_s = latest.get("C") if latest.get("C") is not None else "—"
    e_s = latest.get("E") if latest.get("E") is not None else "—"
    crowd = latest.get("crowd_label") or "拥挤度"
    crowd_v = latest.get("crowd_value")
    if latest.get("amt_share") is not None and crowd_v is not None:
        crowd_s = f"{crowd_v * 100:.1f}%"
    else:
        crowd_s = f"{crowd_v:.2f}x" if crowd_v is not None else "—"

    hot_s = "情绪过热" if latest.get("hot") else "情绪未过热"
    near_s = "仍在一年高附近" if latest.get("near") else "已离开一年高"
    if tier == 4:
        next_text = "不接飞刀。等重新站上 MA20、市场广度恢复后再评估；不要用补仓摊低成本。"
    elif tier == 3:
        next_text = "若继续破位并进入深红（跌破一年高 8% 且 C≥1），再减 1/3；否则等重新站上 MA20 且广度恢复。"
    elif tier == 2:
        next_text = "停止加仓；把止损上移到最近 10 日低点，等 R 和情绪回落再看。"
    else:
        next_text = "正常持有，按原有纪律执行；本档位只做观察，不触发减仓。"

    return f"""<div style="margin:0;padding:0;background:#EFE8DB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1A17;">
  <div style="max-width:560px;margin:0 auto;background:#F7F2E8;border:1px solid #DED3C1;">
    <div style="background:#171411;color:#F7F1E6;padding:18px 20px 16px;">
      <div style="font-size:10px;letter-spacing:.18em;color:#A79D8C;">TOP RADAR · 实时信号</div>
      <div style="margin-top:8px;font-size:22px;line-height:1.3;font-weight:700;">{sector_s}</div>
      <div style="margin-top:10px;">
        <span style="display:inline-block;background:{color};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;">{TIER_NAME[tier]}</span>
        <span style="font-size:12px;color:#A79D8C;margin-left:8px;">{latest.get('date', '—')}</span>
      </div>
      <div style="margin-top:16px;font-size:38px;font-weight:700;letter-spacing:-1px;line-height:1;">R {latest.get('R', '—')}<span style="font-size:13px;font-weight:400;color:#A79D8C;"> / 100</span></div>
      <div style="font-size:12px;color:#A79D8C;margin-top:6px;">指数 {latest.get('idx', '—')} · 越高越像顶</div>
    </div>
    <div style="padding:18px 20px 16px;background:#FFFDF7;">
      <div style="font-size:10px;letter-spacing:.14em;color:#8E8474;">现在该做什么</div>
      <div style="margin-top:8px;font-size:17px;font-weight:700;line-height:1.55;color:{color};">{action_s}</div>
      <div style="border-top:1px solid #E8DFCF;margin:16px 0 14px;"></div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px;color:#5E584C;">
        <tr>
          <td style="width:50%;padding:0 0 12px 0;vertical-align:top;"><span style="color:#9A907F;font-size:10px;">一年涨幅</span><br><b style="font-size:16px;color:#1C1A17;">{ret250_s}</b></td>
          <td style="width:50%;padding:0 0 12px 0;vertical-align:top;"><span style="color:#9A907F;font-size:10px;">距一年高</span><br><b style="font-size:16px;color:#1C1A17;">{dd250_s}</b></td>
        </tr>
        <tr>
          <td style="padding:0 0 12px 0;vertical-align:top;"><span style="color:#9A907F;font-size:10px;">RSI(14)</span><br><b style="font-size:15px;color:#1C1A17;">{rsi_s}</b></td>
          <td style="padding:0 0 12px 0;vertical-align:top;"><span style="color:#9A907F;font-size:10px;">涨停家数</span><br><b style="font-size:15px;color:#1C1A17;">{limit_s}</b></td>
        </tr>
        <tr>
          <td style="padding:0;vertical-align:top;"><span style="color:#9A907F;font-size:10px;">20 日内破位</span><br><b style="font-size:15px;color:#1C1A17;">{break_s} 天</b></td>
          <td style="padding:0;vertical-align:top;"><span style="color:#9A907F;font-size:10px;">反抽失败</span><br><b style="font-size:15px;color:#1C1A17;">{rebreak_s} 次</b></td>
        </tr>
      </table>
      <div style="margin-top:14px;font-size:10px;letter-spacing:.14em;color:#8E8474;">触发画像</div>
      <div style="margin-top:6px;font-size:12px;line-height:1.8;color:#4A4337;">
        {hot_s} · {near_s} · 确认 C={c_s} · E={e_s}<br>
        成交拥挤：{crowd} {crowd_s}<br>
        R 是 252 日滚动分位综合分，单看涨幅不够；破 20 日线只做确认，不做单独预测。
      </div>
      <div style="margin-top:14px;padding:12px 14px;background:{bg};border-left:3px solid {color};font-size:12px;line-height:1.7;color:#4A4238;">
        <b>下一步纪律</b><br>{next_text}
      </div>
      <a href="{SITE}" style="display:inline-block;margin-top:14px;color:{color};font-weight:700;text-decoration:none;font-size:13px;">打开实时雷达 →</a>
    </div>
    <div style="padding:11px 20px 14px;background:#EFE8DB;color:#8A8172;font-size:10px;line-height:1.7;">
      数据 {latest.get('date', '—')} · {SITE}<br>
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
