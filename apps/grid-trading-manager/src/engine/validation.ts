// 网结构校验（PRD BR-10）

import { Net } from './types';
import { fmtPct } from './money';

export interface NetError {
  netIndex: number; // -1 表示整体性错误
  field: 'start' | 'end' | 'anchor' | 'general';
  message: string;
}

export function validateNets(nets: Net[]): NetError[] {
  const errors: NetError[] = [];
  if (!nets || nets.length === 0) {
    return [{ netIndex: -1, field: 'general', message: '至少需要 1 个网' }];
  }

  nets.forEach((net, i) => {
    const idx = (n: number) => !Number.isInteger(n) || n < 0;
    if (idx(net.startGrid)) errors.push({ netIndex: i, field: 'start', message: '起始档数必须为非负整数' });
    if (idx(net.endGrid)) errors.push({ netIndex: i, field: 'end', message: '结束档数必须为非负整数' });
    if (Number.isInteger(net.startGrid) && Number.isInteger(net.endGrid) && net.startGrid > net.endGrid) {
      errors.push({ netIndex: i, field: 'end', message: '结束档数不能小于起始档数' });
    }
  });
  if (errors.length > 0) return errors;

  if (nets[0].startGrid !== 0) {
    errors.push({ netIndex: 0, field: 'start', message: '第一个网必须从档位 0 开始' });
  }

  for (let i = 1; i < nets.length; i++) {
    const prev = nets[i - 1];
    const cur = nets[i];
    if (cur.startGrid < 1) {
      errors.push({ netIndex: i, field: 'start', message: '档位 0 只能出现在第一个网' });
      continue;
    }
    if (cur.startGrid < prev.endGrid) {
      errors.push({ netIndex: i, field: 'start', message: `与前一个网重叠（前网结束于第 ${prev.endGrid} 档）` });
      continue;
    }
    if (cur.startGrid > prev.endGrid + 1) {
      errors.push({ netIndex: i, field: 'start', message: `与前一个网之间存在档位缺口（应从第 ${prev.endGrid} 或 ${prev.endGrid + 1} 档开始）` });
      continue;
    }
    const a = cur.anchorGrid;
    if (a === null || a === undefined || !Number.isInteger(a) || a < 0) {
      errors.push({ netIndex: i, field: 'anchor', message: '锚点档数必须为非负整数' });
    } else if (a >= cur.startGrid) {
      errors.push({ netIndex: i, field: 'anchor', message: `锚点档数必须小于本网起始档数（< ${cur.startGrid}），否则卖出价不高于买入价` });
    }
  }
  return errors;
}

/** 品种级校验（名称唯一性由调用方传入已有名称集合） */
export function validateVarietyBase(input: {
  name: string;
  code: string;
  basePrice: number | null;
  gridStep: number;
  excludeName?: string;
  existingNames: string[];
}): string[] {
  const errors: string[] = [];
  const name = input.name.trim();
  if (!name) errors.push('品种名称不能为空');
  else if (input.existingNames.some((n) => n === name && n !== input.excludeName)) errors.push(`品种名称「${name}」已存在`);
  if (input.gridStep <= 0 || !Number.isFinite(input.gridStep)) errors.push('网格步长必须大于 0');
  else {
    const bp = Math.round(input.gridStep * 10000);
    if (bp < 1) errors.push('网格步长过小（至少 0.01%）');
    if (bp > 10000) errors.push('网格步长不能超过 100%');
  }
  if (input.basePrice !== null && (!Number.isFinite(input.basePrice) || input.basePrice <= 0)) {
    errors.push('基准价必须为正数（留空表示暂不设置）');
  }
  return errors;
}

/**
 * 软警告（不阻断保存，BR-08 同精神）：
 * 档位 ≥ 100%（档数 × 步长 ≥ 100%）时买入价 ≤ 0，源表格未定义此情形，
 * 属配置越界提示——由 UI 警示并允许用户继续（自行确认是否合理）。
 */
export function netWarnings(nets: Net[], stepBp: number): NetError[] {
  const out: NetError[] = [];
  nets.forEach((n, i) => {
    if (!Number.isInteger(n.endGrid) || n.endGrid < 0) return;
    const endBp = n.endGrid * stepBp;
    if (endBp >= 10000) {
      out.push({
        netIndex: i,
        field: 'end',
        message: `结束档位已达 ${fmtPct(endBp)}（≥100%），买入价将 ≤ 0；请缩小结束档数或步长`,
      });
    }
  });
  return out;
}
