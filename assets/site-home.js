(async function () {
  function render(config) {
    document.title = config.title;
    document.querySelector('.title').textContent = config.title;
    document.querySelector('.subtitle').textContent = config.subtitle;
    window.ToolSiteCards.render(document.getElementById('tools'), config.items);
  }
  render(window.ToolSiteDefaults);
  try {
    const response = await fetch('/api/site/config', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (response.ok) render(await response.json());
  } catch { /* Keep the built-in entries available if the network is unavailable. */ }
})();
