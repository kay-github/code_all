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
    try {
      const config = await Portal.loadConfig();
      const fragment = document.createDocumentFragment();
      let hasIntranet = false;
      config.items.forEach((item, index) => {
        const { intranet, source } = Portal.describe(item);
        hasIntranet ||= intranet;
        const card = document.querySelector('#card-template').content.cloneNode(true).firstElementChild;
        card.classList.toggle('mint', index % 2 === 1);
        card.dataset.id = item.id;
        if (['overtime', 'grievance', 'complaint', 'praise', 'system', 'inspection'].includes(item.id)) card.querySelector('.icon use').setAttribute('href', `#icon-${item.id}`);
        card.href = item.url;
        card.setAttribute('aria-label', `${item.name}${intranet ? '，需连接单位内网' : ''}，在新标签页打开`);
        card.querySelector('.number').textContent = String(index + 1).padStart(2, '0');
        card.querySelector('h2').textContent = item.name;
        card.querySelector('p').textContent = item.remark;
        if (intranet) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = '内网';
          card.querySelector('.title-row').append(badge);
        }
        card.querySelector('.source').textContent = source;
        fragment.append(card);
      });
      if (!config.items.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = '暂无常用功能，请在后台添加入口。';
        fragment.append(empty);
      }
      grid.replaceChildren(fragment);
      document.querySelector('.count').textContent = config.items.length;
      document.querySelector('.notice').lastChild.textContent = `所有入口均在新标签页打开${hasIntranet ? '；标注“内网”的入口需要连接单位内网。' : '。'}`;
      grid.hidden = false;
      loaded = true;
      status.hidden = true;
    } catch {
      status.textContent = '暂时无法读取最新配置，请重试。';
      status.hidden = false;
      retry.hidden = false;
    } finally { loading = false; }
  }
  retry.addEventListener('click', load);
  window.addEventListener('pageshow', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
