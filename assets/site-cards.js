(function () {
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
    link.dataset.color = item.color;
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
    const arrow = span('tool-arrow', '›');
    arrow.setAttribute('aria-hidden', 'true');
    top.append(icon, arrow);
    const content = span('tool-content');
    content.append(span('tool-name', item.name), span('tool-desc', item.description));
    link.append(top, content);
    return link;
  }
  function group(items) {
    const categories = new Map();
    for (const item of items) {
      if (!item.visible || !safeUrl(item.url)) continue;
      const name = item.category?.trim() || '其他工具';
      if (!categories.has(name)) categories.set(name, []);
      categories.get(name).push(item);
    }
    return categories;
  }
  function render(container, items, preview = false) {
    const sections = [];
    for (const [name, entries] of group(items)) {
      const section = document.createElement('section');
      section.className = 'tool-group';
      const heading = document.createElement(preview ? 'h3' : 'h2');
      heading.className = 'tool-group-title';
      heading.textContent = name;
      const grid = document.createElement('div');
      grid.className = 'tool-grid';
      grid.append(...entries.map(item => card(item, preview)));
      section.append(heading, grid);
      sections.push(section);
    }
    if (!sections.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = '暂时没有可用的工具入口。';
      sections.push(empty);
    }
    container.replaceChildren(...sections);
  }
  window.ToolSiteCards = { group, render };
})();
