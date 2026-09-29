// 默认种子数据 —— 严格转录自《网格交易.xlsx》（PRD 第 6章 / 附录 C）

import { AppData, Variety } from './types';

function v(
  id: string, name: string, code: string, basePrice: number | null, gridStep: number,
  nets: Variety['nets'], journal: Variety['journal'] = {},
): Variety {
  return { id, name, code, basePrice, gridStep, nets, journal, ledger: [] };
}

export const SEED_DATA: AppData = {
  version: 1,
  varieties: [
    // 港股红利(159691)_2%：38 行，8 网，C2=1，D2=1000，G2=500
    v('default-ggxhl', '港股红利', '159691', 1, 0.02, [
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10, anchorGrid: 0 },
      { type: '中网', startGrid: 10, endGrid: 15, anchorGrid: 5 },
      { type: '中网', startGrid: 15, endGrid: 15, anchorGrid: 10 },
      { type: '大网', startGrid: 15, endGrid: 25, anchorGrid: 0 },
      { type: '中网', startGrid: 25, endGrid: 30, anchorGrid: 15 },
      { type: '中网', startGrid: 30, endGrid: 30, anchorGrid: 25 },
      { type: '大网', startGrid: 30, endGrid: 30, anchorGrid: 15 },
    ], { '0:0': { buyQty: 1000, sellQty: 500 } }),
    // 豆粕ETF(159985)_3%：27 行，7 网，基准价未填
    v('default-dm', '豆粕ETF', '159985', null, 0.03, [
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10, anchorGrid: 0 },
      { type: '中网', startGrid: 10, endGrid: 10, anchorGrid: 5 },
      { type: '大网', startGrid: 10, endGrid: 15, anchorGrid: 0 },
      { type: '中网', startGrid: 15, endGrid: 20, anchorGrid: 10 },
      { type: '中网', startGrid: 20, endGrid: 20, anchorGrid: 15 },
      { type: '大网', startGrid: 20, endGrid: 20, anchorGrid: 10 },
    ]),
    // 消费ETF(159928)_4%：20 行，5 网
    v('default-xf', '消费ETF', '159928', null, 0.04, [
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10, anchorGrid: 0 },
      { type: '中网', startGrid: 10, endGrid: 15, anchorGrid: 5 },
      { type: '中网', startGrid: 15, endGrid: 15, anchorGrid: 10 },
      { type: '大网', startGrid: 15, endGrid: 15, anchorGrid: 0 },
    ]),
    // 恒生科技(513130)_5%：21 行，5 网
    v('default-hskj', '恒生科技', '513130', null, 0.05, [
      { type: '小网', startGrid: 0, endGrid: 5 },
      { type: '中网', startGrid: 5, endGrid: 10, anchorGrid: 0 },
      { type: '中网', startGrid: 10, endGrid: 15, anchorGrid: 5 },
      { type: '中网', startGrid: 15, endGrid: 15, anchorGrid: 10 },
      { type: '大网', startGrid: 15, endGrid: 16, anchorGrid: 0 },
    ]),
  ],
};

export function cloneSeed(): AppData {
  return JSON.parse(JSON.stringify(SEED_DATA)) as AppData;
}
