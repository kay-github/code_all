export function syncDecision(local, remote) {
  if (remote.kind === 'ok' && JSON.stringify(local.state) === JSON.stringify(remote.data)) return 'current';
  if (remote.kind === 'empty' && local.remoteRev !== null) return 'conflict';
  if (!local.pending) return remote.kind === 'ok' ? 'download' : 'current';
  return local.remoteRev === (remote.rev ?? null) ? 'upload' : 'conflict';
}
