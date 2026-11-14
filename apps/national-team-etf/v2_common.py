"""Shared, dependency-free infrastructure for the ETF tracker v2."""
from __future__ import annotations
import hashlib
import gzip
import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

VERSION = '2.1.0'
ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('GJD_DATA_DIR',ROOT/'data'/'v2')).resolve()
REPORTS = Path(os.environ.get('GJD_REPORT_DIR',ROOT.parent if (ROOT.parent/'gjd_research').is_dir() else ROOT/'output')).resolve()
CONFIG = ROOT / 'config'

def now():
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds')

def read_json(path, default=None):
    path = Path(path)
    if not path.exists():return default
    if path.suffix=='.gz':
        with gzip.open(path,'rt',encoding='utf-8-sig') as f:return json.load(f)
    return json.loads(path.read_text(encoding='utf-8-sig'))

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    if path.suffix=='.gz':
        with gzip.open(tmp,'wt',encoding='utf-8',compresslevel=6) as f:
            json.dump(value,f,ensure_ascii=False,separators=(',',':'),allow_nan=False)
    else:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(tmp, path)

def quantile(values, p):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    k = (len(values) - 1) * p
    lo = int(k)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (k - lo)

def symbol(code):
    return ('sh' if str(code)[0] in '56789' else 'sz') + str(code)

INDEX = {
    '沪深300': 'sh000300', '上证50': 'sh000016', '中证500': 'sh000905',
    '中证1000': 'sh000852', '科创50': 'sh000688', '科创100': 'sh000698',
    '创业板': 'sz399006', '创业板50': 'sz399673', '创业板成长': 'sz399296',
    '中证A500': 'sh000510', '中证2000': 'sh932000', '上证指数': 'sh000001',
    '上证180': 'sh000010', '深证100': 'sz399330', '中证A50': 'sh930050',
}

CORE = {'510300', '510310', '159919', '510330', '510050', '510500',
        '512100', '159845', '588000', '588080', '159915', '159949',
        '563360', '512050', '159338'}

FAMILY = {}
for family, codes in {
    '沪深300': '510300 510310 510330 159919 515330 510360 510350 159925 515130',
    '上证50': '510050 510100 510710 510800',
    '中证500': '510500 512500 159922 159968',
    '中证1000': '512100 159845 560010 159633 159629',
    '创业板': '159915 159952 159977 159948',
    '创业板50': '159949', '创业板成长': '159967',
    '科创50': '588000 588080 588060 588050 588090 588180',
    '科创100': '588220 588190 588120 588030',
    '中证A500': '563360 159338 159361 159352 512050 563800 563880 159357',
    '中证2000': '563300 159531 159532', '上证指数': '510210',
    '上证180': '510180', '深证100': '159901',
    '中证A50': '563080',
}.items():
    for code in codes.split():
        FAMILY[code] = family

KNOWN_CROSS = set('159131 159509 159567 159570 159740 159792 159941 159518 159529 159506'.split())
KNOWN_NON_EQUITY = {'159980', '159981', '159985'}
NON_EQUITY = ('债', '货币', '短融', '存单', '黄金', '白银', '豆粕', '原油',
              '商品', '现金', '添益', '日利', '保证金', '理财', '日增')
CROSS_WORDS = ('恒生', '港股', '香港', '纳指', '纳斯达克', '中概', '标普', '日经',
               '德国', '法国', '美国', '沙特', '中韩', 'HK', '海外', '东南亚', '巴西', '港科技')

def classify(code, name):
    """No family inferred from a vague '50' or '300'; unknowns remain discoverable."""
    code = str(code)
    if code in FAMILY:
        family = FAMILY[code]
        return dict(scope='domestic_equity', family=family, index=INDEX.get(family),
                    classification='code_registry')
    if code in KNOWN_NON_EQUITY or code.startswith(('511', '551')) or any(w in name for w in NON_EQUITY):
        return dict(scope='non_equity', family='非股票', index=None, classification='name_or_prefix')
    if code in KNOWN_CROSS or code.startswith(('513', '520', '521')) or any(w in name for w in CROSS_WORDS):
        return dict(scope='cross_border', family='跨境', index=None, classification='name_or_prefix')
    for key, family in [('创业板50', '创业板50'), ('创成长', '创业板成长'),
                        ('沪深300', '沪深300'), ('300ETF', '沪深300'),
                        ('科创板50', '科创50'), ('科创50', '科创50'), ('科创100', '科创100'),
                        ('中证1000', '中证1000'), ('ZZ1000', '中证1000'),
                        ('中证500', '中证500'), ('500ETF', '中证500'),
                        ('A500', '中证A500'), ('上证50', '上证50'), ('创业板', '创业板')]:
        if key in name:
            return dict(scope='domestic_equity', family=family, index=INDEX.get(family),
                        classification='name_inferred')
    return dict(scope='domestic_equity', family='行业主题/待核验', index=None,
                classification='unassigned_family')
