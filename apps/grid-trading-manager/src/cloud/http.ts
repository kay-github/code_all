export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public remoteRev: number | null = null) {
    super(message);
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/grid/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', '网络不可用，请检查网络后重试');
  }
  let result: Record<string, unknown>;
  try { result = await response.json() as Record<string, unknown>; }
  catch { throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的数据'); }
  if (!response.ok) {
    throw new ApiError(response.status,
      typeof result.code === 'string' ? result.code : 'request',
      typeof result.error === 'string' ? result.error : '请求失败，请稍后重试',
      typeof result.remoteRev === 'number' ? result.remoteRev : null);
  }
  return result as T;
}
