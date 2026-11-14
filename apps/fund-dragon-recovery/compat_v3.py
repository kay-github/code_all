"""Old script names resolve to the single v3 dataset. Never execute old estimates."""
from __future__ import annotations
import sys
from v3_common import *


def main(kind):
    if kind=='track':
        from update import main as update
        update();return
    if kind in {'render','render_keepers','build_combined','find_keepers'}:
        from v3_pipeline import latest
        a,p=latest()
        from v3_validate import validate
        validate(p)
        for target,name in [('光模块双龙仓位回补跟踪.html','report.html'),('光模块双龙_合并页.html','combined.html'),('谁还没卖双龙_坚守名单.html','association.html')]:
            (REPORTS/target).write_bytes((p/name).read_bytes())
        print('三个视图来自同一构建',a['build_id'],'；旧坚守/清仓判定停用。');return
    if kind=='verify_beta':
        from v3_validate import validate
        validate();return
    if kind in {'fetch_nav','fetch_all','fetch_holders','build_pool','wide_pool'}:
        print('旧分段采集已停用。请运行 python update.py，统一采集行情、两期披露和净值；没有写入旧缓存。')
        return
    raise SystemExit('旧补丁/规模探针已停用；请参考 README.md，修改受版本控制的 config 后重新构建验收。')
