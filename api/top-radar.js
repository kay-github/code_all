// Top Radar control API. Config (registry / pools) lives in Vercel Blob,
// with the committed apps/top-radar files as a read-only seed.
const fs = require('fs');
const path = require('path');
const store = require('../lib/gridStore');
const { sendJson } = require('../lib/gridHttp');
const { matchesSecret } = require('../lib/investmentAlerts');
const { sendPushplus } = require('../lib/pushplus');

const PREFIX = 'top-radar/v1/';
const APP_DIR = path.join(process.cwd(), 'apps', 'top-radar');
const REPO = process.env.GITHUB_REPO || 'kay-github/code_all';
const WORKFLOW = process.env.GITHUB_WORKFLOW || 'top-radar-daily.yml';
const REF = process.env.GITHUB_REF || 'main';

function auth(req) {
  return matchesSecret(req.headers?.authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET);
}
function requireAuth(req, res) {
  if (!process.env.MONITOR_SECRET) {
    sendJson(res, 503, { error: '服务端未配置 MONITOR_SECRET' });
    return false;
  }
  if (!auth(req)) {
    sendJson(res, 401, { error: '未授权：MONITOR_SECRET 不正确' });
    return false;
  }
  return true;
}
function body(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}
function readFileJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, rel), 'utf8')); } catch { return null; }
}
async function readBlobJson(name) {
  try {
    const r = await store.read(PREFIX + name);
    return r ? r.value : null;
  } catch {
    return null;
  }
}
async function writeBlobJson(name, value) {
  let etag = null;
  try {
    const r = await store.read(PREFIX + name);
    etag = r ? r.etag : null;
  } catch {}
  await store.write(PREFIX + name, value, etag);
}
async function getRegistry() {
  return (await readBlobJson('registry.json')) || readFileJson('registry.json');
}
async function getPool(id) {
  if (!/^[a-z0-9_]{2,32}$/.test(id || '')) return null;
  return (await readBlobJson('pools/' + id + '.json')) || readFileJson('pools/' + id + '.json');
}
function txSym(code) {
  code = String(code).padStart(6, '0');
  if (/^(60|68|5)/.test(code)) return 'sh' + code;
  if (/^(00|30|1|2)/.test(code)) return 'sz' + code;
  if (/^(8|9|4)/.test(code)) return 'bj' + code;
  return 'sz' + code;
}
async function quoteNames(codes) {
  const syms = codes.map(txSym);
  const url = 'https://qt.gtimg.cn/q=' + syms.join(',');
  const out = {};
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' }, signal: AbortSignal.timeout(12000) });
    const text = await r.text();
    for (const line of text.split('\n')) {
      const m = line.match(/v_(\w+)="([^"]*)"/);
      if (!m) continue;
      const f = m[2].split('~');
      if (f.length > 2) out[f[2]] = f[1];
    }
  } catch {}
  for (const c of codes) if (!out[c]) out[c] = c;
  return out;
}

module.exports = async function handler(req, res) {
  try {
    const action = req.query?.action;
    const view = req.query?.view;

    if (req.method === 'GET' && view === 'registry') {
      return sendJson(res, 200, await getRegistry());
    }
    if (req.method === 'GET' && view === 'pool') {
      const pool = await getPool(req.query?.id);
      if (!pool) return sendJson(res, 404, { error: '板块不存在' });
      return sendJson(res, 200, pool);
    }
    if (req.method === 'GET' && view === 'health') {
      return sendJson(res, 200, {
        ok: true,
        monitorSecret: Boolean(process.env.MONITOR_SECRET),
        githubDispatch: Boolean(process.env.GITHUB_DISPATCH_TOKEN),
        pushplus: Boolean(process.env.PUSHPLUS_TOKEN),
      });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 GET / POST' });

    if (action === 'notify') {
      if (!requireAuth(req, res)) return;
      const b = body(req);
      if (!b.title || !b.content) return sendJson(res, 400, { error: '缺少标题或内容' });
      try {
        const r = await sendPushplus({ title: String(b.title).slice(0, 120), content: String(b.content), template: 'html' });
        return sendJson(res, 200, { ok: true, serial: r.serial || '' });
      } catch (e) {
        console.error('[top-radar] push failed:', e.message);
        return sendJson(res, 503, { error: 'PushPlus 发送失败：' + String(e.message).slice(0, 80) });
      }
    }

    if (!requireAuth(req, res)) return;

    if (action === 'verify') {
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'set-enabled') {
      const b = body(req);
      if (!/^[a-z0-9_]{2,32}$/.test(b.id || '')) return sendJson(res, 400, { error: '板块 ID 不合法' });
      const registry = await getRegistry();
      if (!registry || !Array.isArray(registry.sectors)) return sendJson(res, 503, { error: '配置读取失败' });
      const item = registry.sectors.find(s => s.id === b.id);
      if (!item) return sendJson(res, 404, { error: '板块不存在' });
      item.enabled = Boolean(b.enabled);
      registry.updated_at = new Date().toISOString().slice(0, 10);
      await writeBlobJson('registry.json', registry);
      return sendJson(res, 200, { ok: true, id: item.id, enabled: item.enabled });
    }

    if (action === 'add-sector') {
      const b = body(req);
      const name = String(b.name || '').trim();
      let codes = (Array.isArray(b.codes) ? b.codes : String(b.codes || '').split(/[\s,，、]+/))
        .map(x => String(x).trim()).filter(Boolean);
      codes = [...new Set(codes.filter(c => /^\d{6}$/.test(c)))];
      if (!name || name.length > 30) return sendJson(res, 400, { error: '板块名称必填，且不超过 30 字' });
      if (codes.length < 3) return sendJson(res, 400, { error: '至少填 3 个 6 位股票代码' });
      if (codes.length > 80) return sendJson(res, 400, { error: '一个板块最多 80 只，建议 20–60 只' });

      let id = String(b.id || '').trim().toLowerCase();
      if (!id) id = 's_' + Date.now().toString(36);
      if (!/^[a-z0-9_]{2,32}$/.test(id)) return sendJson(res, 400, { error: 'ID 只能用小写英文、数字、下划线' });

      const registry = await getRegistry();
      if (!registry || !Array.isArray(registry.sectors)) return sendJson(res, 503, { error: '配置读取失败' });
      if (registry.sectors.some(s => s.id === id)) return sendJson(res, 409, { error: '这个 ID 已存在' });
      if (await getPool(id)) return sendJson(res, 409, { error: '这个 ID 已有板块池' });

      const names = await quoteNames(codes);
      const leaders = (Array.isArray(b.leaders) ? b.leaders : String(b.leaders || '').split(/[\s,，、]+/))
        .map(x => String(x).trim()).filter(c => /^\d{6}$/.test(c) && codes.includes(c));
      const pool = {
        id, name, as_of: new Date().toISOString().slice(0, 10),
        leaders,
        core: codes.map(c => ({ code: c, name: names[c] || c, tag: '自定义' })),
        ext: [],
      };
      await writeBlobJson('pools/' + id + '.json', pool);
      registry.sectors.push({
        id, name, enabled: true, pool: 'pools/' + id + '.json',
        order: Math.max(0, ...registry.sectors.map(s => Number(s.order) || 0)) + 1,
        push: { enabled: true, min_tier: 3, orange: 'stage' },
      });
      registry.updated_at = new Date().toISOString().slice(0, 10);
      await writeBlobJson('registry.json', registry);
      return sendJson(res, 200, { ok: true, id, name, count: codes.length });
    }

    if (action === 'run') {
      const token = process.env.GITHUB_DISPATCH_TOKEN;
      if (!token) return sendJson(res, 503, { error: '未配置 GITHUB_DISPATCH_TOKEN' });
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: REF }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const t = await r.text();
        return sendJson(res, 502, { error: `GitHub ${r.status}: ${t.slice(0, 120)}` });
      }
      return sendJson(res, 202, { ok: true, message: '已触发 GitHub Actions，通常 2–4 分钟完成。' });
    }

    if (action === 'test') {
      const content = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;color:#1C1A17;">
        <div style="border:1px solid #B3392C33;border-left:4px solid #B3392C;background:#FDECEC;padding:16px;">
          <div style="font-size:12px;color:#B3392C;font-weight:700;letter-spacing:.04em;">TOP RADAR · 测试消息</div>
          <div style="font-size:20px;font-weight:700;margin:8px 0 4px;">推送链路正常</div>
          <div style="font-size:13px;color:#3A362C;line-height:1.7;">如果你收到这条，说明 PushPlus token 与 Vercel 接口都通了。真实信号只在档位变化时发送。</div>
          <a href="https://1.688680.xyz/taoding" style="display:inline-block;margin-top:10px;color:#B3392C;font-weight:700;text-decoration:none;">打开逃顶雷达 →</a>
        </div></div>`;
      try {
        const r = await sendPushplus({ title: '逃顶雷达 · 测试消息', content, template: 'html' });
        return sendJson(res, 200, { ok: true, serial: r.serial || '', message: '测试消息已发送，请查收微信。' });
      } catch (e) {
        console.error('[top-radar] test push failed:', e.message);
        return sendJson(res, 503, { error: 'PushPlus 发送失败：' + String(e.message).slice(0, 80) });
      }
    }

    return sendJson(res, 404, { error: '未知操作' });
  } catch (error) {
    console.error('[top-radar] failed:', error?.name || 'Error');
    return sendJson(res, 503, { error: '服务暂时不可用' });
  }
};
