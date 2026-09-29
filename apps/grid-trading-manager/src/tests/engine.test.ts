// 验收测试 —— 覆盖 PRD 第 10 章 GT-01 ~ GT-10（引擎相关全部用例）
// 价格期望值来自 PRD 附录 A（脚本从源表格逐格提取并验证，基准价=1）

import { describe, expect, it } from 'vitest';
import { cloneSeed } from '../engine/seed';
import { computePortfolio, computeSummary, expandRows, orphanJournalIds, stepToBp } from '../engine/engine';
import { addJournalQty, applyJournalChange, buildTriggerDeltas, revertLastChange, triggerHistory, triggerKey } from '../engine/journal';
import { netWarnings, validateNets, validateVarietyBase } from '../engine/validation';
import { parseImport, loadData, saveData, STORAGE_KEY } from '../storage';
import type { AppData, Variety, Net } from '../engine/types';

/** [档数, 买入价U4, 卖出价U4]（基准价=1） */
type Exp = [number, number, number];

const GGXHL: Exp[] = [
  [0, 10000, 10200], [1, 9800, 10000], [2, 9600, 9800], [3, 9400, 9600], [4, 9200, 9400], [5, 9000, 9200],
  [5, 9000, 10000], [6, 8800, 9000], [7, 8600, 8800], [8, 8400, 8600], [9, 8200, 8400], [10, 8000, 8200],
  [10, 8000, 9000], [11, 7800, 8000], [12, 7600, 7800], [13, 7400, 7600], [14, 7200, 7400], [15, 7000, 7200],
  [15, 7000, 8000],
  [15, 7000, 10000], [16, 6800, 7000], [17, 6600, 6800], [18, 6400, 6600], [19, 6200, 6400], [20, 6000, 6200],
  [21, 5800, 6000], [22, 5600, 5800], [23, 5400, 5600], [24, 5200, 5400], [25, 5000, 5200],
  [25, 5000, 7000], [26, 4800, 5000], [27, 4600, 4800], [28, 4400, 4600], [29, 4200, 4400], [30, 4000, 4200],
  [30, 4000, 5000],
  [30, 4000, 7000],
];

const DOUBA: Exp[] = [
  [0, 10000, 10300], [1, 9700, 10000], [2, 9400, 9700], [3, 9100, 9400], [4, 8800, 9100], [5, 8500, 8800],
  [5, 8500, 10000], [6, 8200, 8500], [7, 7900, 8200], [8, 7600, 7900], [9, 7300, 7600], [10, 7000, 7300],
  [10, 7000, 8500],
  [10, 7000, 10000], [11, 6700, 7000], [12, 6400, 6700], [13, 6100, 6400], [14, 5800, 6100], [15, 5500, 5800],
  [15, 5500, 7000], [16, 5200, 5500], [17, 4900, 5200], [18, 4600, 4900], [19, 4300, 4600], [20, 4000, 4300],
  [20, 4000, 5500],
  [20, 4000, 7000],
];

const XIAOFEI: Exp[] = [
  [0, 10000, 10400], [1, 9600, 10000], [2, 9200, 9600], [3, 8800, 9200], [4, 8400, 8800], [5, 8000, 8400],
  [5, 8000, 10000], [6, 7600, 8000], [7, 7200, 7600], [8, 6800, 7200], [9, 6400, 6800], [10, 6000, 6400],
  [10, 6000, 8000], [11, 5600, 6000], [12, 5200, 5600], [13, 4800, 5200], [14, 4400, 4800], [15, 4000, 4400],
  [15, 4000, 6000],
  [15, 4000, 10000],
];

const HENGSHENG: Exp[] = [
  [0, 10000, 10500], [1, 9500, 10000], [2, 9000, 9500], [3, 8500, 9000], [4, 8000, 8500], [5, 7500, 8000],
  [5, 7500, 10000], [6, 7000, 7500], [7, 6500, 7000], [8, 6000, 6500], [9, 5500, 6000], [10, 5000, 5500],
  [10, 5000, 7500], [11, 4500, 5000], [12, 4000, 4500], [13, 3500, 4000], [14, 3000, 3500], [15, 2500, 3000],
  [15, 2500, 5000],
  [15, 2500, 10000], [16, 2000, 2500],
];

function withBase(v: Variety, base: number | null): Variety {
  return { ...v, basePrice: base };
}

function priceTable(rows: ReturnType<typeof expandRows>): Exp[] {
  return rows.map((r) => [r.gridIndex, r.buyU4 as number, r.sellU4 as number] as Exp);
}

function findSeed(seed: ReturnType<typeof cloneSeed>, name: string): Variety {
  const v = seed.varieties.find((x) => x.name === name);
  if (!v) throw new Error('seed missing ' + name);
  return v;
}

describe('GT-01 港股红利默认展开', () => {
  const v = withBase(findSeed(cloneSeed(), '港股红利'), 1);
  const rows = expandRows(v);
  it('共 38 行，8 个网行数 6/6/6/1/11/6/1/1，类型序列正确', () => {
    expect(rows.length).toBe(38);
    const counts: number[] = [];
    const types: string[] = [];
    let cur = -1;
    for (const r of rows) {
      if (r.netIndex !== cur) { cur = r.netIndex; counts.push(0); types.push(r.netType); }
      counts[counts.length - 1]++;
    }
    expect(counts).toEqual([6, 6, 6, 1, 11, 6, 1, 1]);
    expect(types).toEqual(['小网', '中网', '中网', '中网', '大网', '中网', '中网', '大网']);
  });
  it('全部价格与源表格逐格一致（附录 A 全表对齐）', () => {
    expect(priceTable(rows)).toEqual(GGXHL);
  });
  it('锚点行标记正确', () => {
    const anchors = rows.filter((r) => r.sellRule === 'anchor').map((r) => r.rowId);
    expect(anchors).toEqual(['1:5', '2:10', '3:15', '4:15', '5:25', '6:30', '7:30']);
    expect(rows[0].sellRule).toBe('first');
  });
});

describe('其余三品种全表对齐（GT-01/02 扩展）', () => {
  it('豆粕ETF 27 行价格全部一致', () => {
    const rows = expandRows(withBase(findSeed(cloneSeed(), '豆粕ETF'), 1));
    expect(rows.length).toBe(27);
    expect(priceTable(rows)).toEqual(DOUBA);
  });
  it('消费ETF 20 行价格全部一致', () => {
    const rows = expandRows(withBase(findSeed(cloneSeed(), '消费ETF'), 1));
    expect(rows.length).toBe(20);
    expect(priceTable(rows)).toEqual(XIAOFEI);
  });
  it('恒生科技 21 行价格全部一致', () => {
    const rows = expandRows(withBase(findSeed(cloneSeed(), '恒生科技'), 1));
    expect(rows.length).toBe(21);
    expect(priceTable(rows)).toEqual(HENGSHENG);
  });
});

describe('GT-03 金标准：与源表缓存值完全一致', () => {
  const v = findSeed(cloneSeed(), '港股红利'); // basePrice=1, D2=1000, G2=500
  const rows = expandRows(v);
  const r0 = rows[0];
  it('E2=1000, H2=510, I2=10, J2=500', () => {
    expect(r0.buyAmountH8).toBe(1_000_000_000_00n);   // 1000 元（H8=1e-8元）
    expect(r0.sellAmountH8).toBe(510_000_000_00n);    // 510 元
    expect(r0.profitH8).toBe(10_000_000_00n);         // 10 元
    expect(r0.remainingQ4).toBe(5_000_000);           // 500 份（Q4=1e-4份）
    expect(r0.buyU4).toBe(10000);
    expect(r0.sellU4).toBe(10200);
  });
  it('K2 合计利润 = 10 元', () => {
    const s = computeSummary(rows);
    expect(s.totalProfitH8).toBe(10_000_000_00n);
  });
});

describe('GT-04 基准价未填', () => {
  const rows = expandRows(findSeed(cloneSeed(), '豆粕ETF'));
  it('价格/金额/利润为 null，数量正常', () => {
    expect(rows[0].buyU4).toBeNull();
    expect(rows[0].sellU4).toBeNull();
    expect(rows[0].buyAmountH8).toBeNull();
    expect(rows[0].profitH8).toBeNull();
    expect(rows[0].remainingQ4).toBe(0);
    const s = computeSummary(rows);
    expect(s.totalProfitH8).toBeNull();
    expect(s.profitRate).toBeNull();
  });
  it('v1.3 修正：未设基准价时「剩余持仓」仍须求和（BR-06：剩余=买量−卖量，与价格无关）', () => {
    const v = withBase(findSeed(cloneSeed(), '豆粕ETF'), null);
    v.journal['0:0'] = { buyQty: 1000, sellQty: 400 };
    v.journal['0:1'] = { buyQty: 200, sellQty: 0 };
    const s = computeSummary(expandRows(v));
    expect(s.totalRemainingQ4).toBe(800 * 10000); // 1000−400+200 = 800 份（Q4）
    expect(s.totalProfitH8).toBeNull();           // 价格类指标仍为 null
    expect(s.totalBuyH8).toBeNull();
  });
});

describe('v1.3 组合汇总 computePortfolio（跨品种）', () => {
  it('仅已设基准价的品种计入金额类指标；持仓始终计入', () => {
    const p = computePortfolio(cloneSeed().varieties);
    expect(p.count).toBe(4);
    expect(p.withBase).toBe(1);                 // 仅港股红利有基准价
    expect(p.totalProfitH8).toBe(10_000_000_00n); // 港股红利 10 元
    expect(p.totalBuyH8).toBe(1_000_000_000_00n); // 1000 元
    expect(p.totalRemainingQ4).toBe(500 * 10000);
    expect(p.profitRate).toBeCloseTo(0.01, 10);
  });
  it('全部未设基准价 → 金额类为 null，持仓仍为数值', () => {
    const vs = cloneSeed().varieties.map((v) => ({ ...v, basePrice: null, journal: { '0:0': { buyQty: 100, sellQty: 30 } } }));
    const p = computePortfolio(vs);
    expect(p.withBase).toBe(0);
    expect(p.totalProfitH8).toBeNull();
    expect(p.totalBuyH8).toBeNull();
    expect(p.totalRemainingQ4).toBe(70 * 10000 * 4);
  });
});

describe('v1.3 档位越界软警告 netWarnings（不阻断保存）', () => {
  it('档位 ≥ 100% 触发；正常结构不触发', () => {
    const step5 = 500; // 5%
    expect(netWarnings([{ type: '小网', startGrid: 0, endGrid: 19 }], step5)).toEqual([]); // 95% 正常
    const w = netWarnings([{ type: '小网', startGrid: 0, endGrid: 20 }], step5); // 100% 越界
    expect(w.length).toBe(1);
    expect(w[0].netIndex).toBe(0);
    expect(w[0].message).toContain('≥100%');
    // 港股红利默认（2% 步长，最深 30 档 = 60%）不应告警
    expect(netWarnings(findSeed(cloneSeed(), '港股红利').nets, 200)).toEqual([]);
  });
  it('越界行的展开结果带 priceInvalid 标记', () => {
    const v: Variety = {
      id: 'x', name: '越界', code: '', basePrice: 1, gridStep: 0.05,
      nets: [{ type: '小网', startGrid: 0, endGrid: 21 }], journal: {},
    };
    const rows = expandRows(v);
    expect(rows.find((r) => r.gridIndex === 19)!.priceInvalid).toBe(false); // 95% → 买价 0.05
    expect(rows.find((r) => r.gridIndex === 20)!.priceInvalid).toBe(true);  // 100% → 买价 0
    expect(rows.find((r) => r.gridIndex === 21)!.priceInvalid).toBe(true);  // 105% → 买价 < 0
  });
});

describe('v1.3 撤销上一条录入 revertLastChange（流水只增不删）', () => {
  it('撤销 = 恢复旧值 + 追加一条反向流水', () => {
    let v = findSeed(cloneSeed(), '港股红利');
    v = applyJournalChange(v, '0:1', 'buyQty', 1000);
    const before = computeSummary(expandRows(v)).totalBuyH8;
    expect(before).toBe(198_000_000_000n);

    const r = revertLastChange(v);
    expect(r.entry).not.toBeNull();
    expect(r.entry!.revert).toBe(true);
    expect(r.entry!.from).toBe(1000);
    expect(r.entry!.to).toBe(0);
    expect(r.variety.ledger!.length).toBe(2);           // 原条目仍在 + 反向条目
    expect(r.variety.journal['0:1']).toBeUndefined();    // 归零 → 条目删除
    expect(computeSummary(expandRows(r.variety)).totalBuyH8).toBe(100_000_000_000n); // 回到 1000 元
  });
  it('无流水 → empty；其后又被改动 → stale（不误撤）', () => {
    const v0 = findSeed(cloneSeed(), '港股红利');
    expect(revertLastChange(v0).reason).toBe('empty');

    let v = applyJournalChange(v0, '0:1', 'buyQty', 1000);
    v = applyJournalChange(v, '0:1', 'buyQty', 777); // 最新条目 to=777，当前值=777，可撤
    const ok = revertLastChange(v);
    expect(ok.entry).not.toBeNull();
    expect(ok.variety.journal['0:1']).toEqual({ buyQty: 1000, sellQty: 0 });

    // 构造 stale：手工把当前值改成与最新条目 to 不一致
    const stale: Variety = { ...v, journal: { ...v.journal, '0:1': { buyQty: 555, sellQty: 0 } } };
    const res = revertLastChange(stale);
    expect(res.entry).toBeNull();
    expect(res.reason).toBe('stale');
    expect(res.variety).toBe(stale); // 原对象未变
  });
  it('parseImport 保留 revert 标记', () => {
    const text = JSON.stringify({
      version: 1,
      varieties: [{
        id: 'x', name: 'X', code: '', basePrice: 1, gridStep: 0.02,
        nets: [{ type: '小网', startGrid: 0, endGrid: 5 }],
        journal: {},
        ledger: [{ ts: 1, rowId: '0:0', field: 'buyQty', from: 5, to: 0, revert: true }],
      }],
    });
    expect(parseImport(text).varieties[0].ledger![0].revert).toBe(true);
  });
});

describe('GT-05 基准价改为 2：全表价格精确 ×2', () => {
  const rows = expandRows(withBase(findSeed(cloneSeed(), '港股红利'), 2));
  it('抽查价格', () => {
    const t = priceTable(rows);
    expect(t[0]).toEqual([0, 20000, 20400]);
    expect(t[6]).toEqual([5, 18000, 20000]);   // 中网锚点行: 卖 2.00（对应源表行8）
    expect(t[19]).toEqual([15, 14000, 20000]); // 大网锚点行（对应源表行21）
  });
  it('行 2 利润 = (2.04−2)×500 = 20 元', () => {
    expect(rows[0].profitH8).toBe(20_000_000_00n);
    expect(computeSummary(rows).totalProfitH8).toBe(20_000_000_00n);
  });
});

describe('GT-07 自定义品种：步长1%，小网0-5档 + 中网5-10档锚点0档', () => {
  const v: Variety = {
    id: 't1', name: '测试', code: '', basePrice: 1, gridStep: 0.01,
    nets: [
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10, anchorGrid: 0 },
    ],
    journal: {},
  };
  const rows = expandRows(v);
  it('展开 12 行（小网6 + 中网6，第 5 档位边界共享两行）', () => {
    expect(rows.length).toBe(12);
    expect(rows.filter((r) => r.gridIndex === 5).length).toBe(2);
  });
  it('中网首行卖价 = 基准价', () => {
    const anchorRow = rows.find((r) => r.sellRule === 'anchor')!;
    expect(anchorRow.sellU4).toBe(10000);
  });
  it('validateNets 通过', () => {
    expect(validateNets(v.nets)).toEqual([]);
  });
});

describe('GT-09 删除网后孤儿 journal 不参与计算', () => {
  const seed = cloneSeed();
  const v = findSeed(seed, '港股红利');
  it('orphanJournalIds 识别 & 计算不受影响', () => {
    const before = computeSummary(expandRows(v)).totalProfitH8;
    // 删除第 1 个网（含 0:0 录入）→ journal 里的 '0:0' 成为孤儿
    const v2: Variety = { ...v, nets: v.nets.slice(1).map((n, i) => ({ ...n })) as Net[] };
    // 注意：删除网后其余网索引变化，原 journal key 全部失配 → 均为孤儿
    const orphans = orphanJournalIds(v2);
    expect(orphans).toContain('0:0');
    const s2 = computeSummary(expandRows(v2));
    expect(s2.totalProfitH8).toBe(0n); // 无任何有效录入
    expect(before).toBe(10_000_000_00n);
  });
});

describe('GT-10 浮点陷阱：step=3%、base=1.23', () => {
  const v: Variety = {
    id: 't2', name: '精度', code: '', basePrice: 1.23, gridStep: 0.03,
    nets: [{ type: '小网', startGrid: 0, endGrid: 10 }],
    journal: {},
  };
  it('30% 档买入价 = 0.8610 整（无浮点尾差）', () => {
    const rows = expandRows(v);
    const r10 = rows.find((r) => r.gridIndex === 10)!;
    expect(r10.buyU4).toBe(8610);
  });
  it('步长基点换算', () => {
    expect(stepToBp(0.03)).toBe(300);
    expect(stepToBp(0.02)).toBe(200);
  });
});

describe('BR-08/BR-10 校验规则', () => {
  it('软警告：卖出数量 > 买入数量', () => {
    const v = findSeed(cloneSeed(), '港股红利');
    v.journal['0:0'] = { buyQty: 100, sellQty: 200 };
    const r0 = expandRows(v)[0];
    expect(r0.oversell).toBe(true);
    expect(r0.remainingQ4).toBe(-1_000_000);
  });
  it('网重叠 / 缺口 / 锚点非法 / 首网非零', () => {
    expect(validateNets([
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 3, endGrid: 10, anchorGrid: 0 },
    ]).some((e) => e.netIndex === 1 && e.field === 'start')).toBe(true);

    expect(validateNets([
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 8, endGrid: 10, anchorGrid: 0 },
    ]).some((e) => e.netIndex === 1 && e.field === 'start')).toBe(true);

    expect(validateNets([
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10, anchorGrid: 7 },
    ]).some((e) => e.netIndex === 1 && e.field === 'anchor')).toBe(true);

    expect(validateNets([
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10 },
    ]).some((e) => e.netIndex === 1 && e.field === 'anchor')).toBe(true);

    expect(validateNets([{ type: '小网', startGrid: 2, endGrid: 5 }]).length).toBeGreaterThan(0);
  });
  it('合法的共享边界通过', () => {
    expect(validateNets([
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10, anchorGrid: 0 },
      { type: '大网', startGrid: 10, endGrid: 12, anchorGrid: 0 },
    ])).toEqual([]);
  });
  it('品种级校验', () => {
    expect(validateVarietyBase({ name: '', code: '', basePrice: null, gridStep: 0.02, existingNames: [] }).length).toBeGreaterThan(0);
    expect(validateVarietyBase({ name: 'A', code: '', basePrice: -1, gridStep: 0.02, existingNames: [] }).length).toBeGreaterThan(0);
    expect(validateVarietyBase({ name: 'A', code: '', basePrice: null, gridStep: 0, existingNames: [] }).length).toBeGreaterThan(0);
    expect(validateVarietyBase({ name: 'A', code: '', basePrice: null, gridStep: 0.02, existingNames: ['B'] })).toEqual([]);
    expect(validateVarietyBase({ name: 'A', code: '', basePrice: null, gridStep: 0.02, existingNames: ['A'] }).length).toBeGreaterThan(0);
  });
});

describe('FR-08 交易流水（applyJournalChange）', () => {
  it('每次变更追加审计条目；D/G 仍是唯一计算真值', () => {
    let v = findSeed(cloneSeed(), '港股红利');
    v = applyJournalChange(v, '0:1', 'buyQty', 1000);
    expect(v.ledger!.length).toBe(1);
    expect(v.ledger![0]).toMatchObject({ rowId: '0:1', field: 'buyQty', from: 0, to: 1000 });
    expect(v.journal['0:1']).toEqual({ buyQty: 1000, sellQty: 0 });
    // 计算只看 journal：0:0 买 1000@1.00 + 0:1 买 1000@0.98 = 1980 元
    expect(computeSummary(expandRows(v)).totalBuyH8).toBe(198_000_000_000n);

    v = applyJournalChange(v, '0:1', 'sellQty', 500);
    expect(v.ledger!.length).toBe(2);
    expect(v.ledger![1]).toMatchObject({ rowId: '0:1', field: 'sellQty', from: 0, to: 500 });

    // 清买入但仍有卖出 → journal 条目保留
    v = applyJournalChange(v, '0:1', 'buyQty', 0);
    expect(v.journal['0:1']).toEqual({ buyQty: 0, sellQty: 500 });
    // 双零 → journal 条目删除，但流水仍记录
    v = applyJournalChange(v, '0:1', 'sellQty', 0);
    expect(v.journal['0:1']).toBeUndefined();
    expect(v.ledger!.length).toBe(4);
    expect(v.ledger![3]).toMatchObject({ field: 'sellQty', from: 500, to: 0 });
  });
  it('值未变化不产生流水', () => {
    const v = findSeed(cloneSeed(), '港股红利');
    const v2 = applyJournalChange(v, '9:9', 'buyQty', 0);
    expect(v2.ledger ?? []).toEqual([]);
    const v3 = applyJournalChange(v, '0:0', 'buyQty', 1000); // 与现值相同
    expect(v3.ledger ?? []).toEqual([]);
    expect(v3.journal['0:0']).toEqual({ buyQty: 1000, sellQty: 500 });
  });
  it('parseImport 保留并清洗 ledger（非法条目丢弃）', () => {
    const text = JSON.stringify({
      version: 1,
      varieties: [{
        id: 'x', name: 'X', code: '', basePrice: 1, gridStep: 0.02,
        nets: [{ type: '小网', startGrid: 0, endGrid: 5 }],
        journal: {},
        ledger: [
          { ts: 123, rowId: '0:0', field: 'sellQty', from: 1, to: 2 },
          { bad: 1 },
          { ts: 5, rowId: '', field: 'buyQty', from: 0, to: 1 },
        ],
      }],
    });
    const d = parseImport(text);
    expect(d.varieties[0].ledger!.length).toBe(1);
    expect(d.varieties[0].ledger![0]).toMatchObject({ ts: 123, rowId: '0:0', field: 'sellQty', to: 2 });
  });
  it('无 ledger 字段的旧数据兼容（默认为空）', () => {
    const text = JSON.stringify({
      version: 1,
      varieties: [{ name: 'Y', nets: [{ type: '小网', startGrid: 0, endGrid: 5 }] }],
    });
    const d = parseImport(text);
    expect(d.varieties[0].ledger).toEqual([]);
  });
});

describe('FR-11 触发累加（addJournalQty / buildTriggerDeltas）', () => {
  it('同一档重复触发：每笔累加到 D 列累计量，流水标明 op=add', () => {
    let v = findSeed(cloneSeed(), '港股红利');
    v = addJournalQty(v, '0:1', 'buyQty', 1);              // 第一次触发 买1
    expect(v.journal['0:1']).toEqual({ buyQty: 1, sellQty: 0 });
    v = addJournalQty(v, '0:1', 'buyQty', 1);              // 一阵子后又触发 买1
    v = addJournalQty(v, '0:1', 'buyQty', 1);
    expect(v.journal['0:1']).toEqual({ buyQty: 3, sellQty: 0 });

    expect(v.ledger!.length).toBe(3);
    expect(v.ledger!.map((e) => e.op)).toEqual(['add', 'add', 'add']);
    expect(v.ledger!.map((e) => [e.from, e.to])).toEqual([[0, 1], [1, 2], [2, 3]]);

    // 计算口径零变化：仍只看 journal 的累计量（D 列）
    const row = expandRows(v).find((r) => r.rowId === '0:1')!;
    expect(row.buyQtyQ4).toBe(3 * 10000);
    expect(row.remainingQ4).toBe(3 * 10000);
  });

  it('小数累加不产生浮点尾差（0.1 × 3 = 0.3，而非 0.30000000000000004）', () => {
    let v = findSeed(cloneSeed(), '港股红利');
    for (let i = 0; i < 3; i++) v = addJournalQty(v, '0:1', 'buyQty', 0.1);
    expect(v.journal['0:1'].buyQty).toBe(0.3);
  });

  it('累加与绝对值录入共用同一套撤销：回退到上一笔的 from', () => {
    let v = findSeed(cloneSeed(), '港股红利');
    v = addJournalQty(v, '0:1', 'buyQty', 2);
    v = addJournalQty(v, '0:1', 'buyQty', 2);
    const r = revertLastChange(v);
    expect(r.entry).not.toBeNull();
    expect(r.entry!.revert).toBe(true);
    expect(r.variety.journal['0:1']).toEqual({ buyQty: 2, sellQty: 0 });
  });

  it('非法累加量抛错（0 / 负数 / NaN）', () => {
    const v = findSeed(cloneSeed(), '港股红利');
    expect(() => addJournalQty(v, '0:1', 'buyQty', 0)).toThrow();
    expect(() => addJournalQty(v, '0:1', 'buyQty', -1)).toThrow();
    expect(() => addJournalQty(v, '0:1', 'buyQty', NaN)).toThrow();
  });

  it('buildTriggerDeltas：取最近一次真实触发量；设值不算触发，撤销不算触发', () => {
    let v = findSeed(cloneSeed(), '港股红利');
    v = addJournalQty(v, '0:1', 'buyQty', 3);
    expect(buildTriggerDeltas(v).get(triggerKey('0:1', 'buyQty'))).toBe(3);
    v = addJournalQty(v, '0:1', 'buyQty', 1);                 // 又触发 +1 → 默认量应变成 1
    expect(buildTriggerDeltas(v).get(triggerKey('0:1', 'buyQty'))).toBe(1);
    v = applyJournalChange(v, '0:1', 'buyQty', 10);           // 直接设值 → 不能冒充触发量
    expect(buildTriggerDeltas(v).get(triggerKey('0:1', 'buyQty'))).toBe(1);
    // 该档只有卖出记录时，买入键不应出现（买卖各自独立）
    v = addJournalQty(v, '0:2', 'sellQty', 4);
    expect(buildTriggerDeltas(v).get(triggerKey('0:2', 'sellQty'))).toBe(4);
    expect(buildTriggerDeltas(v).has(triggerKey('0:2', 'buyQty'))).toBe(false);
  });

  it('旧数据（无 op 字段）退化为「最近一次正向增量」', () => {
    const v: Variety = {
      id: 'k', name: 'K', code: '', basePrice: 1, gridStep: 0.02,
      nets: [{ type: '小网', startGrid: 0, endGrid: 5 }], journal: {},
      ledger: [
        { ts: 1, rowId: '0:1', field: 'buyQty', from: 0, to: 2 },
        { ts: 2, rowId: '0:1', field: 'buyQty', from: 2, to: 5 },   // 最近一次增量 = 3
        { ts: 3, rowId: '0:1', field: 'buyQty', from: 5, to: 1, revert: true },
      ],
    };
    expect(buildTriggerDeltas(v).get(triggerKey('0:1', 'buyQty'))).toBe(3);
  });

  it('parseImport 保留 op（否则云同步/导入会把「累加」洗成「设值」）', () => {
    const text = JSON.stringify({
      version: 1,
      varieties: [{
        id: 'x', name: 'X', code: '', basePrice: 1, gridStep: 0.02,
        nets: [{ type: '小网', startGrid: 0, endGrid: 5 }],
        journal: { '0:1': { buyQty: 2, sellQty: 0 } },
        ledger: [
          { ts: 1, rowId: '0:1', field: 'buyQty', from: 0, to: 1, op: 'add' },
          { ts: 2, rowId: '0:1', field: 'buyQty', from: 1, to: 2, op: 'add' },
          { ts: 3, rowId: '0:1', field: 'buyQty', from: 2, to: 9, op: 'bogus' },
        ],
      }],
    });
    const d = parseImport(text);
    expect(d.varieties[0].ledger!.map((e) => e.op)).toEqual(['add', 'add', undefined]);
    expect(buildTriggerDeltas(d.varieties[0]).get(triggerKey('0:1', 'buyQty'))).toBe(1);
  });

  it('triggerHistory 倒序返回该档该字段的记录，不混入其它档', () => {
    let v = findSeed(cloneSeed(), '港股红利');
    v = addJournalQty(v, '0:1', 'buyQty', 1);
    v = addJournalQty(v, '0:1', 'buyQty', 1);
    v = addJournalQty(v, '0:2', 'buyQty', 5);
    const h = triggerHistory(v, '0:1', 'buyQty', 5);
    expect(h.length).toBe(2);
    expect(h[0].to).toBe(2);   // 最近一条在前
    expect(h[1].to).toBe(1);
  });
});

describe('存储层（FR-06 / NFR-05 / GT-08）', () => {
  function memStore(): { store: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }; backing: Map<string, string> } {
    const backing = new Map<string, string>();
    return { store: { getItem: (k) => backing.get(k) ?? null, setItem: (k, v) => void backing.set(k, v) }, backing };
  }
  it('保存后加载一致（导入归一化：首网 anchorGrid=null）', () => {
    const { store } = memStore();
    const data = cloneSeed();
    saveData(store, data);
    const res = loadData(store);
    expect(res.error).toBeNull();
    // 导入会做归一化：首网 anchorGrid 补 null，FR-09 可选字段补 null
    const normalized: AppData = JSON.parse(JSON.stringify(data));
    normalized.varieties.forEach((x) => {
      x.nets.forEach((n) => { if (n.anchorGrid === undefined) n.anchorGrid = null; });
      if (x.quoteUrl === undefined) x.quoteUrl = null;
      if (x.lastPrice === undefined) x.lastPrice = null;
      if (x.lastPriceAt === undefined) x.lastPriceAt = null;
    });
    expect(res.data).toEqual(normalized);
  });
  it('损坏 JSON → 报错且不抛异常', () => {
    const { store } = memStore();
    store.setItem(STORAGE_KEY, '{not json');
    const res = loadData(store);
    expect(res.data).toBeNull();
    expect(res.error).toBeTruthy();
    expect(res.raw).toBe('{not json');
  });
  it('空存储 → 无错误', () => {
    const { store } = memStore();
    const res = loadData(store);
    expect(res.data).toBeNull();
    expect(res.error).toBeNull();
  });
  it('parseImport 拒绝非法结构', () => {
    expect(() => parseImport('{"version":2}')).toThrow();
    expect(() => parseImport('{"version":1,"varieties":[{"name":"X","nets":[{"type":"小网","startGrid":3,"endGrid":5}]}]}')).toThrow(/档位 0/);
    expect(() => parseImport('{"version":1,"varieties":[{"name":"X","nets":[{"type":"中网","startGrid":0,"endGrid":5},{"type":"中网","startGrid":5,"endGrid":10,"anchorGrid":0}]}]}')).not.toThrow();
  });
});
