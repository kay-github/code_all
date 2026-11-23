(function () {
  const CATEGORY_META = {
    盯盘看板: { color: 'board', hint: '盘中和收盘后自动更新，先看异动' },
    资金与持仓: { color: 'flow', hint: '谁在买，仓位有没有回来' },
    研究与情景: { color: 'research', hint: '回撤、概率与路径推演' },
    投资管理与工具: { color: 'tool', hint: '仓位计划、交易流水与速记' },
  };
  const FALLBACK = { color: 'tool', hint: '' };

  function safeUrl(value, image) {
    if (typeof value !== 'string' || !value || /[\x00-\x20\x7f\\]/.test(value)) return false;
    if (value.startsWith('/') && !value.startsWith('//')) return true;
    try {
      const url = new URL(value);
      return (image ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) && !url.username && !url.password;
    } catch { return false; }
  }
  function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    if (text) el.textContent = text;
    return el;
  }
  function card(item, preview = false) {
    const link = document.createElement(preview ? 'div' : 'a');
    link.className = 'tool-card';
    link.dataset.color = item.color || 'tool';
    if (!preview) {
      link.href = item.url;
      link.setAttribute('aria-label', `打开${item.name}`);
      if (item.newTab) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    }
    const top = span('tool-topline');
    const icon = span('tool-icon', item.icon);
    icon.setAttribute('aria-hidden', 'true');
    if (safeUrl(item.image, true)) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.src = item.image;
      image.addEventListener('error', () => { icon.textContent = item.icon; }, { once: true });
      icon.replaceChildren(image);
    }
    top.append(icon);
    if (item.badge) top.append(span('tool-badge', item.badge));
    const content = span('tool-content');
    const nameRow = span('tool-name-row');
    nameRow.append(span('tool-name', item.name), span('tool-arrow', '›'));
    content.append(nameRow, span('tool-desc', item.description));
    link.append(top, content);
    return link;
  }
  function order() {
    return window.ToolSiteDefaults?.categoryOrder || Object.keys(CATEGORY_META);
  }
  function group(items) {
    const categories = new Map();
    for (const item of items) {
      if (!item.visible || !safeUrl(item.url)) continue;
      const name = item.category?.trim() || '其他工具';
      if (!categories.has(name)) categories.set(name, []);
      categories.get(name).push(item);
    }
    const sorted = new Map();
    for (const name of order()) if (categories.has(name)) sorted.set(name, categories.get(name));
    for (const [name, entries] of categories) if (!sorted.has(name)) sorted.set(name, entries);
    return sorted;
  }
  function render(container, items, preview = false) {
    const sections = [];
    for (const [name, entries] of group(items)) {
      const meta = CATEGORY_META[name] || FALLBACK;
      const section = document.createElement('section');
      section.className = 'tool-group';
      section.dataset.color = meta.color;
      const head = document.createElement('div');
      head.className = 'tool-group-head';
      const heading = document.createElement(preview ? 'h3' : 'h2');
      heading.className = 'tool-group-title';
      const dot = span('group-dot');
      dot.setAttribute('aria-hidden', 'true');
      const count = span('group-count', String(entries.length));
      heading.append(dot, name, count);
      head.append(heading);
      if (meta.hint) {
        const hint = document.createElement('p');
        hint.className = 'tool-group-hint';
        hint.textContent = meta.hint;
        head.append(hint);
      }
      const grid = document.createElement('div');
      grid.className = 'tool-grid';
      grid.append(...entries.map(item => card(item, preview)));
      section.append(head, grid);
      sections.push(section);
    }
    if (!sections.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = '没有匹配的工具，换个关键词试试。';
      sections.push(empty);
    }
    container.replaceChildren(...sections);
  }
  window.ToolSiteCards = { group, render };
})();
