"""Fixed live universe for the main-wave scanner.

The ETF list is the 17-ETF research universe frozen on 2026-11-27.
Leader baskets are fixed, current representative constituents. They are
used only as an industry thermometer (breadth), never as a hard gate or as
individual-stock advice.
"""

START_FETCH = "2023-01-01"
HISTORY_START = "2024-01-01"
MARKET = "1.000300"
MARKET_NAME = "沪深300"


def _source(code):
    prefix = "sh" if code.startswith("1.") else "sz"
    return f"https://quote.eastmoney.com/{prefix}{code.split('.')[-1]}.html"


THEMES = (
    ("光通信 / CPO", ("0.300502", "0.300308", "0.300394"), (
        ("1.515880", "通信ETF国泰", "https://e.gtfund.com/etrade/Jijin/view/id/515880"),
        ("0.159583", "通信ETF富国", "https://www.fullgoal.com.cn/fundDetail/159583/index.html"),
        ("1.515050", "5G通信ETF华夏", "https://www.chinaamc.com.cn/fund/515050/zichanzuhe.shtml"),
    )),
    ("半导体材料设备", ("1.688012", "0.002371", "1.688072"), (
        ("0.159516", "半导体设备ETF国泰", "https://dataclouds.cninfo.com.cn/sjother2/fund/2026/20261026/efa383d3b0c8a1d5287b4d61c270b0fc.pdf"),
    )),
    ("创新药", ("1.600276", "0.002422", "1.688235"), (
        ("0.159992", "创新药ETF银华", "https://static.cninfo.com.cn/finalpage/2026-10-26/1225621367.PDF"),
    )),
    ("半导体芯片", ("1.688981", "1.603501", "1.688008"), (
        ("1.512480", "半导体芯片ETF", _source("1.512480")),
    )),
    ("光伏", ("1.601012", "1.600438", "0.300274"), (
        ("1.515790", "光伏ETF", _source("1.515790")),
    )),
    ("新能源车", ("0.300750", "0.002594", "0.300014"), (
        ("1.515030", "新能源车ETF", _source("1.515030")),
    )),
    ("军工", ("1.600893", "0.000768", "1.600760"), (
        ("1.512660", "军工ETF", _source("1.512660")),
    )),
    ("有色金属", ("1.601899", "1.603993", "1.600547"), (
        ("1.512400", "有色金属ETF", _source("1.512400")),
    )),
    ("酒类", ("1.600519", "0.000858", "0.000568"), (
        ("1.512690", "酒ETF", _source("1.512690")),
    )),
    ("银行", ("1.600036", "1.601166", "1.601398"), (
        ("1.512800", "银行ETF", _source("1.512800")),
    )),
    ("证券", ("1.600030", "1.601688", "1.601211"), (
        ("1.512880", "证券ETF", _source("1.512880")),
    )),
    ("煤炭", ("1.601088", "1.601225", "1.600188"), (
        ("1.515220", "煤炭ETF", _source("1.515220")),
    )),
    ("传媒", ("0.002027", "0.300413", "0.002555"), (
        ("1.512980", "传媒ETF", _source("1.512980")),
    )),
    ("房地产", ("1.600048", "0.001979", "1.600383"), (
        ("1.512200", "房地产ETF", _source("1.512200")),
    )),
    ("农业", ("0.002714", "0.300498", "1.600598"), (
        ("0.159825", "农业ETF", _source("0.159825")),
    )),
)

THEME_BY_CODE = {member[0]: theme for theme, _, members in THEMES for member in members}
NAME_BY_CODE = {member[0]: member[1] for _, _, members in THEMES for member in members}
SOURCE_BY_CODE = {member[0]: member[2] for _, _, members in THEMES for member in members}
ALL_ETFS = tuple(NAME_BY_CODE)
ALL_LEADERS = tuple({code for _, leaders, _ in THEMES for code in leaders})
