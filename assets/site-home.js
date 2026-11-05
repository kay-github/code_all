(async function () {
  // Only embed reviewed tools. Admin-configured links to other pages keep their link behavior.
  const toolPaths = {
    investment: '/tools/investment-theory/',
    notes: '/notes/',
    grid: '/tools/grid-trading-manager/',
    stocks: '/tools/stock-rebound-lab/',
    volume: '/tools/volume-lab/',
    optical: '/tools/optical-decline-board/',
    gjd: '/tools/national-team-etf/',
  };
  const aliases = new Map([['/gjd/', 'gjd'], ['/txdp/', 'optical']]);
  for (const [id, path] of Object.entries(toolPaths)) aliases.set(path, id);

  const byId = id => document.getElementById(id);
  const menu = byId('tool-menu');
  const menuButton = byId('menu-open');
  const panels = byId('tool-panels');
  const frames = new Map();
  let tools = new Map();
  let siteTitle;
  let activeFrame;

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

  function render(config) {
    siteTitle = config.title;
    byId('site-title').textContent = siteTitle;
    document.querySelector('.subtitle').textContent = config.subtitle;
    tools = new Map();
    const cards = config.items.filter(item => item.visible).map(item => {
      const id = toolId(item.url);
      if (!id) return item;
      tools.set(id, item);
      return { ...item, url: workspaceLink(id), newTab: false, workspaceId: id };
    });
    const menuGroups = [];
    for (const [name, entries] of window.ToolSiteCards.group(cards)) {
      const section = document.createElement('section');
      section.className = 'menu-group';
      const title = document.createElement('h3');
      title.className = 'menu-category';
      title.textContent = name;
      section.append(title, ...entries.map(menuLink));
      menuGroups.push(section);
    }
    window.ToolSiteCards.render(byId('tools'), cards);
    byId('menu-items').replaceChildren(...menuGroups);
    showRoute();
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
