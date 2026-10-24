(() => {
  function describe(item) {
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('链接无效');
    const intranet = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost$)/.test(url.hostname);
    const feishu = url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn');
    return { url, intranet, source: feishu ? '飞书表单' : url.hostname === 'f.wps.cn' ? 'WPS 表单' : intranet ? '业务系统' : '快捷入口' };
  }
  async function loadConfig() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/portal/config', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('读取失败');
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error('配置无效');
      data.items.forEach(describe);
      return data;
    } finally { clearTimeout(timeout); }
  }
  window.Portal = { describe, loadConfig };
})();
