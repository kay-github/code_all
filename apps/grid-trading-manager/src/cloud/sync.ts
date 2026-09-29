import type { AppData } from '../engine/types';
import { parseAppData } from '../storage';
import { api, ApiError } from './http';
import { SYNC_META_KEY } from './config';

export interface SyncMeta {
  rev: number | null;
  hash: string | null;
  clientId: string;
  at: number | null;
}
export interface SyncStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const CLIENT_ID_KEY = 'grid-trading-manager:client-id:v1';

export function hashPayload(data: unknown): string {
  const s = JSON.stringify(data) ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}
export function getClientId(store: SyncStore): string {
  try {
    const cur = store.getItem(CLIENT_ID_KEY);
    if (cur) return cur;
    const gen = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    store.setItem(CLIENT_ID_KEY, gen);
    return gen;
  } catch { return 'unknown'; }
}
function metaKey(userId: string): string { return `${SYNC_META_KEY}:${userId}`; }
export function loadMeta(store: SyncStore, userId: string, clientId: string): SyncMeta {
  try {
    const raw = store.getItem(metaKey(userId));
    if (!raw) return { rev: null, hash: null, clientId, at: null };
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      rev: typeof o.rev === 'number' && Number.isSafeInteger(o.rev) ? o.rev : null,
      hash: typeof o.hash === 'string' ? o.hash : null,
      clientId,
      at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : null,
    };
  } catch { return { rev: null, hash: null, clientId, at: null }; }
}
export function saveMeta(store: SyncStore, userId: string, meta: SyncMeta): void {
  try { store.setItem(metaKey(userId), JSON.stringify(meta)); } catch { /* local storage may be full */ }
}
export function clearMeta(store: SyncStore, userId: string): void {
  try { store.removeItem(metaKey(userId)); } catch { /* ignore */ }
}

export interface SyncFailure {
  message: string;
  transient: boolean;
  unauthorized: boolean;
  code?: string;
}
export type PushOutcome =
  | { kind: 'ok'; rev: number }
  | { kind: 'conflict'; remoteRev: number | null }
  | { kind: 'error'; failure: SyncFailure };
export type PullOutcome =
  | { kind: 'empty' }
  | { kind: 'ok'; rev: number; data: AppData; updatedAt: string | null }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; failure: SyncFailure };

function failure(error: unknown): SyncFailure {
  const e = error instanceof ApiError ? error : new ApiError(0, 'network', '网络不可用，请检查网络后重试');
  return {
    message: e.message,
    transient: e.status === 0 || e.status === 429 || e.status >= 500,
    unauthorized: e.status === 401,
    code: e.code,
  };
}
export async function pushState(data: AppData, meta: SyncMeta): Promise<PushOutcome> {
  try {
    const result = await api<{ rev: number }>('state', 'PUT', { data, baseRev: meta.rev, clientId: meta.clientId });
    return { kind: 'ok', rev: result.rev };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { kind: 'conflict', remoteRev: error.remoteRev };
    return { kind: 'error', failure: failure(error) };
  }
}
export async function pullState(): Promise<PullOutcome> {
  let result: { kind: 'empty' } | { kind: 'ok'; rev: number; data: unknown; updatedAt: string | null };
  try { result = await api('state'); }
  catch (error) { return { kind: 'error', failure: failure(error) }; }
  if (result.kind === 'empty') return result;
  try {
    return { kind: 'ok', rev: result.rev, data: parseAppData(result.data), updatedAt: result.updatedAt };
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : '云端数据格式不符' };
  }
}
export async function deleteCloudState(): Promise<{ ok: true } | { ok: false; failure: SyncFailure }> {
  try { await api('state', 'DELETE'); return { ok: true }; }
  catch (error) { return { ok: false, failure: failure(error) }; }
}

