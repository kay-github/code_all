// 数据持久化（PRD FR-06 / NFR-05）
// P0: localStorage 自动保存；P1: JSON 导入导出

import { AppData, JournalEntry, LedgerEntry, Net, NetType, Variety } from './engine/types';
import { validateNets } from './engine/validation';

export const STORAGE_KEY = 'grid-trading-manager:v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LoadResult {
  data: AppData | null;
  raw: string | null;   // 解析失败时保留原文，供用户导出抢救（NFR-05）
  error: string | null;
}

export function loadData(store: StorageLike, key = STORAGE_KEY): LoadResult {
  let raw: string | null = null;
  try {
    raw = store.getItem(key);
  } catch {
    return { data: null, raw: null, error: '无法读取本地存储（浏览器隐私模式或权限受限）' };
  }
  if (!raw) return { data: null, raw: null, error: null };
  try {
    const data = parseImport(raw);
    return { data, raw, error: null };
  } catch (e) {
    return { data: null, raw, error: e instanceof Error ? e.message : '本地数据损坏' };
  }
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

/**
 * 写入本地存储。
 * 失败原因：配额已满（QuotaExceededError）或隐私模式禁用 —— 按 NFR-05 要求由调用方**显式提示**，
 * 不再静默吞掉（否则用户以为已保存，刷新后数据丢失）。
 */
export function saveData(store: StorageLike, data: AppData, key = STORAGE_KEY): SaveResult {
  try {
    store.setItem(key, JSON.stringify(data));
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const quota = /quota|exceed/i.test(msg);
    return { ok: false, error: quota ? '本地存储空间已满，最近改动未能保存（请导出备份后清理）' : '本地存储不可写（可能处于隐私模式）' };
  }
}

/** 当前本地存储占用（含全部键），返回字节数；不可用时返回 null */
export function storageBytes(store: StorageLike): number | null {
  try {
    const s = store as StorageLike & { length: number; key: (i: number) => string | null };
    if (typeof s.length !== 'number' || typeof s.key !== 'function') {
      return (store.getItem(STORAGE_KEY) ?? '').length * 2; // UTF-16 双字节近似
    }
    let total = 0;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k == null) continue;
      total += (k.length + (s.getItem(k) ?? '').length) * 2;
    }
    return total;
  } catch {
    return null;
  }
}

/** 导入解析：结构校验 + 网结构校验（BR-10），不合法时抛出可读错误 */
export function parseImport(text: string): AppData {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  return parseAppData(obj);
}

/**
 * 结构校验（不含 JSON 文本解析）。
 *
 * 抽出来是为了让**云端拉取**复用同一条校验链路：远端 payload 本质上和「用户导入的文件」
 * 一样都是不可信输入，走同一个函数就不会出现「本地一套校验、云端另一套校验」的漂移。
 * `payload` 是 JSONB，正常已是对象；若驱动给了字符串也同样接受。
 */
export function parseAppData(obj: unknown): AppData {
  if (typeof obj === 'string') return parseImport(obj);
  const o = obj as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.version !== 1 || !Array.isArray(o.varieties)) {
    throw new Error('数据结构不符（缺少 version:1 或 varieties 数组）');
  }
  const varieties = (o.varieties as Record<string, unknown>[]).map((raw): Variety => {
    if (!raw || typeof raw !== 'object') throw new Error('varieties 中存在非法条目');
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!name) throw new Error('存在缺少名称的品种');
    const netsRaw = Array.isArray(raw.nets) ? raw.nets : [];
    const nets = netsRaw.map((n): Net => {
      const x = n as Record<string, unknown>;
      const type = (['小网', '中网', '大网'] as NetType[]).includes(x.type as NetType)
        ? (x.type as NetType) : '中网';
      return {
        type,
        startGrid: Number(x.startGrid) || 0,
        endGrid: Number(x.endGrid) || 0,
        anchorGrid: x.anchorGrid === null || x.anchorGrid === undefined ? null : Number(x.anchorGrid),
      };
    });
    const netErrors = validateNets(nets);
    if (netErrors.length > 0) {
      throw new Error(`品种「${name}」的网结构非法：${netErrors[0].message}`);
    }
    const journalRaw = (raw.journal && typeof raw.journal === 'object' ? raw.journal : {}) as Record<string, unknown>;
    const journal: Record<string, JournalEntry> = {};
    for (const [k, val] of Object.entries(journalRaw)) {
      const e = val as Record<string, unknown>;
      journal[k] = {
        buyQty: sanitizeQty(e?.buyQty),
        sellQty: sanitizeQty(e?.sellQty),
      };
    }
    // 交易流水（FR-08）：可选字段，逐条清洗，非法条目丢弃
    const ledger = (Array.isArray(raw.ledger) ? raw.ledger : [])
      .map((x): LedgerEntry => {
        const e = (x ?? {}) as Record<string, unknown>;
        return {
          ts: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : 0,
          rowId: typeof e.rowId === 'string' ? e.rowId : '',
          field: e.field === 'sellQty' ? 'sellQty' : 'buyQty',
          from: sanitizeQty(e?.from),
          to: sanitizeQty(e?.to),
          // FR-11：op 必须原样保留，否则云同步/导入导出会把「累加」洗成「设值」，
          // 导致「上次触发量」丢失、行内「＋」退化为逐次手输。
          ...(e.op === 'add' || e.op === 'set' ? { op: e.op as 'add' | 'set' } : {}),
          ...(e.revert === true ? { revert: true as const } : {}),
        };
      })
      .filter((e) => e.rowId !== '');
    const bp = raw.basePrice;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : `imp_${Math.random().toString(36).slice(2, 10)}`,
      name,
      code: typeof raw.code === 'string' ? raw.code : '',
      basePrice: typeof bp === 'number' && Number.isFinite(bp) && bp > 0 ? bp : null,
      gridStep: typeof raw.gridStep === 'number' && raw.gridStep > 0 ? raw.gridStep : 0.02,
      nets,
      journal,
      ledger,
      quoteUrl: typeof raw.quoteUrl === 'string' ? raw.quoteUrl : null,
      lastPrice: typeof raw.lastPrice === 'number' && Number.isFinite(raw.lastPrice) ? raw.lastPrice : null,
      lastPriceAt: typeof raw.lastPriceAt === 'number' && Number.isFinite(raw.lastPriceAt) ? raw.lastPriceAt : null,
    };
  });
  return { version: 1, varieties };
}

function sanitizeQty(x: unknown): number {
  const n = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  return n > 0 ? Math.round(n * 10000) / 10000 : 0;
}

export function exportFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `grid-data-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}
