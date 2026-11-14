"""国家队ETF持续追踪 · 盘中轻量观察（v2.2）

独立于此项目的日频数据链：不跑全量长历史采集、不改正式份额、不发结论级身份判断。
只做：轻量快照 -> 独立盘中规则 -> 事件状态机 -> 留档与通知队列。

纪律（config/intraday_rules.json）：
  - 核心ETF角色、放量、折溢价、同步交易都不能证明国家队身份。
  - 不输出国家队概率，不编造盘中买入金额。
  - 过期行情、日期错位、缺失一律标 unavailable，不解释为「没有托底」。
  - 二级市场买卖可能不改变总份额；盘后无净申购不能单独判定盘中线索错误。
  - 补采历史事件标 replayed=true，不当成正在发生的新事件。
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time
import math
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta, date as date_cls
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from v2_common import ROOT, DATA, CONFIG, CORE, FAMILY, INDEX, symbol, now, read_json, write_json, quantile

TZ = timezone(timedelta(hours=8))
IDIR = Path(os.environ.get('GJD_INTRADAY_DIR', DATA.parent / 'intraday')).resolve()
RULES = read_json(CONFIG / 'intraday_rules.json') or {}
SCHED = RULES.get('schedule', {})
TH = RULES.get('thresholds', {})
WINDOWS = RULES.get('windows_minutes', [5, 15, 30])
LOCK = IDIR / 'intraday.lock'
STATE_FILE = IDIR / 'state.json'
LATEST_FILE = IDIR / 'latest.json'
BASELINE_FILE = IDIR / 'baseline.json'
PENDING_FILE = IDIR / 'notify_pending.jsonl'
LOG_FILE = IDIR / 'run.log'

QT_URL = 'https://qt.gtimg.cn/q='
PROFILE_DIR = IDIR / 'profiles'
# 分时接口实测不稳定（限流/代理抖动），仅作为可选补充，不作为基线必需来源。
TRENDS_URL = ('https://push2his.eastmoney.com/api/qt/stock/trends2/get?'
              'secid={secid}&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
              '&ndays=1&iscr=0')
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://gu.qq.com/'}

IDENTITY_NOTE = 'I0 当日买卖主体未确认'


def log(msg, kind='INFO'):
    IDIR.mkdir(parents=True, exist_ok=True)
    line = '%s [%s] %s\n' % (now(), kind, msg)
    with LOG_FILE.open('a', encoding='utf-8') as f:
        f.write(line)
    print(line.rstrip(), flush=True)


def tz_now():
    return datetime.now(TZ)


def fnum(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def parse_hhmm(s):
    h, m = s.split(':')
    return int(h) * 60 + int(m)


def session_state(t=None):
    """Asia/Shanghai 交易时段；仅周末 + 显式配置休市日，不保证节假日完整。"""
    t = t or tz_now()
    minute = t.hour * 60 + t.minute
    d = t.date().isoformat()
    if t.weekday() >= 5 or d in SCHED.get('holidays', []):
        return 'holiday'
    opens = [(parse_hhmm(a), parse_hhmm(b)) for a, b in SCHED.get('collect_hours', [])]
    auctions = [(parse_hhmm(a), parse_hhmm(b)) for a, b in SCHED.get('auction_hours', [])]
    for a, b in auctions:
        if a <= minute < b:
            return 'auction'
    for a, b in opens:
        if a <= minute < b:
            return 'open'
    if minute < min(a for a, _ in opens):
        return 'pre'
    if minute >= max(b for _, b in opens):
        return 'closed'
    return 'lunch'


def http_get(url, timeout=8, tries=3, backoff=(0.4, 0.9, 1.8)):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as exc:
            last = exc
            if i < tries - 1:
                time.sleep(backoff[min(i, len(backoff) - 1)])
    raise RuntimeError('%s 请求失败: %r' % (url[:90], last))


def index_pairs():
    """指数必须沿用 INDEX 自带前缀；不能走 symbol()（000300 会被误判成深市）。"""
    return [(v[2:], v) for v in INDEX.values() if v]


def index_codes():
    return [c for c, _ in index_pairs()]


def etf_pairs(codes):
    return [(str(c), symbol(c)) for c in codes]


def fetch_snapshot(pairs):
    """腾讯 qt 批量快照。pairs = [(纯代码, 带前缀行情代码)]。

    返回 (records, meta)，records 的键为纯代码。不用于反推份额。
    """
    pairs = sorted(set(pairs))
    meta = dict(url=QT_URL + ','.join(s for _, s in pairs),
                fetched_at=now(), requested=len(pairs), source='qt.gtimg.cn')
    out = {}
    for i in range(0, len(pairs), 40):
        chunk = pairs[i:i + 40]
        url = QT_URL + ','.join(s for _, s in chunk)
        try:
            raw = http_get(url, timeout=8).decode('gbk', 'ignore')
        except Exception as exc:
            meta.setdefault('errors', []).append(str(exc))
            log('批次采集失败 %s' % exc, 'WARN')
            continue
        for seg in raw.split(';'):
            if '="' not in seg:
                continue
            body = seg.split('="', 1)[1]
            f = body.rstrip('" \n').split('~')
            if len(f) < 40:
                continue
            code = f[2]
            out[code] = dict(
                code=code, name=f[1] if len(f) > 1 else '',
                price=fnum(f[3]), prev_close=fnum(f[4]), open=fnum(f[5]),
                vol_hand=fnum(f[6]), amount_wan=fnum(f[37]) if len(f) > 37 else None,
                turnover_pct=fnum(f[38]) if len(f) > 38 else None,
                pct=fnum(f[32]) if len(f) > 32 else None,
                high=fnum(f[33]), low=fnum(f[34]),
                premium_pct=fnum(f[77]) if len(f) > 77 else None,
                iopv=fnum(f[78]) if len(f) > 78 else None,
                quote_time=f[30] if len(f) > 30 else '',
                raw=seg.strip(),
            )
    meta['received'] = len(out)
    meta['quote_times'] = sorted({v['quote_time'] for v in out.values() if v['quote_time']})
    return out, meta


def quote_datetime(s):
    try:
        return datetime.strptime(s, '%Y%m%d%H%M%S').replace(tzinfo=TZ)
    except (ValueError, TypeError):
        return None


def freshness(records, at=None):
    """返回 (业务日, 行情时间, 延迟秒, 状态)。过期/错位/缺失都不等价于无托底。"""
    at = at or tz_now()
    times = [quote_datetime(v['quote_time']) for v in records.values()]
    times = [t for t in times if t]
    if not times:
        return None, None, None, 'unavailable'
    q = max(times)
    lag = (at - q).total_seconds()
    if q.date() != at.date():
        return q.date().isoformat(), q, lag, 'date_mismatch'
    if lag > SCHED.get('stale_seconds', 180):
        return q.date().isoformat(), q, lag, 'stale'
    return q.date().isoformat(), q, lag, 'fresh'


# ---------------------------------------------------------------- 基线

def profile_path(business_date):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    return PROFILE_DIR / (business_date + '.json')


def accumulate_profile(business_date, records, state):
    """把每次快照之间的区间成交额按分钟归档，逐日累积成自己的历史基线。

    不联网拉历史：外部分时接口实测不稳定，且提示词明确要求历史不足时标冷启动、不伪造基线。
    """
    if not business_date:
        return
    p = profile_path(business_date)
    prof = read_json(p) or {}
    for code, r in records.items():
        hm = (r.get('quote_time') or '')[8:12]
        if len(hm) != 4:
            continue
        hm_fmt = hm[:2] + ':' + hm[2:]
        prev = state['prev'].get(code, {})
        if r.get('amount_wan') is None or prev.get('amount_wan') is None:
            continue
        if r.get('quote_time', '') <= prev.get('quote_time', ''):
            continue
        delta = r['amount_wan'] - prev['amount_wan']
        if delta < 0:
            continue
        bucket = prof.setdefault(code, {})
        bucket[hm_fmt] = delta + bucket.get(hm_fmt, 0.0)
    write_json(p, prof)


def build_baseline(codes=None):
    """从已归档的交易日分钟画像汇总历史同一时段分位；交易日不足则标冷启动。"""
    codes = codes or core_codes()
    cfg = RULES.get('baseline', {})
    files = sorted(PROFILE_DIR.glob('*.json'))[-cfg.get('max_days', 20):] if PROFILE_DIR.exists() else []
    per = {}
    usable_days = 0
    for f in files:
        prof = read_json(f) or {}
        points = sum(len(v) for v in prof.values())
        if points < 100:          # 不完整交易日不进基线
            continue
        usable_days += 1
        for code, minutes in prof.items():
            for hm, amt in minutes.items():
                per.setdefault(code, {}).setdefault(hm, []).append(amt)
    result = {c: {hm: quantile(v, .5) for hm, v in minutes.items() if v}
              for c, minutes in per.items()}
    min_days = cfg.get('min_days', 5)
    payload = dict(built_at=now(), source='本地逐日分钟画像归档',
                   requested_days=cfg.get('max_days', 20), observed_days=usable_days,
                   min_days=min_days, per_code=result,
                   complete=usable_days >= min_days and len(result) >= len(codes) * 0.8,
                   note='交易日不足 min_days 时为冷启动，只输出线索、不升级；不伪造历史基线')
    write_json(BASELINE_FILE, payload)
    return payload


# ---------------------------------------------------------------- 状态与窗口

def init_state():
    return dict(version=RULES.get('version'), created_at=now(), last_tick=None,
                prev={}, windows={}, events={}, fault_sent=False, fault_key=None,
                baseline_days=0, replay=False)


def load_state():
    s = read_json(STATE_FILE)
    if not s or s.get('version') != RULES.get('version'):
        return init_state()
    return s


def push_window(state, code, rec):
    """滚动保留 40 分钟快照，供 5/15/30 分钟窗口判断。"""
    w = state['windows'].setdefault(code, [])
    w.append(dict(t=rec['quote_time'], price=rec['price'], pct=rec['pct'],
                  premium=rec['premium_pct'], amount=rec['amount_wan'],
                  vol=rec['vol_hand']))
    cutoff = (quote_datetime(rec['quote_time']) or tz_now()) - timedelta(minutes=45)
    state['windows'][code] = [x for x in w
                              if (quote_datetime(x['t']) or tz_now()) >= cutoff][-60:]


def window_delta(state, code, field, minutes):
    w = state['windows'].get(code, [])
    if not w:
        return None
    end = quote_datetime(w[-1]['t']) or tz_now()
    start = end - timedelta(minutes=minutes)
    older = [x for x in w if (quote_datetime(x['t']) or tz_now()) <= start]
    if not older:
        return None
    a, b = older[-1].get(field), w[-1].get(field)
    return (b - a) if (a is not None and b is not None) else None


def median(xs):
    xs = [x for x in xs if x is not None and math.isfinite(x)]
    return quantile(xs, .5) if xs else None


# ---------------------------------------------------------------- 信号

def compute_signals(records, state, baseline):
    """逐只 + 汇总。全部为「线索」，不含身份结论、不含国家队金额。"""
    idx = {c: records[c] for c in index_codes() if c in records}
    idx_pct = {}
    for fam, sym in INDEX.items():
        c = sym[2:]
        if c in idx:
            idx_pct[fam] = idx[c].get('pct')
    fam_pct = {}
    for code, r in records.items():
        if code not in idx and (code in CORE or code in FAMILY):
            fam_pct.setdefault(FAMILY.get(code, '行业主题/待核验'), []).append(r.get('pct'))

    bl = (baseline or {}).get('per_code', {})
    cold = not (baseline or {}).get('complete')
    rows, levels = [], []
    for code, r in sorted(records.items()):
        if code in idx:
            continue
        fam = FAMILY.get(code, '行业主题/待核验')
        ip = idx_pct.get(fam)
        peer = median([x for x in fam_pct.get(fam, []) if x is not None])
        rel = (r['pct'] - ip) if (r['pct'] is not None and ip is not None) else None
        rel_peer = (r['pct'] - peer) if (r['pct'] is not None and peer is not None) else None
        prev = state['prev'].get(code, {})
        d_amount = (r['amount_wan'] - prev['amount_wan']
                    if r.get('amount_wan') is not None and prev.get('amount_wan') is not None
                    and r.get('quote_time', '') > prev.get('quote_time', '') else None)
        hm = r.get('quote_time', '')[8:12]
        hm_fmt = hm[:2] + ':' + hm[2:] if len(hm) == 4 else None
        base_amt = (bl.get(code) or {}).get(hm_fmt)
        activity = (d_amount / base_amt) if (d_amount and base_amt and base_amt > 0) else None
        prem_d15 = window_delta(state, code, 'premium', 15)
        prem_d5 = window_delta(state, code, 'premium', 5)
        pct_d15 = window_delta(state, code, 'pct', 15)

        channels, counter = [], []
        if activity is not None and activity >= TH.get('activity_ratio_L1', 1.8):
            channels.append('放量')
        elif activity is not None and activity < 1:
            counter.append('成交额低于同一时段基线')
        if rel is not None and abs(rel) >= TH.get('relative_excess_pct_L1', .15):
            channels.append('相对指数超额' if rel > 0 else '相对指数走弱')
        if rel is not None and rel_peer is not None and rel * rel_peer < 0:
            counter.append('相对指数与相对同类ETF方向不一致')
        if r.get('premium_pct') is not None and abs(r['premium_pct']) >= TH.get('premium_abs_pct', .25):
            channels.append('折溢价偏离')
        if prem_d15 is not None and abs(prem_d15) >= TH.get('premium_delta_pct_15m', .18):
            channels.append('折溢价变化')
        if rel is not None and rel > 0 and prem_d15 is not None and prem_d15 < 0:
            counter.append('价格偏强但溢价收窄')
        if rel is not None and rel < 0 and prem_d15 is not None and prem_d15 > 0:
            counter.append('价格偏弱但溢价抬升')

        direction = 'neutral'
        if rel is not None:
            direction = 'support_clue' if rel > 0 else 'retreat_clue'
        rows.append(dict(code=code, name=r.get('name', ''), family=fam,
                         price=r['price'], pct=r['pct'], index_pct=ip,
                         relative=rel, relative_peer=rel_peer,
                         premium=r.get('premium_pct'), iopv=r.get('iopv'),
                         premium_delta_5m=prem_d5, premium_delta_15m=prem_d15,
                         pct_delta_15m=pct_d15, amount_delta_wan=d_amount,
                         activity_ratio=activity, channels=channels,
                         counter_evidence=counter, direction=direction,
                         quote_time=r.get('quote_time'),
                         data_status='ok' if r.get('price') is not None else 'unavailable'))
        levels.append(len(channels))

    active = [x for x in rows if x['channels']]
    breadth = len(active) / len(rows) if rows else 0
    fams = {x['family'] for x in active}
    sync = dict(breadth=breadth, active_count=len(active), total=len(rows),
                families=sorted(fams), family_count=len(fams),
                management_note='管理人归属未逐只核验，不作身份判断')
    # 方向一致性
    sup = [x for x in active if x['direction'] == 'support_clue']
    ret = [x for x in active if x['direction'] == 'retreat_clue']
    leadership = 'mixed'
    if sup and len(sup) >= len(ret) * 2:
        leadership = 'support_clue'
    elif ret and len(ret) >= len(sup) * 2:
        leadership = 'retreat_clue'
    return dict(rows=rows, sync=sync, leadership=leadership, cold_start=cold,
                baseline_days=(baseline or {}).get('observed_days', 0),
                baseline_min_days=RULES.get('baseline', {}).get('min_days', 5),
                identity=IDENTITY_NOTE,
                direction_data='qt快照含买卖五档；无可靠逐笔/主动成交方向，方向待确认')


def decide_level(sig, state, freshness_state):
    """L0 无 / L1 线索 / L2 升级 / L3 多通道共振。冷启动与数据异常只到 L1。"""
    if freshness_state != 'fresh':
        return 'L0'
    sync, cold = sig['sync'], sig['cold_start']
    if sync['active_count'] == 0:
        return 'L0'
    strong_channels = sum(1 for x in sig['rows'] if len(x['channels']) >= 2)
    if cold:
        return 'L1'
    if (sync['breadth'] >= TH.get('sync_breadth_L2', .75)
            and sync['family_count'] >= TH.get('sync_min_families', 3)
            and strong_channels >= TH.get('strong_concurrency', 3)):
        return 'L3'
    if (sync['breadth'] >= TH.get('sync_breadth_L1', .55)
            or strong_channels >= TH.get('escalate_concurrency', 2)):
        return 'L2'
    return 'L1'


def event_key(*parts):
    return '|'.join(str(x) for x in parts)


def update_events(state, sig, level, business_date, at, replay=False):
    """事件状态机：新/升级/反转/恢复/故障；状态不变静默。

    direction 与 level 是事件的可变属性，不进去重键；否则升级会被误判成新事件、
    方向反转也永远检测不到。
    """
    emitted = []
    if level == 'L0':
        for k, e in list(state['events'].items()):
            if e['state'] in ('active', 'escalated') and e.get('business_date') == business_date:
                e['state'] = 'quiet'
                e['last_seen'] = at
        return emitted
    active = [x for x in sig['rows'] if x['channels']]
    fams = sorted({x['family'] for x in active}) or ['未分类']
    direction = sig['leadership']
    for fam in fams:
        codes = [x['code'] for x in active if x['family'] == fam]
        key = event_key(business_date, fam)
        e = state['events'].get(key)
        evidence = dict(
            breadth=round(sig['sync']['breadth'], 3),
            breadth_note='%d/%d 只出现至少一条通道线索' % (sig['sync']['active_count'], sig['sync']['total']),
            families=sig['sync']['families'],
            channels=sorted({c for x in active if x['family'] == fam for c in x['channels']}),
            premium=sorted({x['premium'] for x in active if x['family'] == fam and x['premium'] is not None})[:3],
            activity=sorted({round(x['activity_ratio'], 2) for x in active if x['family'] == fam and x['activity_ratio'] is not None}, reverse=True)[:3],
            relative=sorted({round(x['relative'], 3) for x in active if x['family'] == fam and x['relative'] is not None})[:3],
            cold_start=sig['cold_start'],
        )
        counter = sorted({c for x in active if x['family'] == fam for c in x['counter_evidence']})
        if not e:
            e = dict(key=key, business_date=business_date, direction=direction, family=fam,
                     level=level, state='active', first_clue=at, first_seen=at, last_seen=at,
                     peak_level=level, codes=codes, notifications=[], replayed=replay,
                     evidence_history=[], counter_evidence=counter)
            state['events'][key] = e
            emitted.append(('new', e))
        else:
            e['last_seen'] = at
            e['codes'] = sorted(set(e.get('codes', []) + codes))
            if e['state'] in ('quiet', 'recovered') and not replay:
                e['state'] = 'active'
                emitted.append(('recover', e))
            elif e.get('direction') != direction:
                e['direction'] = direction
                e['state'] = 'active'
                emitted.append(('reverse', e))
            elif level > e['level']:
                e['level'], e['peak_level'] = level, level
                e['state'] = 'escalated'
                emitted.append(('escalate', e))
            # 状态不变 -> 不提醒（silent_when_unchanged）
        e['evidence'] = evidence
        e['counter_evidence'] = counter
        e['evidence_history'].append(dict(t=at, level=level, **{k: evidence[k] for k in ('breadth', 'channels')}))
        e['evidence_history'] = e['evidence_history'][-120:]
    return emitted


def build_notification(kind, e, sig, freshness_state, lag, at, replay=False):
    dur = None
    try:
        dur = int((datetime.fromisoformat(at) - datetime.fromisoformat(e['first_clue'])).total_seconds() / 60)
    except Exception:
        pass
    return dict(
        id='%s-%s' % (e['key'], at.replace(':', '').replace('-', '')),
        kind=kind, created_at=at, replayed=replay,
        time=at, etf_or_family=e['family'],
        codes=e.get('codes', []),
        direction=e['direction'], level=e['level'],
        evidence=e.get('evidence', {}),
        duration_minutes=dur, duration=dur,
        counter_evidence=e.get('counter_evidence', []),
        data_freshness=dict(status=freshness_state, lag_seconds=lag,
                            quote_time=(sig.get('quote_time') or None)),
        identity_status=IDENTITY_NOTE,
        pending_verification=[
            '当日实名买卖主体未提供', '盘后正式份额与盘中线索需分别核对',
            '二级市场买卖可能不改变总份额', '折溢价字段未经交易所独立核验',
        ],
        caveats=['这不是国家队买卖确认', '不提供盘中买入金额或概率'],
    )


# ---------------------------------------------------------------- 单轮

def date_dirs(business_date):
    d = IDIR / (business_date or tz_now().date().isoformat())
    d.mkdir(parents=True, exist_ok=True)
    return d


def append_jsonl(path, obj):
    with path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')


def core_codes():
    return sorted(CORE)


def extended_codes():
    """扩展池：注册表内 watch 的境内股票ETF，去掉核心。"""
    reg = read_json(CONFIG / 'registry.json') or {}
    out = []
    for x in reg.get('items', []):
        if x.get('watch') and x.get('scope') == 'domestic_equity' and x['code'] not in CORE:
            out.append(x['code'])
    return sorted(out)


def tick(state, baseline, replay_records=None, replay_meta=None, at=None):
    at = at or now()
    t = tz_now()
    sess = session_state(t)
    codes = core_codes()
    # 扩展池降低频率：每 extended_interval_seconds 才带一次
    last_ext = state.get('last_extended_at')
    include_ext = False
    if last_ext:
        try:
            include_ext = (t - datetime.fromisoformat(last_ext)).total_seconds() >= SCHED.get('extended_interval_seconds', 300)
        except ValueError:
            include_ext = True
    else:
        include_ext = True
    if include_ext:
        codes += extended_codes()
        state['last_extended_at'] = at
    idx = index_codes()

    if replay_records is not None:
        records, meta = replay_records, (replay_meta or {})
        meta = dict(meta, replayed=True, source='replay')
    else:
        try:
            records, meta = fetch_snapshot(etf_pairs(codes) + index_pairs())
        except Exception as exc:
            # 断网不崩溃：留档 unavailable，交易时段内按采集故障提醒，恢复后再发 recover。
            records, meta = {}, dict(url='qt.gtimg.cn', fetched_at=now(), requested=len(codes),
                                     received=0, source='qt.gtimg.cn', errors=[str(exc)])
            log('行情请求完全失败：%r' % exc, 'WARN')
    business_date, qtime, lag, fresh = freshness(records, t)
    # 休市/午休/集合竞价不是采集故障，也不能解释为「没有托底」。
    out_of_session = sess != 'open'
    if out_of_session:
        fresh = 'out_of_session'
    meta.update(dict(at=at, session=sess, out_of_session=out_of_session,
                     business_date=business_date,
                     quote_time=qtime.isoformat() if qtime else None,
                     lag_seconds=lag, freshness=fresh,
                     core_count=len(CORE), extended_included=include_ext,
                     requested=len(codes) + len(idx), received=len(records)))
    ddir = date_dirs(business_date)
    append_jsonl(ddir / 'snapshots.jsonl',
                 dict(meta=meta, records={c: {k: v for k, v in r.items() if k != 'raw'}
                                          for c, r in records.items()}))

    for c, r in records.items():
        push_window(state, c, r)
    accumulate_profile(business_date, records, state)
    sig = compute_signals(records, state, baseline)
    sig['quote_time'] = meta.get('quote_time')
    level = 'L0' if out_of_session else decide_level(sig, state, fresh)

    emitted = []
    # 采集故障与恢复（含行情过期、日期错位、缺失）
    fault = (not out_of_session) and (
        fresh in ('stale', 'date_mismatch', 'unavailable') or not records or meta.get('errors'))
    fkey = event_key(business_date or 'unknown', 'data_fault')
    if fault:
        if not state.get('fault_sent'):
            e = dict(key=fkey, business_date=business_date, direction='data_fault',
                     family='data', level='L0', state='active', first_clue=at,
                     first_seen=at, last_seen=at, peak_level='L0', codes=[],
                     notifications=[], evidence_history=[],
                     evidence=dict(freshness=fresh, lag_seconds=lag, errors=meta.get('errors')),
                     counter_evidence=[])
            state['events'][fkey] = e
            state['fault_sent'] = True
            # 断网时业务日未知（unknown），恢复后业务日会变成实际日期；
            # 必须记住当时的键，否则恢复事件找不到原故障、recover 提醒会丢失。
            state['fault_key'] = fkey
            emitted.append(('fault', e))
            log('采集故障/行情不可用：%s lag=%s' % (fresh, lag), 'WARN')
    elif state.get('fault_sent'):
        e = state['events'].get(state.get('fault_key') or fkey)
        if e:
            emitted.append(('recover', e))
            e['state'] = 'recovered'
        state['fault_sent'] = False
        state['fault_key'] = None
        log('采集恢复', 'INFO')

    if not fault:
        emitted += update_events(state, sig, level, business_date, at,
                                 replay=bool(replay_records is not None))

    notes = []
    for kind, e in emitted:
        n = build_notification(kind, e, sig, fresh, lag, at,
                               replay=bool(replay_records is not None))
        e['notifications'].append(dict(kind=kind, at=at, id=n['id']))
        notes.append(n)
        append_jsonl(ddir / 'notifications.jsonl', n)
        append_jsonl(PENDING_FILE, n)
        append_jsonl(ddir / 'events.jsonl', dict(kind=kind, event={k: v for k, v in e.items()
                                                                   if k != 'evidence_history'}))
        log('事件 %s %s %s %s' % (kind, e['level'], e['family'], e['direction']))

    state['prev'] = {c: dict(amount_wan=r.get('amount_wan'), vol_hand=r.get('vol_hand'),
                             quote_time=r.get('quote_time'), price=r.get('price'))
                     for c, r in records.items()}
    state['last_tick'] = at
    write_json(STATE_FILE, state)

    latest = dict(
        version=RULES.get('version'), generated_at=at, session=sess,
        out_of_session=out_of_session,
        session_note=('非交易时段：行情不更新属正常，不解释为没有托底'
                      if out_of_session else '连续竞价时段'),
        business_date=business_date, quote_time=meta.get('quote_time'),
        lag_seconds=lag, freshness=fresh,
        coverage=dict(core_expected=len(CORE),
                      core_received=sum(1 for c in CORE if c in records),
                      extended_received=sum(1 for c in extended_codes() if c in records),
                      total_received=len(records),
                      catalogue_note='供应商目录不等于交易所全市场覆盖'),
        identity=IDENTITY_NOTE,
        data_stage='盘中观察（非正式份额）',
        official_note='正式份额区保留最后一版已核验结果；本区不改动',
        cold_start=sig['cold_start'], baseline_days=sig['baseline_days'],
        baseline_min_days=sig['baseline_min_days'],
        # 休市时 rows/sync 来自上一交易日的残留快照，只作留档，不得当作当日实时线索。
        signals_realtime=not out_of_session,
        signals_note=('非交易时段：以下逐只明细为上一交易日残留快照，不参与当日判断'
                      if out_of_session else '连续竞价时段实时快照'),
        level=level, leadership=sig['leadership'], sync=sig['sync'],
        direction_data=sig['direction_data'],
        rows=sig['rows'],
        alerts=notes,
        event_summary=dict(active=sum(1 for e in state['events'].values() if e['state'] in ('active', 'escalated')),
                           total=len(state['events'])),
        discipline=RULES.get('discipline', {}),
    )
    write_json(LATEST_FILE, latest)
    return latest


# ---------------------------------------------------------------- CLI

def acquire_lock(force=False):
    IDIR.mkdir(parents=True, exist_ok=True)
    if LOCK.exists() and not force:
        try:
            old = read_json(LOCK) or {}
            age = (tz_now() - datetime.fromisoformat(old.get('at', now()))).total_seconds()
        except Exception:
            age = 0
        if age < SCHED.get('core_interval_seconds', 60) * 3:
            raise SystemExit('已有采集进程在运行（锁 %s，%d 秒）。重复启动已阻止。' % (LOCK, age))
        log('检测到过期锁，清理', 'WARN')
        LOCK.unlink(missing_ok=True)
    try:
        with LOCK.open('x', encoding='utf-8') as f:
            json.dump(dict(pid=os.getpid(), at=now()), f)
    except FileExistsError:
        raise SystemExit('并发锁冲突，退出')


def release_lock():
    LOCK.unlink(missing_ok=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--once', action='store_true', help='采集一轮后退出')
    p.add_argument('--loop', action='store_true', help='按配置间隔常驻')
    p.add_argument('--duration', type=int, default=0, help='配合 --loop，运行 N 秒后退出（试跑）')
    p.add_argument('--baseline', action='store_true', help='从已归档分钟画像汇总历史同一时段基线')
    p.add_argument('--replay', help='回放归档 snapshots.jsonl，事件标 replayed，不冒充新事件')
    p.add_argument('--status', action='store_true', help='打印当前状态，不采集')
    p.add_argument('--notify-drain', action='store_true', help='输出待通知事件（供定时任务消费）')
    p.add_argument('--notify-ack', action='store_true', help='配合 --notify-drain 确认已消费')
    p.add_argument('--force-lock', action='store_true', help='确认旧进程已退出后强制清锁')
    p.add_argument('--watchdog', action='store_true',
                   help='看门狗：仅当 last_tick 超时且无有效锁时补跑一轮，供计划任务做断线恢复')
    a = p.parse_args()

    IDIR.mkdir(parents=True, exist_ok=True)
    if a.status:
        print(json.dumps(read_json(LATEST_FILE) or {'status': '尚无盘中数据'}, ensure_ascii=False, indent=2))
        return
    if a.notify_drain:
        items = []
        if PENDING_FILE.exists():
            for line in PENDING_FILE.read_text(encoding='utf-8').splitlines():
                if line.strip():
                    try:
                        items.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        print(json.dumps(dict(count=len(items), items=items,
                             channel_limit=RULES['alerts']['channel_limit']),
                        ensure_ascii=False, indent=2))
        if a.notify_ack:
            ack = IDIR / 'notify_ack.jsonl'
            if items:
                with ack.open('a', encoding='utf-8') as f:
                    for x in items:
                        f.write(json.dumps(dict(id=x['id'], acked_at=now()), ensure_ascii=False) + '\n')
            PENDING_FILE.unlink(missing_ok=True)
            log('通知队列已确认消费 %d 条' % len(items))
        return
    if a.baseline:
        b = build_baseline()
        log('基线汇总完成，可用交易日 %d/%d，覆盖 %d 只，complete=%s'
            % (b['observed_days'], b['min_days'], len(b['per_code']), b['complete']))
        return

    if a.watchdog:
        s = read_json(STATE_FILE) or {}
        sess_now = session_state()
        interval = (SCHED.get('core_interval_seconds', 60) if sess_now == 'open'
                    else SCHED.get('idle_interval_seconds', 300))
        limit = max(interval * 3, 180)
        stale = True
        if s.get('last_tick'):
            try:
                stale = (tz_now() - datetime.fromisoformat(s['last_tick'])).total_seconds() > limit
            except ValueError:
                stale = True
        if not stale:
            log('看门狗：采集正常（last_tick=%s），不补跑' % s.get('last_tick'))
            return
        if LOCK.exists():
            try:
                old = read_json(LOCK) or {}
                age = (tz_now() - datetime.fromisoformat(old.get('at', now()))).total_seconds()
            except Exception:
                age = 0
            if age < limit:
                log('看门狗：存在有效锁（%d 秒），主进程可能仍在运行，不补跑' % age)
                return
            LOCK.unlink(missing_ok=True)
            log('看门狗：清理过期锁', 'WARN')
        acquire_lock()
        try:
            tick(load_state(), read_json(BASELINE_FILE))
        finally:
            release_lock()
        log('看门狗：last_tick 超时，已补跑一轮（留档不冒充新事件）', 'WARN')
        return

    state = load_state()
    baseline = read_json(BASELINE_FILE)
    if a.replay:
        path = Path(a.replay)
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            snap = json.loads(line)
            recs = snap.get('records') or {}
            for c, r in recs.items():
                r.setdefault('raw', '')
            tick(state, baseline, replay_records=recs,
                 replay_meta=snap.get('meta', {}))
        log('回放完成 %s（事件均标 replayed）' % path.name)
        return

    acquire_lock(a.force_lock)
    try:
        if a.once or not a.loop:
            out = tick(state, baseline)
            log('单轮完成 session=%s fresh=%s level=%s alerts=%d'
                % (out['session'], out['freshness'], out['level'], len(out['alerts'])))
            return
        deadline = time.monotonic() + a.duration if a.duration else None
        log('进入常驻采集，间隔 %s 秒' % SCHED.get('core_interval_seconds', 60))
        while True:
            if deadline and time.monotonic() >= deadline:
                log('试跑时长到达，退出')
                break
            started = time.monotonic()
            sess_now = session_state()
            interval = (SCHED.get('core_interval_seconds', 60) if sess_now == 'open'
                        else SCHED.get('idle_interval_seconds', 300))
            try:
                tick(state, baseline)
            except Exception as exc:
                log('单轮异常（保留现场，下轮继续）：%r' % exc, 'ERROR')
            sleep = max(1, interval - (time.monotonic() - started))
            until = min(sleep, deadline - time.monotonic()) if deadline else sleep
            if until <= 0:
                break
            time.sleep(until)
    finally:
        release_lock()


if __name__ == '__main__':
    main()
