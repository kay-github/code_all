"""Explicit release criteria; an incomplete refresh never replaces production."""
from datetime import datetime
from v2_common import CORE, now


def assess(a,at=None):
    problems=[];o=a.get('exchange',{});latest=o.get('latest',{})
    if set(o.get('instruments',{}))!=CORE:problems.append('核心正式份额成员不完整')
    if not latest.get('complete') or latest.get('date')!=a['end']:problems.append('当日正式份额或估值未齐全')
    if not o.get('w5',{}).get('complete'):problems.append('连续5日正式份额不完整')
    if not a.get('discovery',{}).get('catalogue_complete'):problems.append('目录分页未完整采集')
    if not a.get('discovery',{}).get('scanned'):problems.append('扩展发现扫描未执行')
    if o.get('issues'):problems.append('正式份额有未解决异常')
    current=datetime.fromisoformat(at or now())
    for code,x in o.get('instruments',{}).items():
        if x.get('error'):problems.append(code+'本次正式份额采集失败')
        if x.get('source')=='szse' and not x.get('next_morning_collected'):
            problems.append(code+'尚未经过次日早间复核')
        row=x.get('latest') or {}
        if x.get('latest_available') and x['latest_available']>a['end']:
            problems.append(code+'正式份额已更新到更晚业务日，行情日历需重新核对')
        if row.get('date')!=a['end'] or row.get('share_change') is None:problems.append(code+'业务日或相邻正式份额缺口')
        try:
            age=(current-datetime.fromisoformat(row.get('fetched_at') or x['fetched_at'])).total_seconds()/3600
            if age<0 or age>24:problems.append(code+'正式份额采集时间不适合本次发布，请重新获取')
        except (ValueError,TypeError,KeyError):problems.append(code+'采集时间缺失或无效')
    return dict(passed=not problems,problems=problems,build_id=a['build_id'],end=a['end'],checked_at=at or now())
