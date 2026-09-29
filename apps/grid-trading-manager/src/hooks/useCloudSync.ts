// 云同步编排（PRD FR-10，实施顺序第 3~5 步）
//
// 三件事：
//   1. 推送：本地写入 → 节流 2.5s → compare-and-swap 上云；页面隐藏/关闭时补一次
//   2. 拉取：启动/登录时比对版本号，决定「静默采纳云端 / 静默上传本机 / 交给用户选」
//   3. 冲突：版本不匹配且本机确有改动 → 不自动合并，弹给用户选
//
// 关键前提：**本机数据永不主动删除。** 任何路径都不会清空本地，最多是被云端内容覆盖
// （而那一步必须由用户显式选择）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppData } from '../engine/types';
import { cloneSeed } from '../engine/seed';
import { PUSH_THROTTLE_MS } from '../cloud/config';
import {
  clearMeta,
  deleteCloudState,
  getClientId,
  hashPayload,
  loadMeta,
  pullState,
  pushState,
  saveMeta,
  SyncFailure,
  SyncMeta,
} from '../cloud/sync';

export type SyncPhase =
  /** 未登录：同步关闭，零请求 */
  | 'off'
  /** 首次比对中 */
  | 'checking'
  /** 已同步，之后本地写入会自动推送 */
  | 'ready'
  /** 等用户裁决（首次登录云端已有数据 / 版本冲突） */
  | 'choosing'
  /** 上一次同步失败（本地照常可用，网络恢复后可重试） */
  | 'error';

export interface PendingRemote {
  rev: number;
  data: AppData;
  updatedAt: string | null;
}

export interface ConflictInfo {
  reason: 'first-login' | 'cas';
  remoteRev: number | null;
  /** 本机品种数，供用户判断（不展示任何账号信息） */
  localCount: number;
  /** 云端品种数；拉取失败时为 null */
  remoteCount: number | null;
}

export interface CloudSyncApi {
  phase: SyncPhase;
  lastSyncAt: number | null;
  failure: SyncFailure | null;
  conflict: ConflictInfo | null;
  /** 有数据在上传/下载中 */
  working: boolean;
  /** 云端是否已有该账号的快照（用于文案：「云端暂无数据」） */
  cloudEmpty: boolean | null;
  syncNow: () => void;
  resolve: (choice: 'local' | 'cloud') => Promise<void>;
  /** 有冲突时把本机数据先导出（用户兜底选项） */
  exportLocal: () => void;
  deleteCloud: () => Promise<SyncFailure | null>;
}

interface Options {
  data: AppData | null;
  replaceData: (d: AppData) => void;
  signedIn: boolean;
  userId: string | null;
}

/** 本机数据是否还是「出厂默认」——是的话，被云端覆盖没有任何损失，可以静默拉取 */
function isPristineSeed(data: AppData): boolean {
  try {
    return JSON.stringify(data) === JSON.stringify(cloneSeed());
  } catch {
    return false;
  }
}

export function useCloudSync({ data, replaceData, signedIn, userId }: Options): CloudSyncApi {
  const [phase, setPhase] = useState<SyncPhase>('off');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<SyncFailure | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [working, setWorking] = useState(false);
  const [cloudEmpty, setCloudEmpty] = useState<boolean | null>(null);

  const store = typeof window !== 'undefined' ? window.localStorage : null;
  const clientIdRef = useRef<string>('');
  const metaRef = useRef<SyncMeta>({ rev: null, hash: null, clientId: '', at: null });
  const pendingRemoteRef = useRef<PendingRemote | null>(null);
  const dataRef = useRef<AppData | null>(data);
  const phaseRef = useRef<SyncPhase>('off');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushingRef = useRef(false);
  /** 首轮比对完成前不许推送，否则会把「还没拉下来的云端旧数据」当成本机改动推回去 */
  const bootDoneRef = useRef(false);
  const activeUserRef = useRef<string | null>(userId);

  dataRef.current = data;
  phaseRef.current = phase;
  activeUserRef.current = userId;

  const applyMeta = useCallback(
    (next: Partial<SyncMeta>) => {
      const merged = { ...metaRef.current, ...next };
      metaRef.current = merged;
      if (store && userId) saveMeta(store, userId, merged);
    },
    [store, userId],
  );

  /** 采纳一份数据并记录指纹（指纹一致 → 后续不会把同一份内容再推回云端） */
  const adopt = useCallback(
    (next: AppData, rev: number | null) => {
      replaceData(next);
      applyMeta({ rev, hash: hashPayload(next), at: Date.now() });
      setLastSyncAt(Date.now());
    },
    [applyMeta, replaceData],
  );

  // ---- 推送 ----

  const doPush = useCallback(async () => {
    const payload = dataRef.current;
    if (!payload || !signedIn || !userId || activeUserRef.current !== userId || !bootDoneRef.current) return;
    if (pushingRef.current) return;
    const h = hashPayload(payload);
    if (h === metaRef.current.hash) return; // 与云端一致，不必推
    pushingRef.current = true;
    setWorking(true);
    try {
      const res = await pushState(payload, metaRef.current);
      if (activeUserRef.current !== userId) return;
      if (res.kind === 'ok') {
        applyMeta({ rev: res.rev, hash: h, at: Date.now() });
        setLastSyncAt(Date.now());
        setFailure(null);
        setPhase('ready');
        return;
      }
      if (res.kind === 'conflict') {
        // 版本被别处推进过：拉下来让用户选，绝不自动覆盖
        const remote = await pullState();
        if (remote.kind === 'ok') {
          pendingRemoteRef.current = { rev: remote.rev, data: remote.data, updatedAt: remote.updatedAt };
          setConflict({
            reason: 'cas',
            remoteRev: remote.rev,
            localCount: payload.varieties.length,
            remoteCount: remote.data.varieties.length,
          });
          setPhase('choosing');
        } else {
          setFailure(remote.kind === 'error' ? remote.failure : { message: '云端数据无法读取', transient: false, unauthorized: false });
          setPhase('error');
        }
        return;
      }
      setFailure(res.failure);
      setPhase(res.failure.unauthorized ? 'ready' : 'error');
    } finally {
      pushingRef.current = false;
      setWorking(false);
    }
  }, [applyMeta, signedIn, userId]);

  /**
   * 首轮比对里要用的三个函数放进 ref。
   *
   * 原因：bootstrap effect 的依赖必须只有 [signedIn, userId]。若把 doPush / adopt
   * 直接写进依赖，它们又依赖 replaceData（父组件每次渲染都可能是新函数），effect 会不停重跑，
   * 每次都重新拉一次云端。用 ref 取「最新实现」，依赖面收敛到「谁登录了」。
   */
  const fnsRef = useRef({ doPush, adopt, applyMeta });
  fnsRef.current = { doPush, adopt, applyMeta };

  const schedulePush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void doPush();
    }, PUSH_THROTTLE_MS);
  }, [doPush]);

  // 本地写入 → 节流推送（只在已登录且首轮比对完成后）
  useEffect(() => {
    if (!signedIn || !userId || !bootDoneRef.current || phase !== 'ready') return;
    if (!data) return;
    schedulePush();
  }, [data, signedIn, userId, phase, schedulePush]);

  // 页面隐藏/卸载时补推一次（best-effort：本机仍是真值，漏了下次打开也会补上）
  useEffect(() => {
    if (!signedIn) return;
    const flush = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        void doPush();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [signedIn, doPush]);

  // ---- 首轮比对（登录后 / 刷新后） ----

  useEffect(() => {
    bootDoneRef.current = false;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    pendingRemoteRef.current = null;
    if (!signedIn || !userId || !store) {
      setPhase('off');
      setConflict(null);
      setFailure(null);
      setCloudEmpty(null);
      return;
    }
    let alive = true;
    clientIdRef.current = getClientId(store);
    metaRef.current = loadMeta(store, userId, clientIdRef.current);
    setPhase('checking');
    setWorking(true);

    void (async () => {
      const remote = await pullState();
      if (!alive) return;
      setWorking(false);

      if (remote.kind === 'error') {
        setFailure(remote.failure);
        setPhase('error');
        // 比对失败不代表不能用：本地照常，只是暂不同步
        bootDoneRef.current = true;
        return;
      }
      if (remote.kind === 'invalid') {
        setFailure({ message: `云端数据无法解析（${remote.message}），已保持本机数据不变`, transient: false, unauthorized: false });
        setPhase('error');
        bootDoneRef.current = true;
        return;
      }

      const local = dataRef.current;

      // ① 云端还没有快照 → 把本机数据传上去（首次登录的主路径）
      if (remote.kind === 'empty') {
        setCloudEmpty(true);
        bootDoneRef.current = true;
        if (local) await fnsRef.current.doPush();
        return;
      }

      setCloudEmpty(false);
      // 本机数据还没就绪（极早期）→ 没有可丢的东西，直接采纳云端
      if (!local) {
        fnsRef.current.adopt(remote.data, remote.rev);
        setPhase('ready');
        bootDoneRef.current = true;
        return;
      }
      const meta = metaRef.current;
      const dirty = meta.hash != null ? meta.hash !== hashPayload(local) : true;

      // ② 云端与本机记录的版本一致
      if (meta.rev != null && remote.rev === meta.rev) {
        bootDoneRef.current = true;
        if (dirty) {
          await fnsRef.current.doPush(); // 本机有未推送的改动，补推
        } else {
          fnsRef.current.applyMeta({ at: Date.now() });
          setLastSyncAt(Date.now());
          setPhase('ready');
        }
        return;
      }

      // ③ 本机从未同步过，但云端已经有数据
      if (meta.rev == null) {
        // 本机只有出厂默认数据 → 没有任何可丢的东西，直接采纳云端
        if (isPristineSeed(local)) {
          fnsRef.current.adopt(remote.data, remote.rev);
          setPhase('ready');
          bootDoneRef.current = true;
          return;
        }
        // 本机确有数据 → 交给用户选，绝不替他决定
        pendingRemoteRef.current = { rev: remote.rev, data: remote.data, updatedAt: remote.updatedAt };
        setConflict({
          reason: 'first-login',
          remoteRev: remote.rev,
          localCount: local.varieties.length,
          remoteCount: remote.data.varieties.length,
        });
        setPhase('choosing');
        bootDoneRef.current = true;
        return;
      }

      // ④ 云端版本更新，且本机没有未推送的改动 → 静默采纳云端（多设备的常规路径）
      if (!dirty) {
        fnsRef.current.adopt(remote.data, remote.rev);
        setPhase('ready');
        bootDoneRef.current = true;
        return;
      }

      // ⑤ 两边都有改动 → 冲突，交给用户
      pendingRemoteRef.current = { rev: remote.rev, data: remote.data, updatedAt: remote.updatedAt };
      setConflict({
        reason: 'cas',
        remoteRev: remote.rev,
        localCount: local.varieties.length,
        remoteCount: remote.data.varieties.length,
      });
      setPhase('choosing');
      bootDoneRef.current = true;
    })();

    return () => {
      alive = false;
    };
    // doPush / adopt / applyMeta 均为稳定引用（useCallback + 只依赖 store/userId）
  }, [signedIn, userId, store]);

  // ---- 用户裁决 ----

  const resolve = useCallback(
    async (choice: 'local' | 'cloud') => {
      const remote = pendingRemoteRef.current;
      setWorking(true);
      try {
        if (choice === 'cloud') {
          if (remote) adopt(remote.data, remote.rev);
          pendingRemoteRef.current = null;
          setConflict(null);
          setPhase('ready');
          return;
        }
        // 用本机覆盖云端：先对齐到云端当前版本号，再用 CAS 写一次（避免又判成冲突）
        const cur = await pullState();
        const baseRev = cur.kind === 'ok' ? cur.rev : cur.kind === 'empty' ? null : metaRef.current.rev;
        applyMeta({ rev: baseRev, hash: null });
        pendingRemoteRef.current = null;
        setConflict(null);
        setPhase('ready');
        bootDoneRef.current = true;
        await doPush();
      } finally {
        setWorking(false);
      }
    },
    [adopt, applyMeta, doPush],
  );

  const exportLocal = useCallback(() => {
    const payload = dataRef.current;
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'grid-data-before-sync.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, []);

  const syncNow = useCallback(() => {
    if (!signedIn || !userId) return;
    void doPush();
  }, [doPush, signedIn, userId]);

  const deleteCloud = useCallback(async (): Promise<SyncFailure | null> => {
    setWorking(true);
    try {
      const res = await deleteCloudState();
      if (!res.ok) {
        setFailure(res.failure);
        return res.failure;
      }
      // 云端已空：本机记录归零，之后编辑会重新以新增方式上传
      if (store && userId) clearMeta(store, userId);
      metaRef.current = { rev: null, hash: null, clientId: clientIdRef.current, at: null };
      setCloudEmpty(true);
      setConflict(null);
      pendingRemoteRef.current = null;
      setPhase('ready');
      setFailure(null);
      return null;
    } finally {
      setWorking(false);
    }
  }, [store, userId]);

  return {
    phase,
    lastSyncAt,
    failure,
    conflict,
    working,
    cloudEmpty,
    syncNow,
    resolve,
    exportLocal,
    deleteCloud,
  };
}
