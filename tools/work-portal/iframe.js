(() => {
  const $ = id => document.getElementById(id);
  let items = [];
  let active = null;
  let loading = false;
  let version = null;
  function setFullscreen(value) {
    if (value && $('viewer').hidden) return;
    document.body.classList.toggle('frame-fullscreen', value);
    $('exit-fullscreen').hidden = !value;
    $('enter-fullscreen').setAttribute('aria-pressed', String(value));
    if (value) document.querySelector('.embed-help').open = false;
    (value ? $('exit-fullscreen') : $('enter-fullscreen')).focus({ preventScroll: true });
  }
  function updateButtons(id) {
    for (const button of $('switch-buttons').children) {
      const selected = button.dataset.id === id;
      button.setAttribute('aria-pressed', String(selected));
      if (selected) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  function select(item, updateHash = true) {
    active = item;
    $('active-name').textContent = item.name;
    $('active-remark').textContent = item.remark;
    $('open-page').href = item.url;
    $('fallback-open').href = item.url;
    $('content-frame').title = item.name;
    updateButtons(item.id);
    const { url, intranet } = Portal.describe(item);
    const mixed = location.protocol === 'https:' && url.protocol === 'http:';
    $('content-frame').hidden = mixed;
    $('frame-fallback').hidden = !mixed;
    $('reload-frame').hidden = mixed;
    if (mixed) {
      $('content-frame').removeAttribute('src');
      $('fallback-message').textContent = `此入口使用 HTTP，浏览器无法在当前 HTTPS 页面中内嵌显示。${intranet ? '请先连接单位内网，再在新窗口打开。' : '请在新窗口打开，或在后台改为该服务支持的 HTTPS 地址。'}`;
    } else $('content-frame').src = item.url;
    $('viewer').hidden = false;
    if (updateHash) history.replaceState(null, '', `#${encodeURIComponent(item.id)}`);
  }
  function hashId() { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } }
  async function load() {
    if (loading) return;
    loading = true;
    $('retry-load').hidden = true;
    try {
      const data = await Portal.loadConfig();
      if (version === data.version) { $('load-status').hidden = items.length > 0; return; }
      $('load-status').hidden = true;
      version = data.version;
      items = data.items;
      $('entry-count').textContent = `${items.length} 个入口`;
      $('switch-buttons').replaceChildren();
      items.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'switch-button';
        button.dataset.id = item.id;
        button.title = item.name;
        const number = document.createElement('span');
        number.textContent = String(index + 1).padStart(2, '0');
        button.append(number, document.createTextNode(item.name));
        button.addEventListener('click', () => { if (active?.id !== item.id) select(item); });
        $('switch-buttons').append(button);
      });
      if (!items.length) {
        if (document.body.classList.contains('frame-fullscreen')) setFullscreen(false);
        active = null;
        $('viewer').hidden = true;
        $('content-frame').removeAttribute('src');
        $('load-status').textContent = '暂无常用功能，请在后台添加入口。';
        $('load-status').hidden = false;
      } else {
        const next = items.find(item => item.id === hashId()) || items[0];
        // Refresh configuration without interrupting a form that is already in use.
        if (active?.id !== next.id || active.url !== next.url) select(next);
        else {
          active = next;
          $('active-name').textContent = next.name;
          $('active-remark').textContent = next.remark;
          $('content-frame').title = next.name;
          updateButtons(next.id);
        }
      }
    } catch {
      $('load-status').textContent = '暂时无法读取最新配置，请重试。';
      $('load-status').hidden = false;
      $('retry-load').hidden = false;
    } finally { loading = false; }
  }
  $('reload-frame').addEventListener('click', () => { if (active) select(active); });
  $('enter-fullscreen').addEventListener('click', () => setFullscreen(true));
  $('exit-fullscreen').addEventListener('click', () => setFullscreen(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('frame-fullscreen')) setFullscreen(false); });
  $('retry-load').addEventListener('click', load);
  window.addEventListener('pageshow', load);
  window.addEventListener('hashchange', () => { const item = items.find(item => item.id === hashId()); if (item && item.id !== active?.id) select(item, false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
