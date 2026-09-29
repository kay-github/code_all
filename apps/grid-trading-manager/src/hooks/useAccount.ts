import { useCallback, useEffect, useState } from 'react';
import { SIGNED_IN_MARKER } from '../cloud/config';
import { api, ApiError } from '../cloud/http';

export type AuthStep = 'idle' | 'login' | 'register' | 'reset';
export interface AccountError { text: string; code?: string; status: number }
interface User { id: string; username: string }
interface AuthResult { user: User; recoveryCode?: string }

function marker(): boolean {
  try { return window.localStorage.getItem(SIGNED_IN_MARKER) === '1'; }
  catch { return false; }
}
function setMarker(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SIGNED_IN_MARKER, '1');
    else window.localStorage.removeItem(SIGNED_IN_MARKER);
  } catch { /* private browsing */ }
}
function message(error: unknown): AccountError {
  if (error instanceof ApiError) return { text: error.message, status: error.status, code: error.code };
  return { text: '网络暂时不可用，请稍后重试', status: 0, code: 'network' };
}
export interface AccountApi {
  checking: boolean;
  username: string | null;
  userId: string | null;
  signedIn: boolean;
  error: AccountError | null;
  notice: string | null;
  recoveryCode: string | null;
  busy: boolean;
  open: boolean;
  step: AuthStep;
  openPanel: (initial?: AuthStep) => void;
  closePanel: () => void;
  setStep: (step: AuthStep) => void;
  clearMessages: () => void;
  fail: (text: string) => void;
  login: (username: string, password: string) => Promise<boolean>;
  register: (username: string, password: string) => Promise<boolean>;
  resetPassword: (username: string, recoveryCode: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  dismissRecoveryCode: () => void;
}

export function useAccount(): AccountApi {
  const [checking, setChecking] = useState(marker);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<AccountError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<AuthStep>('idle');

  useEffect(() => {
    if (!marker()) return;
    let alive = true;
    void api<{ user: User }>('auth').then(({ user: next }) => {
      if (alive) setUser(next);
    }).catch((reason: unknown) => {
      if (alive) {
        if (reason instanceof ApiError && reason.status === 401) setMarker(false);
        else setError(message(reason));
      }
    }).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  const clearMessages = useCallback(() => { setError(null); setNotice(null); }, []);
  const fail = useCallback((text: string) => {
    setNotice(null); setError({ text, status: 0, code: 'input' });
  }, []);
  const openPanel = useCallback((initial: AuthStep = 'idle') => {
    setError(null); setNotice(null); setStep(initial); setOpen(true);
  }, []);
  const closePanel = useCallback(() => {
    setOpen(false); setStep('idle'); setError(null); setNotice(null);
  }, []);
  const dismissRecoveryCode = useCallback(() => setRecoveryCode(null), []);

  const submit = useCallback(async (action: 'login' | 'register' | 'reset', input: Record<string, string>) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api<AuthResult>('auth', 'POST', { action, ...input });
      setUser(result.user);
      setMarker(true);
      setStep('idle');
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      setNotice(action === 'login' ? '已登录' : action === 'register' ? '注册成功，已登录' : '密码已更新，已登录');
      return true;
    } catch (reason) {
      setError(message(reason)); return false;
    } finally { setBusy(false); }
  }, []);
  const login = useCallback((username: string, password: string) =>
    submit('login', { username, password }), [submit]);
  const register = useCallback((username: string, password: string) =>
    submit('register', { username, password }), [submit]);
  const resetPassword = useCallback((username: string, recoveryCode: string, password: string) =>
    submit('reset', { username, recoveryCode, password }), [submit]);

  const signOut = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api('auth', 'POST', { action: 'logout' });
      setUser(null); setMarker(false); setStep('idle'); setBusy(false);
      setNotice('已退出登录');
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }, []);

  return {
    checking, username: user?.username ?? null, userId: user?.id ?? null, signedIn: user != null,
    error, notice, recoveryCode, busy, open, step, openPanel, closePanel, setStep,
    clearMessages, fail, login, register, resetPassword, signOut, dismissRecoveryCode,
  };
}

