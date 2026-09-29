// 云同步纯逻辑单测（PRD FR-10）
//
// 只测不依赖网络、也不依赖浏览器的部分：
//   1. 数据指纹：稳定 + 对内容敏感（推送去重的依据）
//   2. 云端 payload 校验链路：与「导入文件」必须同一条路径
// 网络与 UI 部分由 smoke_test.py（离线）与线上手工脚本覆盖。

import { describe, expect, it } from 'vitest';
import { hashPayload } from '../cloud/sync';
import { parseAppData, parseImport } from '../storage';
import { cloneSeed } from '../engine/seed';
import type { AppData } from '../engine/types';

const seed = cloneSeed();

describe('hashPayload', () => {
  it('同一份数据多次计算结果一致', () => {
    expect(hashPayload(seed)).toBe(hashPayload(cloneSeed()));
  });

  it('内容变化后指纹变化（推送去重的依据）', () => {
    const changed: AppData = { version: 1, varieties: seed.varieties.map((v, i) => (i === 0 ? { ...v, basePrice: 9.99 } : v)) };
    expect(hashPayload(changed)).not.toBe(hashPayload(seed));
  });

  it('数组顺序变化也算变化（不掩盖差异）', () => {
    const reordered: AppData = { version: 1, varieties: [...seed.varieties].reverse() };
    expect(hashPayload(reordered)).not.toBe(hashPayload(seed));
  });
});

describe('parseAppData（云端 payload 的校验链路）', () => {
  it('接受对象形态（JSONB 从服务端取回就是对象）', () => {
    const out = parseAppData(JSON.parse(JSON.stringify(seed)));
    expect(out.version).toBe(1);
    expect(out.varieties.length).toBe(seed.varieties.length);
  });

  it('与 parseImport 对同一份数据给出等价结果（不出现两套校验）', () => {
    const viaImport = parseImport(JSON.stringify(seed));
    const viaObject = parseAppData(JSON.parse(JSON.stringify(seed)));
    expect(JSON.stringify(viaObject)).toBe(JSON.stringify(viaImport));
  });

  it('字符串形态也能处理（驱动若返回字符串同样接受）', () => {
    expect(parseAppData(JSON.stringify(seed)).varieties.length).toBe(seed.varieties.length);
  });

  it('缺 version / varieties 时报可读错误', () => {
    expect(() => parseAppData({ varieties: [] })).toThrow(/version/);
    expect(() => parseAppData({ version: 1 })).toThrow(/varieties/);
    expect(() => parseAppData(null)).toThrow();
  });

  it('网结构非法时被拦下（BR-10 同样作用于远端数据）', () => {
    const bad = {
      version: 1,
      varieties: [
        {
          id: 'x',
          name: '坏数据',
          code: '',
          basePrice: 1,
          gridStep: 0.02,
          // 同一档位被两个网占用 → 结构非法
          nets: [
            { type: '中网', startGrid: 0, endGrid: 5, anchorGrid: null },
            { type: '大网', startGrid: 2, endGrid: 8, anchorGrid: null },
          ],
          journal: {},
          ledger: [],
        },
      ],
    };
    expect(() => parseAppData(bad)).toThrow();
  });
});
