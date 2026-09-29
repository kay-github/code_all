# -*- coding: utf-8 -*-
"""网格交易管理器（移动版 UI）端到端冒烟测试
运行：python smoke_test.py（系统 Edge，无需下载浏览器）
覆盖：PRD GT 用例 UI 层 + FR-08 交易流水 + FR-06 导入预览 + P2 当前价标注
"""
import functools
import json
import re
import threading
import zipfile
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

DIST = Path(__file__).parent / "dist"
PORT = 8643
BASE = f"http://127.0.0.1:{PORT}/"
SHOTS = Path(__file__).parent / "smoke"
SHOTS.mkdir(exist_ok=True)

results = []


def check(name, fn):
    try:
        fn()
        results.append(("PASS", name))
        print(f"PASS  {name}")
    except Exception as e:
        results.append(("FAIL", name + " :: " + str(e)[:260]))
        print(f"FAIL  {name} :: {e}")


def assert_no_stick(page, selectors):
    """v1.3.1 回归：文字与按钮不得粘连。

    这类问题的根因是「类名没有对应 CSS 规则」——元素退回默认 inline 流排布，
    而 JSX 会折叠 </span> 与 <button> 之间的换行，两者之间一个空格都没有，
    于是按钮直接贴住文字；.btn 的 min-height 又会让它按 baseline 往下沉半行。
    单测/文本断言都抓不到，只能量几何：容器必须是 flex，且同一行时水平间距 >= 4px。
    """
    bad = page.evaluate(
        """(sels) => {
          const out = [];
          for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
              const span = el.querySelector('span'), btn = el.querySelector('button');
              if (!span || !btn) continue;
              const d = getComputedStyle(el).display;
              const a = span.getBoundingClientRect(), b = btn.getBoundingClientRect();
              const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
              // 谁在左不确定（.ledger-tools 里 button 在 span 之前），
              // 取两侧间距的较大值：分离时为正，重叠时为负。
              const sep = Math.max(b.left - a.right, a.left - b.right);
              if (d !== 'flex' && d !== 'grid') out.push(sel + ' display=' + d);
              else if (vOverlap && sep < 4) out.push(sel + ' sep=' + sep.toFixed(1));
            }
          }
          return out;
        }""",
        selectors,
    )
    assert not bad, f"按钮与文字粘连: {bad}"
    return True


def assert_styled(page, names):
    """v1.3.1 回归：类名必须有 CSS 规则，否则元素会露成浏览器默认样式。"""
    missing = page.evaluate(
        """(names) => names.filter(n => ![...document.styleSheets]
             .some(s => { try { return [...s.cssRules]
               .some(r => r.selectorText && r.selectorText.includes('.' + n)); }
               catch (e) { return false; } }))""",
        names,
    )
    assert not missing, f"无 CSS 规则的类名: {missing}"
    return True


def assert_fab_clear(page):
    """滚到底时，常驻的 ＋ 按钮不得压住任何卡片按钮。

    固定定位的 FAB 在任何滚动位置都会盖住「当时」位于其下方的内容，这属于移动端常规；
    真正不可接受的是**滚到底也躲不开**——那意味着按钮永久点不到。
    所以这里只在最大滚动位置断言，等价于校验列表底部留白是否足够。
    """
    page.mouse.wheel(0, 8000)
    page.wait_for_timeout(250)
    bad = page.evaluate(
        """() => {
          const fab = document.querySelector('.fab');
          if (!fab) return ['no fab'];
          const f = fab.getBoundingClientRect();
          const out = [];
          for (const b of document.querySelectorAll('.vlist .btn, .vlist .icon-btn')) {
            const r = b.getBoundingClientRect();
            if (r.width === 0) continue;
            const hit = !(r.right <= f.left || r.left >= f.right || r.bottom <= f.top || r.top >= f.bottom);
            if (hit) out.push(b.textContent.trim() || b.getAttribute('aria-label'));
          }
          return out;
        }"""
    )
    assert not bad, f"滚到底仍被 FAB 压住的按钮: {bad}"
    return True


def assert_no_cloud_calls(calls):
    """FR-10：未登录状态下不得产生任何云服务请求。

    这条是「登录是增值功能、不是准入门槛」的技术兜底。
    """
    assert calls == [], f"未登录状态出现了 {len(calls)} 个云服务请求: {calls[:3]}"
    return True


def _assert_revert_bg(page):
    """撤销条必须真的用上背景色——只断言 .revert 类存在是抓不到「无 CSS 规则」的。"""
    r = page.evaluate(
        """() => {
          const el = document.querySelector('.ledger-item.revert');
          if (!el) return 'not found';
          const bg = getComputedStyle(el).backgroundColor;
          return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? 'no background (' + bg + ')' : true;
        }"""
    )
    assert r is True, r
    return True


def _assert_ctx_bg(page, selector):
    """通用版：指定选择器必须真的用上背景色——只断言类名存在是抓不到「无 CSS 规则」的。"""
    r = page.evaluate(
        """(sel) => {
          const el = document.querySelector(sel);
          if (!el) return 'not found: ' + sel;
          const bg = getComputedStyle(el).backgroundColor;
          return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? 'no background (' + bg + ')' : true;
        }""",
        selector,
    )
    assert r is True, r
    return True


def long_press(page, locator, ms=600):
    """长按「＋」（FR-11）：按下不放、超过 450ms 阈值后再抬起。

    不用 locator.click(delay=ms)：长按期间面板会弹出来盖住按钮，
    Playwright 的 actionability 复检会因此抖动；直接驱动鼠标更确定。
    """
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    assert box, "元素不可见，无法长按"
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.wait_for_timeout(ms)
    page.mouse.up()


def assert_add_btn_sized(page):
    """「＋」必须是有尺寸的点按目标（≥30px），不能退化成默认 inline 元素。

    关于 display 的期望值：CSS 里写的是 inline-flex，但它是 .qty-wrap（inline-flex）
    的子项，按 CSS Display 的 blockification 规则会被「块化」成 flex —— 这是规范规定的
    正确结果，不是被别的规则覆盖。真正要守住的是「≥30px 的点按面积 + 内容居中」。
    """
    r = page.evaluate(
        """() => {
          const b = document.querySelector('.qty-add');
          if (!b) return 'not found';
          const cs = getComputedStyle(b), q = b.getBoundingClientRect();
          if (cs.display !== 'flex' && cs.display !== 'inline-flex') return 'display=' + cs.display;
          if (cs.alignItems !== 'center') return 'align-items=' + cs.alignItems;
          if (q.width < 30 || q.height < 30) return 'too small ' + q.width.toFixed(1) + 'x' + q.height.toFixed(1);
          return true;
        }"""
    )
    assert r is True, r
    return True


def assert_row_fits(page):
    """FR-11 回归：档位行的横向空间极紧（每侧约 179px）。

    加「＋」按钮时曾一度会挤爆行宽：.row-qty 是 flex 且子项 min-width:0，
    溢出不换行而是被裁切/顶出卡片，只在长价格或大数量时才肉眼可见。
    所以量几何：每张行卡不得横向溢出，且 Chip 与「＋」必须落在卡片内。
    """
    bad = page.evaluate(
        """() => {
          const out = [];
          for (const r of document.querySelectorAll('.row-item')) {
            if (r.scrollWidth > r.clientWidth + 1) out.push('overflow ' + r.scrollWidth + '>' + r.clientWidth);
            const box = r.getBoundingClientRect();
            for (const b of r.querySelectorAll('.qty-add, .qty-chip')) {
              const q = b.getBoundingClientRect();
              if (q.right > box.right + 0.5 || q.left < box.left - 0.5) out.push('outside: ' + b.className);
            }
          }
          return out.slice(0, 5);
        }"""
    )
    assert not bad, f"档位行横向溢出: {bad}"
    return True


def assert_pending_amber(page):
    """待记账态必须真的是琥珀色——只断言 .pending 类存在抓不到「无 CSS 规则」。"""
    r = page.evaluate(
        """() => {
          const b = document.querySelector('.qty-add.pending');
          if (!b) return 'not found';
          const cs = getComputedStyle(b);
          const m = cs.color.match(/\\d+/g);
          if (!m) return 'unparsable color: ' + cs.color;
          const [R, G, B] = m.map(Number);
          if (!(R > 120 && R > B + 40 && R >= G)) return 'not amber: ' + cs.color;
          if (cs.backgroundColor === 'rgba(0, 0, 0, 0)') return 'no background';
          return true;
        }"""
    )
    assert r is True, r
    return True


def serve():
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(DIST))
    httpd = HTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def validate_xlsx(path):
    """校验导出的 .xlsx：依赖无关生成器产物，可被 Excel 解析且数据正确"""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        assert "[Content_Types].xml" in names, "缺少 [Content_Types].xml"
        assert "xl/workbook.xml" in names and "xl/worksheets/sheet1.xml" in names, "缺少工作簿/工作表"
        assert "xl/styles.xml" in names, "缺少样式表（表头加粗）"
        xml = re.sub(r"<t[^>]*>", "<t>", z.read("xl/worksheets/sheet1.xml").decode("utf-8"))
        row_count = len(re.findall(r"<row ", xml))
        assert row_count == 40, f"行数应为 40（表头+38 数据+合计），实际 {row_count}"
        assert "<t>类型</t>" in xml and "<t>合计利润</t>" in xml, "表头/合计文本缺失"
        assert "<v>1.02</v>" in xml, "首档卖出价 1.02 缺失"
        assert "<v>10</v>" in xml, "合计利润 10 缺失"
        # v1.3：数字格式 + 冻结首行
        styles = z.read("xl/styles.xml").decode("utf-8")
        assert "0.####" in styles and "#,##0.00" in styles, "缺少数字格式声明"
        assert "<pane " in xml, "缺少冻结首行"


def validate_all_xlsx(path):
    """校验「导出全部品种」工作簿：多工作表 + 汇总表 + 每品种一表（v1.3）"""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        wb = z.read("xl/workbook.xml").decode("utf-8")
        sheet_names = re.findall(r'<sheet name="([^"]+)"', wb)
        assert len(sheet_names) == 5, f"应为 5 个工作表（汇总+4 品种），实际 {len(sheet_names)}：{sheet_names}"
        assert sheet_names[0] == "汇总", f"首个工作表应为「汇总」，实际 {sheet_names[0]}"
        assert "港股红利" in sheet_names, "缺少品种工作表"
        for i in range(1, 6):
            assert f"xl/worksheets/sheet{i}.xml" in names, f"缺少 sheet{i}.xml"
        # 汇总表：表头 + 4 品种 + 合计 = 6 行；每品种表 40 行（表头+38+合计）
        s1 = re.sub(r"<t[^>]*>", "<t>", z.read("xl/worksheets/sheet1.xml").decode("utf-8"))
        assert len(re.findall(r"<row ", s1)) == 6, "汇总表应为 6 行"
        assert "<t>品种</t>" in s1 and "<t>已实现收益率</t>" in s1, "汇总表表头缺失"
        s2 = z.read("xl/worksheets/sheet2.xml").decode("utf-8")
        assert len(re.findall(r"<row ", s2)) == 40, "港股红利表应为 40 行"



def main():
    # 导入预览用的 fixture：2 个品种（含 ledger）
    fixture = {
        "version": 1,
        "varieties": [
            {
                "id": "fx-gg", "name": "港股红利", "code": "159691", "basePrice": 1, "gridStep": 0.02,
                "nets": [{"type": "小网", "startGrid": 0, "endGrid": 5}],
                "journal": {"0:0": {"buyQty": 1000, "sellQty": 500}},
                "ledger": [{"ts": 1700000000000, "rowId": "0:0", "field": "buyQty", "from": 0, "to": 1000}],
            },
            {
                "id": "fx-b", "name": "测试品种B", "code": "", "basePrice": 2, "gridStep": 0.05,
                "nets": [{"type": "小网", "startGrid": 0, "endGrid": 5}],
                "journal": {},
            },
        ],
    }
    fixture_path = SHOTS / "_import_fixture.json"
    fixture_path.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")

    httpd = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 420, "height": 900})
        # FR-10：未登录路径必须零云服务请求。这里把 /api/grid/** 全部拦下来计数并中断，
        # 全程只要有一次就说明「未登录也能用」这条产品原则被破坏了。
        cloud_calls = []
        page.route(
            re.compile(r"/api/grid/"),
            lambda route: (cloud_calls.append(route.request.url), route.abort()),
        )
        page.goto(BASE)

        # ---- 总览：默认 4 品种 ----
        check("总览页 4 个默认品种卡片", lambda: expect(page.locator(".vcard")).to_have_count(4))
        check("未设基准价品种显示「未设置」", lambda: expect(
            page.locator(".vcard", has_text="豆粕ETF").locator(".unset")).to_have_text("未设置"))
        # v1.3：组合汇总卡 + 基准价引导 + 一键导出全部
        check("组合汇总：组合合计利润 ¥10.00", lambda: expect(
            page.locator(".portfolio-card .summary-big")).to_have_text("¥10.00"))
        check("组合汇总：已设基准价 1/4", lambda: expect(
            page.locator(".portfolio-card")).to_contain_text("已设基准价 1/4"))
        check("组合汇总：持仓口径不受基准价门控（500 份）", lambda: expect(
            page.locator(".portfolio-card")).to_contain_text("总持仓 500"))
        check("未设基准价卡片有「设置基准价」引导按钮", lambda: expect(
            page.locator(".vcard", has_text="豆粕ETF").get_by_role("button", name="设置基准价")).to_be_visible())
        # v1.3.1 回归：样式类必须真的落盘（此前 vcard-guide 等只改了 JSX）
        check("引导行不粘连：flex 布局且按钮与文字有间距", lambda: assert_no_stick(
            page, [".vcard-guide"]))
        check("v1.3 新增类名均有 CSS 规则", lambda: assert_styled(
            page, ["portfolio-card", "portfolio-main", "portfolio-actions",
                   "vcard-guide", "invalid-mark", "ledger-tools"]))
        check("滚到底时 ＋ 按钮不再压住卡片按钮", lambda: assert_fab_clear(page))
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(150)
        page.screenshot(path=str(SHOTS / "m1-overview.png"))

        # ---- v1.3 一键导出全部品种（多工作表 XLSX）----
        all_xlsx = SHOTS / "_export_all.xlsx"
        with page.expect_download() as all_dl:
            page.get_by_role("button", name="全部 XLSX").click()
        all_dl.value.save_as(str(all_xlsx))
        check("一键导出全部品种：多工作表 XLSX（汇总+4 品种）", lambda: validate_all_xlsx(all_xlsx))


        # ---- 进入港股红利 ----
        page.locator(".vcard", has_text="港股红利").click()
        check("合计利润 ¥10.00（GT-03）", lambda: expect(page.locator(".summary-big")).to_have_text("¥10.00"))
        rows = page.locator(".row-item")
        check("38 个档位卡（GT-01）", lambda: expect(rows).to_have_count(38))

        r0 = rows.nth(0)
        check("首档行买 1 / 卖 1.02（GT-02）", lambda: (
            expect(r0.locator(".p-buy")).to_have_text("1"),
            expect(r0.locator(".p-sell")).to_have_text("1.02"),
        ))
        r0.locator(".row-head").click()
        check("展开行明细：买入金额 1,000.00 / 利润 10.00 / 剩余 500", lambda: (
            expect(r0.locator(".row-detail")).to_contain_text("1,000.00"),
            expect(r0.locator(".row-detail")).to_contain_text("10.00"),
            expect(r0.locator(".row-detail")).to_contain_text("500"),
        ))
        check("锚点行共 7 个 ⚓（GT-02）", lambda: expect(page.locator(".anchor-mark")).to_have_count(7))
        r8 = rows.nth(6)
        check("10% 档中网锚点行卖出价回到基准价 1", lambda: expect(r8.locator(".p-sell")).to_have_text("1"))
        page.screenshot(path=str(SHOTS / "m2-workbench.png"))

        # ---- FR-06 P2 真实 XLSX 导出（依赖无关生成器，zipfile 校验）----
        xlsx_path = SHOTS / "_export.xlsx"
        with page.expect_download() as dl_info:
            page.locator(".btn-mini", has_text="XLSX").click()
        dl_info.value.save_as(str(xlsx_path))
        check("FR-06 P2 XLSX 导出：可被 Excel 解析、数据正确", lambda: validate_xlsx(xlsx_path))

        # ---- 录入（QtyChip）----
        r1 = rows.nth(1)
        buy_chip = r1.locator(".q-buy .qty-chip")
        sell_chip = r1.locator(".q-sell .qty-chip")
        buy_chip.click()
        r1.locator(".qty-input").wait_for(state="visible")
        r1.locator(".qty-input").fill("1000")
        r1.locator(".qty-input").press("Enter")
        r1.locator(".row-head").click()  # 展开
        check("买 1000 @0.98 → 买入金额 980.00", lambda: expect(
            r1.locator(".row-detail")).to_contain_text("980.00"))
        check("合计利润不变 ¥10.00", lambda: expect(page.locator(".summary-big")).to_have_text("¥10.00"))

        sell_chip.click()
        r1.locator(".qty-input").fill("1000")
        r1.locator(".qty-input").press("Enter")
        check("卖 1000 → 合计 ¥30.00", lambda: expect(page.locator(".summary-big")).to_have_text("¥30.00"))

        # 超卖软警告
        sell_chip.click()
        r1.locator(".qty-input").fill("2000")
        r1.locator(".qty-input").press("Enter")
        check("超卖：行卡黄色描边 + ⚠（BR-08 软警告）", lambda: (
            expect(r1.locator(".warn-mark")).to_be_visible(),
            expect(page.locator(".row-item.oversell")).to_have_count(1),
        ))
        # 清空恢复
        sell_chip.click()
        r1.locator(".qty-input").fill("")
        r1.locator(".qty-input").press("Enter")
        buy_chip.click()
        r1.locator(".qty-input").fill("")
        r1.locator(".qty-input").press("Enter")
        check("清空后回到 ¥10.00", lambda: expect(page.locator(".summary-big")).to_have_text("¥10.00"))

        # 非法输入：应用行为 = 拒绝入库 + 保持编辑态（闪红提示），Escape 退出
        buy_chip.click()
        r1.locator(".qty-input").fill("abc")
        r1.locator(".qty-input").press("Enter")
        check("非法输入被拒绝（abc 未入库）", lambda: (
            expect(r1.locator(".q-buy .qty-edit input.qty-input")).to_have_value("abc"),
            expect(page.locator(".summary-big")).to_have_text("¥10.00"),
        ))
        r1.locator(".qty-input").press("Escape")
        check("Escape 退出编辑态", lambda: expect(
            r1.locator(".q-buy .qty-chip")).to_be_visible())

        # ---- FR-08 交易流水：5 条变更 ----
        page.locator(".chip", has_text="流水").click()
        check("交易流水记录 5 条变更（FR-08）", lambda: expect(
            page.locator(".ledger-item")).to_have_count(5))
        # v1.3：撤销上一条（追加反向流水，历史只增不删）
        page.get_by_role("button", name="撤销上一条").click()
        check("撤销上一条 → 流水增至 6 条且含反向标记", lambda: (
            expect(page.locator(".ledger-item")).to_have_count(6),
            expect(page.locator(".ledger-item.revert")).to_have_count(1),
        ))
        # v1.3.1 回归：Sheet 内的工具栏同样不能粘连；反向条必须有可见底色
        check("流水工具栏不粘连：flex 布局且按钮与文字有间距", lambda: assert_no_stick(
            page, [".ledger-tools"]))
        check("反向流水条已应用样式（问题：仅有类名、无 CSS 规则）", lambda: _assert_revert_bg(page))
        check("撤销后账面回退（合计仍 ¥10.00）", lambda: expect(
            page.locator(".summary-big")).to_have_text("¥10.00"))
        page.screenshot(path=str(SHOTS / "m3-ledger.png"))
        page.locator(".sheet-head .icon-btn").click()

        # ---- FR-11 触发累加（网格重复触发：买1 一阵子后又触发买1，继续增加）----
        r2 = rows.nth(2)
        buy2 = r2.locator(".q-buy")
        add2 = buy2.locator(".qty-add")
        chip2 = buy2.locator(".qty-chip")

        check("FR-11 档位行渲染「＋」累加按钮", lambda: expect(add2).to_be_visible())
        check("FR-11「＋」是有尺寸的点按目标（≥30px，非默认 inline）", lambda: assert_add_btn_sized(page))
        check("FR-11 新增类名均有 CSS 规则", lambda: assert_styled(page, [
            "qty-wrap", "qty-add", "trigger-card", "trigger-quick",
            "trigger-hist-row", "trigger-mode", "trigger-label", "toast-row"]))
        check("FR-11 档位行无横向溢出（「＋」未挤爆行宽）", lambda: assert_row_fits(page))

        # 首次触发该档：没有历史 → 点「＋」必须要求手输，而不是默默加上一个猜的值
        add2.click()
        check("FR-11 无触发历史时点「＋」打开「记一笔触发」面板", lambda: expect(
            page.locator(".sheet-head h3")).to_have_text("记一笔买入触发"))
        check("FR-11 面板上下文带出网/档位/买价", lambda: expect(
            page.locator(".trigger-sub")).to_contain_text("买价 0.96"))
        page.get_by_role("button", name="＋1", exact=True).click()
        page.get_by_role("button", name="＋1", exact=True).click()
        check("FR-11 快捷叠加把本次量累到 2", lambda: expect(
            page.locator(".sheet .input")).to_have_value("2"))
        check("FR-11「累加后」实时预览 = 当前 0 + 本次 2", lambda: expect(
            page.locator(".trigger-card").nth(1)).to_contain_text("2"))
        page.get_by_role("button", name=re.compile("确认累加")).click()
        check("FR-11 累加后 Chip 显示 2", lambda: expect(chip2).to_have_text("2"))
        check("FR-11 累加提示带「撤销」入口", lambda: expect(
            page.locator(".toast .link-btn")).to_have_text("撤销"))

        # 再次触发同一档：这次有历史，点「＋」应一步到位，不再弹面板
        add2.click()
        check("FR-11 已有历史后点「＋」直接累加（2 → 4）且不弹面板", lambda: (
            expect(chip2).to_have_text("4"),
            expect(page.locator(".sheet")).to_have_count(0),
        ))
        check("FR-11 累加提示写明本次量与累计结果", lambda: expect(
            page.locator(".toast")).to_contain_text("＋2 → 累计 4"))
        page.locator(".toast .link-btn").click()
        check("FR-11 从提示撤销累加 → 回到 2（流水只增不删）", lambda: expect(
            chip2).to_have_text("2"))

        # 长按「＋」= 填自定义本次量；面板预填上次触发量，历史区分「触发累加 / 直接设值」
        long_press(page, add2)
        check("FR-11 长按「＋」打开面板并预填上次触发量 2", lambda: expect(
            page.locator(".sheet .input")).to_have_value("2"))
        check("FR-11 面板历史把累加标为「触发累加」", lambda: expect(
            page.locator(".trigger-hist-row", has_text="触发累加").first).to_be_visible())
        check("FR-11 面板撤销记录已应用底色（问题：仅有类名、无 CSS 规则）",
              lambda: _assert_ctx_bg(page, ".trigger-hist-row.revert"))
        page.get_by_role("button", name="改成直接设值").click()
        check("FR-11 切到「直接设值」→ 主按钮文案随之变化", lambda: expect(
            page.get_by_role("button", name=re.compile("确认设为"))).to_be_visible())
        page.get_by_role("button", name="改回累加录入").click()
        page.get_by_role("button", name=re.compile("确认累加")).click()
        check("FR-11 面板确认累加 → 2 + 2 = 4", lambda: expect(chip2).to_have_text("4"))

        # 展开明细应能看到「上次触发量」（原「已触发」文字标记挪到这里，腾出横向空间）
        r2.locator(".row-head").click()
        check("FR-11 展开明细显示「上次触发量」", lambda: expect(
            r2.locator(".row-detail")).to_contain_text("上次触发量"))

        # 还原：该档清回 0，不影响后续用例
        chip2.click()
        r2.locator(".qty-input").fill("")
        r2.locator(".qty-input").press("Enter")
        check("FR-11 清空后回到未录入态", lambda: expect(chip2).to_have_text("＋ 录入"))

        # ---- GT-08 刷新持久化 ----
        page.reload()
        page.locator(".vcard", has_text="港股红利").click()
        check("刷新后数据保留（GT-08）", lambda: expect(page.locator(".summary-big")).to_have_text("¥10.00"))

        # ---- GT-05 基准价 2 ----
        bp = page.locator(".bp-input")
        bp.click()
        bp.fill("2")
        bp.press("Enter")
        check("基准价 2 → ¥20.00、首档卖价 2.04（GT-05）", lambda: (
            expect(page.locator(".summary-big")).to_have_text("¥20.00"),
            expect(rows.nth(0).locator(".p-sell")).to_have_text("2.04"),
        ))
        bp.click()
        bp.fill("1")
        bp.press("Enter")

        # ---- P2 当前价标注 ----
        page.locator(".chip", has_text="当前价").click()
        page.locator(".sheet .input").fill("0.99")
        page.get_by_role("button", name="确定").click()
        check("当前价 0.99：买入已触发 1 档 / 可卖出 34 档（P2）", lambda: (
            expect(page.locator(".qty-add.qty-add-buy.pending")).to_have_count(1),
            expect(page.locator(".qty-add.qty-add-sell.pending")).to_have_count(34),
        ))
        # FR-11：只读的「已触发」文字标记已升级为可点击的琥珀色「＋」，必须验证真着色
        check("待记账「＋」是琥珀色而非仅挂类名（FR-11）", lambda: assert_pending_amber(page))
        page.screenshot(path=str(SHOTS / "m4-price-mark.png"))
        page.locator(".chip", has_text="当前价").click()
        page.get_by_role("button", name="清除标注").click()
        check("清除标注后无待记账标记", lambda: (
            expect(page.locator(".qty-add.pending")).to_have_count(0),
        ))

        # ---- FR-09 自动行情（route 拦截模拟行情源，验证解析+标注+持久化）----
        page.route("**/fr09-quote**", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"price": 0.99})))
        page.get_by_role("button", name="配置").click()
        page.locator(".field", has_text="行情源 URL").locator("input").fill("https://example.com/fr09-quote")
        page.get_by_role("button", name="保存").click()
        check("FR-09 行情按钮出现（已配置 URL）", lambda: expect(
            page.locator(".chip", has_text="行情")).to_be_visible())
        page.locator(".chip", has_text="行情").click()
        page.wait_for_timeout(600)
        check("FR-09 自动行情：价格 0.99 → 已触发 1 / 可卖出 34", lambda: (
            expect(page.locator(".qty-add.qty-add-buy.pending")).to_have_count(1),
            expect(page.locator(".qty-add.qty-add-sell.pending")).to_have_count(34),
        ))
        check("FR-09 行情时间戳显示", lambda: expect(
            page.locator(".muted.small", has_text="行情于")).to_be_visible())
        page.reload()
        page.locator(".vcard", has_text="港股红利").click()
        check("FR-09 lastPrice 持久化：刷新后仍有行情时间戳", lambda: expect(
            page.locator(".muted.small", has_text="行情于")).to_be_visible())
        # 清理：关掉行情源 + 清当前价
        page.get_by_role("button", name="配置").click()
        page.locator(".field", has_text="行情源 URL").locator("input").fill("")
        page.get_by_role("button", name="保存").click()
        page.locator(".chip", has_text="当前价").click()
        page.get_by_role("button", name="清除标注").click()

        # ---- 分段筛选 ----
        page.locator(".seg-item", has_text="中网").click()
        check("筛选中网 → 20 档", lambda: expect(page.locator(".row-item")).to_have_count(20))
        page.locator(".seg-item", has_text="全部").click()
        check("恢复全部 → 38 档", lambda: expect(page.locator(".row-item")).to_have_count(38))

        # ---- 配置页 ----
        page.get_by_role("button", name="配置").click()
        check("配置页 8 个网卡片", lambda: expect(page.locator(".net-item")).to_have_count(8))
        page.locator(".group-head-row button", has_text="展开").click()
        check("预览展开 38 行", lambda: expect(page.locator(".preview-row")).to_have_count(38))
        n2_start = page.locator(".net-item").nth(1).locator("input").nth(0)
        n2_start.fill("3")
        n2_start.blur()
        check("网重叠出现校验错误（BR-10）", lambda: expect(
            page.locator(".field-error").first).to_be_visible())
        # v1.3：档位越界软警告（步长 5% × 30 档 = 150% → 买入价 ≤ 0）
        step_input = page.locator(".field", has_text="网格步长").locator("input")
        step_input.fill("5")
        step_input.blur()
        check("档位越界软警告出现（不阻断保存）", lambda: expect(
            page.locator(".banner-warn")).to_contain_text("≥100%"))
        page.screenshot(path=str(SHOTS / "m5-config.png"))
        page.get_by_role("button", name="返回").click()  # 返回（放弃修改）

        # ---- GT-07 新建自定义品种 ----
        page.get_by_role("button", name="返回").click()  # 返回总览
        page.locator(".fab").click()
        page.get_by_placeholder("如：创业板ETF").fill("测试品种A")
        page.locator(".sheet .field", has_text="基准价").locator("input").fill("1")
        page.locator(".sheet .field", has_text="网格步长").locator("input").fill("1")
        page.get_by_role("button", name="创建", exact=True).click()
        # 配置页：添加中网 5-10 锚点 0
        page.get_by_role("button", name="＋ 添加网").click()
        n2 = page.locator(".net-item").nth(1)
        n2.locator("input").nth(0).fill("5")
        n2.locator("input").nth(1).fill("10")
        page.get_by_role("button", name="保存").click()
        check("GT-07 自定义品种 12 行（边界共享）", lambda: expect(page.locator(".row-item")).to_have_count(12))
        check("GT-07 中网锚点行卖价 = 基准价 1", lambda: expect(
            page.locator(".row-item").nth(6).locator(".p-sell")).to_have_text("1"))

        # ---- 删除品种（名称确认）----
        page.get_by_role("button", name="返回").click()
        ta = page.locator(".vcard", has_text="测试品种A")
        ta.locator(".icon-btn").click()
        page.locator(".action-item", has_text="删除品种").click()
        page.locator(".dialog .input").fill("测试品种A")
        page.get_by_role("button", name="确认删除").click()
        check("删除后卡片消失", lambda: expect(page.locator(".vcard", has_text="测试品种A")).to_have_count(0))

        # ---- FR-06 导入预览确认 ----
        page.locator(".tab-item", has_text="设置").click()
        check("设置页显示本地存储占用（NFR-05）", lambda: expect(
            page.locator(".cell", has_text="本地存储占用")).to_be_visible())

        # ---- FR-10 账号区块：未登录路径必须完好（功能照旧 + 零请求）----
        check("设置页有「账号与云备份」区块", lambda: expect(
            page.locator(".group-block", has_text="账号与云备份")).to_be_visible())
        check("未登录时显示「未登录 / 仅本机保存」", lambda: (
            expect(page.locator(".group-block", has_text="账号与云备份")).to_contain_text("未登录"),
            expect(page.locator(".group-block", has_text="账号与云备份")).to_contain_text("仅本机保存"),
        ))
        check("账号区块新类名均有 CSS 规则", lambda: assert_styled(
            page, ["auth-card", "auth-msg", "diag", "auth-foot", "link-btn", "auth-actions-col"]))
        # 未登录时不得出现任何「已登录才该有」的入口（否则等于半个登录墙）
        check("未登录时不显示同步状态/删除云端入口", lambda: (
            expect(page.locator(".cell", has_text="同步状态")).to_have_count(0),
            expect(page.locator(".cell", has_text="删除云端数据")).to_have_count(0),
            expect(page.locator(".cell", has_text="立即同步")).to_have_count(0),
        ))
        page.locator(".cell", has_text="登录 / 注册").click()
        check("登录面板出现（账号名 + 密码 + 找回密码入口）", lambda: (
            expect(page.locator(".sheet").locator(".input").first).to_be_visible(),
            expect(page.locator(".sheet").locator(".input[type=password]")).to_be_visible(),
            expect(page.locator(".sheet").get_by_role("button", name="忘记密码")).to_be_visible(),
        ))
        page.screenshot(path=str(SHOTS / "m8-account-login.png"))
        page.locator(".sheet").get_by_role("button", name="注册新账号", exact=True).click()
        check("注册面板显示账号名与密码", lambda: expect(
            page.locator(".sheet").get_by_role("button", name="注册", exact=True)).to_be_visible())
        # 本地校验：非法账号名不得发请求。
        page.locator(".sheet .input").first.fill("not-an-email")
        page.locator(".sheet").get_by_role("button", name="注册", exact=True).click()
        check("非法账号名被本地拦截", lambda: expect(
            page.locator(".sheet .auth-msg")).to_contain_text("账号名"))
        page.screenshot(path=str(SHOTS / "m8-account-register.png"))
        page.locator(".sheet .icon-btn").click()
        check("关闭面板后回到设置页", lambda: expect(
            page.locator(".cell", has_text="导入数据")).to_be_visible())

        page.locator(".cell", has_text="导入数据").click()
        page.locator("input[type=file]").set_input_files(str(fixture_path))
        check("导入预览列出 2 个品种（FR-06 P1）", lambda: (
            expect(page.locator(".sheet", has_text="确认导入").locator(".cell")).to_have_count(2),
            expect(page.locator(".sheet", has_text="确认导入")).to_contain_text("港股红利"),
            expect(page.locator(".sheet", has_text="确认导入")).to_contain_text("测试品种B"),
        ))
        page.screenshot(path=str(SHOTS / "m6-import-confirm.png"))
        page.get_by_role("button", name="确认导入").click()
        page.locator(".tab-item", has_text="品种").click()
        check("导入后 2 个品种（覆盖）", lambda: expect(page.locator(".vcard")).to_have_count(2))
        check("导入的港股红利数据正确（¥10.00）", lambda: expect(
            page.locator(".vcard", has_text="港股红利").locator(".stat", has_text="合计利润")).to_contain_text("¥10.00"))

        # ---- 恢复默认 ----
        page.locator(".tab-item", has_text="设置").click()
        page.locator(".cell", has_text="恢复默认").click()
        page.get_by_role("button", name="确认恢复").click()
        page.locator(".tab-item", has_text="品种").click()
        check("恢复默认后 4 个品种", lambda: expect(page.locator(".vcard")).to_have_count(4))

        page.screenshot(path=str(SHOTS / "m7-final.png"))

        # ---- FR-10：全程零云服务请求（未登录 = 完全离线可用）----
        check("未登录全流程零云服务请求", lambda: assert_no_cloud_calls(cloud_calls))

        browser.close()
    httpd.shutdown()

    fails = [r for r in results if r[0] == "FAIL"]
    print(f"\n===== 冒烟测试结果: {len(results) - len(fails)}/{len(results)} 通过 =====")
    for f in fails:
        print("  FAIL:", f[1])
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
