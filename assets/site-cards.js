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
  function render(container, items, preview = false) {
    container.replaceChildren(...items.filter(item => item.visible && safeUrl(item.url)).map(item => card(item, preview)));
    if (!container.children.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = '暂时没有可用的工具入口。';
      container.append(empty);
    }
  }
  window.ToolSiteCards = { render };
})();
