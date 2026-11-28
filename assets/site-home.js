(async function () {
  // Only embed reviewed tools. Admin-configured links to other pages keep their link behavior.
  const toolPaths = {
    taoding: '/taoding',
    investment: '/tools/investment-theory/',
    notes: '/notes/',
    grid: '/tools/grid-trading-manager/',
    stocks: '/tools/stock-rebound-lab/',
    volume: '/tools/volume-lab/',
    optical: '/tools/optical-decline-board/',
    gjd: '/tools/national-team-etf/',
    fundRecovery: '/tools/fund-dragon-recovery/',
    waveTracker: '/waves',
    marketPulse: '/pulse',
    marketPulseHistory: '/pulse/history',
    cycleMirror: '/mirror',
    trendSignals: '/trend',
    waveDiscovery: '/wave',
  };
  const aliases = new Map([['/gjd/', 'gjd'], ['/txdp/', 'optical'], ['/jjhc/', 'fundRecovery'], ['/taoding', 'taoding'], ['/taoding/', 'taoding'], ['/waves/', 'waveTracker'], ['/pulse', 'marketPulse'], ['/pulse/', 'marketPulse'], ['/pulse/history', 'marketPulseHistory'], ['/pulse/history/', 'marketPulseHistory'], ['/mirror', 'cycleMirror'], ['/mirror/', 'cycleMirror'], ['/cycle-mirror', 'cycleMirror'], ['/cycle-mirror/', 'cycleMirror'], ['/trend/', 'trendSignals'], ['/trends', 'trendSignals'], ['/trends/', 'trendSignals'], ['/wave', 'waveDiscovery'], ['/wave/', 'waveDiscovery'], ['/main-wave', 'waveDiscovery'], ['/main-wave/', 'waveDiscovery']]);
  for (const [id, path] of Object.entries(toolPaths)) aliases.set(path, id);

  const byId = id => document.getElementById(id);
  const menu = byId('tool-menu');
  const menuButton = byId('menu-open');
  const panels = byId('tool-panels');
  const search = byId('tool-search');
  const countLabel = byId('tool-count');
  const frames = new Map();
  let tools = new Map();
  let cards = [];
  let siteTitle;
  let activeFrame;

  function updateThemeButton() {
    const label = document.documentElement.dataset.siteTheme === 'dark' ? '浅色' : '深色';
    byId('theme-label').textContent = label;
    byId('theme-toggle').setAttribute('aria-label', '切换到' + label);
  }
  byId('theme-toggle').addEventListener('click', () => window.ToolSiteTheme.toggle());
  document.addEventListener('sitethemechange', updateThemeButton);
  updateThemeButton();

  // 代码里的目录是权威版本：后台配置只补充未登记的外部链接，并保留显隐开关。
  // 这样新加的功能页不会因为后台配置陈旧而从首页消失。
  function normalize(config) {
    const base = window.ToolSiteDefaults;
    const configured = Array.isArray(config?.items) ? config.items : [];
    const key = value => String(value || '').replace(/\/+$/, '');
    const byUrl = new Map(configured.filter(item => item && item.url).map(item => [key(item.url), item]));
    const items = base.items.map(item => {
      const remote = byUrl.get(key(item.url));
      return remote && typeof remote.visible === 'boolean' ? { ...item, visible: remote.visible } : { ...item };
    });
    const known = new Set(base.items.map(item => key(item.url)));
    for (const item of configured) {
      if (item && item.url && !known.has(key(item.url))) items.push({ color: 'tool', visible: true, ...item });
    }
    return { title: base.title, subtitle: base.subtitle, items };
  }

  function toolId(url) {
    const link = new URL(url, location.origin);
    if (link.origin !== location.origin || link.search || link.hash) return null;
    const path = link.pathname.replace(/\/index\.html$/, '/').replace(/\/?$/, '/');
    return aliases.get(path);
  }

  function workspaceLink(id) {
    return id ? '/?tool=' + id : '/';
  }

  function isPlainClick(event) {
    return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  function navigate(id) {
    if (menu.open) menu.close();
    if (location.pathname + location.search !== workspaceLink(id)) history.pushState(null, '', workspaceLink(id));
    showRoute();
  }

  function getFrame(id, item) {
    if (frames.has(id)) return frames.get(id);
    const frame = document.createElement('iframe');
    frame.className = 'tool-frame';
    frame.title = item.name;
    frame.src = toolPaths[id];
    frame.addEventListener('load', () => {
      // Existing tool links back to the homepage should return to this workspace.
      frame.contentDocument?.addEventListener('click', event => {
        const link = event.target.closest('a[href]');
        if (!link || !isPlainClick(event) || (link.target && !['_self', '_top'].includes(link.target))) return;
        const target = new URL(link.href);
        const id = target.searchParams.get('tool');
        if (target.origin === location.origin && ['/', '/index.html'].includes(target.pathname) &&
            ((!target.search && !target.hash) || (tools.has(id) && target.search === '?tool=' + id && !target.hash))) {
          event.preventDefault();
          navigate(id);
        }
      });
    });
    frames.set(id, frame);
    panels.append(frame);
    return frame;
  }

  function setFrameVisible(frame, visible) {
    frame.hidden = !visible;
    frame.inert = !visible;
    frame.contentDocument?.dispatchEvent(new Event('toolvisibilitychange'));
  }

  function showRoute() {
    const id = new URLSearchParams(location.search).get('tool');
    const item = tools.get(id);
    const frame = item ? getFrame(id, item) : null;
    if (frame !== activeFrame) {
      if (activeFrame) setFrameVisible(activeFrame, false);
      byId('home').hidden = Boolean(frame);
      panels.hidden = !frame;
      if (frame) setFrameVisible(frame, true);
      activeFrame = frame;
    }
    byId('workspace-title').textContent = item ? item.name : '首页';
    document.title = item ? `${item.name} · ${siteTitle}` : siteTitle;
    for (const link of menu.querySelectorAll('[data-tool]')) {
      if (link.dataset.tool === (item ? id : '')) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function menuLink(entry) {
    const link = document.createElement('a');
    link.className = 'menu-link';
    link.href = entry.url;
    if (entry.workspaceId) link.dataset.tool = entry.workspaceId;
    if (entry.newTab) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    const icon = document.createElement('span');
    icon.className = 'menu-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = entry.icon;
    link.append(icon, entry.name);
    return link;
  }

  function buildMenu(items) {
    const groups = [];
    for (const [name, entries] of window.ToolSiteCards.group(items)) {
      const section = document.createElement('section');
      section.className = 'menu-group';
      const title = document.createElement('h3');
      title.className = 'menu-category';
      title.textContent = name;
      section.append(title, ...entries.map(menuLink));
      groups.push(section);
    }
    byId('menu-items').replaceChildren(...groups);
  }

  function matches(entry, query) {
    if (!query) return true;
    return [entry.name, entry.description, entry.category, entry.badge]
      .filter(Boolean).join(' ').toLowerCase().includes(query);
  }

  function paint() {
    const query = search ? search.value.trim().toLowerCase() : '';
    const shown = cards.filter(entry => matches(entry, query));
    window.ToolSiteCards.render(byId('tools'), shown);
    if (countLabel) countLabel.textContent = query ? `${shown.length} 个匹配` : `${shown.length} 个`;
  }

  function render(config) {
    const catalog = normalize(config);
    siteTitle = catalog.title;
    byId('site-title').textContent = siteTitle;
    byId('workspace-title').textContent = '首页';
    document.querySelector('.subtitle').textContent = catalog.subtitle;
    tools = new Map();
    cards = catalog.items.filter(item => item.visible).map(item => {
      const id = toolId(item.url);
      if (!id) return item;
      tools.set(id, item);
      return { ...item, url: workspaceLink(id), newTab: false, workspaceId: id };
    });
    buildMenu(cards);
    paint();
    showRoute();
  }

  if (search) {
    search.addEventListener('input', paint);
    search.addEventListener('keydown', event => {
      if (event.key === 'Escape') { search.value = ''; paint(); search.blur(); }
    });
    document.addEventListener('keydown', event => {
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
        event.preventDefault();
        search.focus();
      }
    });
  }

  menuButton.addEventListener('click', () => {
    menu.showModal();
    menuButton.setAttribute('aria-expanded', 'true');
  });
  menu.addEventListener('close', () => menuButton.setAttribute('aria-expanded', 'false'));
  menu.addEventListener('click', event => {
    if (event.target === menu && event.clientX > menu.getBoundingClientRect().right) menu.close();
  });
  byId('menu-home').dataset.tool = '';
  for (const container of [byId('tools'), byId('bar-home'), menu]) {
    container.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link || !isPlainClick(event)) return;
      const url = new URL(link.href);
      const id = url.searchParams.get('tool');
      if (!link.target && url.origin === location.origin && url.pathname === '/' && (tools.has(id) || !url.search)) {
        event.preventDefault();
        navigate(id);
      } else if (menu.open) menu.close();
    });
  }
  window.addEventListener('popstate', () => {
    if (menu.open) menu.close();
    showRoute();
  });
  render(window.ToolSiteDefaults);
  try {
    const response = await fetch('/api/site/config', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (response.ok) render(await response.json());
  } catch { /* Keep the built-in entries available if the network is unavailable. */ }
})();
