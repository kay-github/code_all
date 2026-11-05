(function () {
  const key = 'tool-site:theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  const valid = value => value === 'dark' || value === 'light' ? value : null;
  let preference = null;
  try { preference = valid(localStorage.getItem(key)); } catch { /* Use system appearance. */ }

  function apply() {
    root.dataset.siteTheme = preference || (system.matches ? 'dark' : 'light');
    document.dispatchEvent(new Event('sitethemechange'));
  }
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue);
    apply();
  });
  window.ToolSiteTheme = {
    toggle() {
      preference = root.dataset.siteTheme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Apply for the current page. */ }
      apply();
    },
  };
  apply();
})();
