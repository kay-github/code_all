(() => {
  const grid = document.querySelector('.grid');
  const status = document.querySelector('#load-status');
  const retry = document.querySelector('#retry-load');
  let loading = false;
  let loaded = false;

  async function load() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    status.hidden = loaded;
    status.textContent = '正在加载常用功能…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/portal/config', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error();
      const config = await response.json();
      const cards = [...grid.querySelectorAll('.card')];
      if (!Array.isArray(config.items) || config.items.length !== cards.length) throw new Error();
      let hasIntranet = false;
      for (const item of config.items) {
        const card = cards.find(card => card.dataset.id === item.id);
        const url = new URL(item.url);
        if (!card || !['http:', 'https:'].includes(url.protocol)) throw new Error();
        const intranet = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost$)/.test(url.hostname);
        hasIntranet ||= intranet;
        card.href = item.url;
        card.setAttribute('aria-label', `${item.name}${intranet ? '，需连接单位内网' : ''}，在新标签页打开`);
        card.querySelector('h2').textContent = item.name;
        card.querySelector('p').textContent = item.remark;
        card.querySelector('.badge')?.remove();
        if (intranet) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = '内网';
          card.querySelector('.title-row').append(badge);
        }
        card.querySelector('.source').textContent = url.hostname.endsWith('feishu.cn') ? '飞书表单' : url.hostname === 'f.wps.cn' ? 'WPS 表单' : intranet ? '业务系统' : '快捷入口';
      }
      document.querySelector('.notice').lastChild.textContent = `所有入口均在新标签页打开${hasIntranet ? '；标注“内网”的入口需要连接单位内网。' : '。'}`;
      grid.hidden = false;
      loaded = true;
      status.hidden = true;
    } catch {
      status.textContent = '暂时无法读取最新配置，请重试。';
      status.hidden = false;
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      loading = false;
    }
  }
  retry.addEventListener('click', load);
  window.addEventListener('pageshow', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
