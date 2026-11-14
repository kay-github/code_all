# -*- coding: utf-8 -*-
"""全局日期口径：改数据截止日只改这里。"""

from datetime import datetime, timezone, timedelta
END = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
PREV = None                # 由标准交易日表确定，不手工猜前一交易日
RANGE_A = '2024-05-01'
CURVE_A = '2026-09-01'      # 资金曲线起点
MONTH_A = END[:7] + '-01'

# 报告标题/文案用的中文日期
END_CN = f'{int(END[5:7])}月{int(END[8:])}日'
END_MMDD = END[5:]
