(() => {
  const $ = id => document.getElementById(id);
  let config = null;
  let dirty = false;
  let busy = false;
  const MAX_ITEMS = 50;

  function message(id, text, kind = '') { $(id).textContent = text; $(id).className = `message ${kind}`; }
  function loginView() { $('editor').hidden = true; $('login-panel').hidden = false; $('login-button').disabled = false; dirty = false; }
  function pending(value) { busy = value; $('save').disabled = value || !config; $('reload').disabled = value; $('logout').disabled = value; $('config-fields').disabled = value; updatePositions(); }
  function changed() { dirty = true; $('save-state').textContent = '有尚未保存的修改'; message('editor-message', ''); }
  function updatePositions() {
    const cards = [...$('items').children];
    cards.forEach((card, index) => {
      const name = card.querySelector('[name="name"]').value.trim() || '新入口';
      card.querySelector('.number').textContent = String(index + 1).padStart(2, '0');
      card.querySelector('h2').textContent = name;
      card.setAttribute('aria-label', `${index + 1}. ${name}`);
      card.querySelector('[data-action="up"]').disabled = index === 0;
      card.querySelector('[data-action="down"]').disabled = index === cards.length - 1;
    });
    $('item-count').textContent = `${cards.length} 个入口 · 最多 ${MAX_ITEMS} 个`;
    $('empty-items').hidden = cards.length > 0;
    $('add-item').disabled = busy || !config || cards.length >= MAX_ITEMS;
  }
  function appendItem(item) {
    const fragment = $('item-template').content.cloneNode(true);
    const card = fragment.querySelector('.edit-card');
    card.dataset.id = item.id;
    for (const name of ['name', 'url', 'remark']) card.querySelector(`[name="${name}"]`).value = item[name];
    $('items').append(fragment);
    return card;
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/api/portal/${path}`, { cache: 'no-store', ...options, signal: controller.signal });
      const data = await response.json();
      if (!response.ok) { const error = new Error(data.error || '操作未完成，请重试'); error.status = response.status; throw error; }
      return data;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('网络连接暂时不可用，请稍后重试');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function render(data) {
    config = data;
    $('items').replaceChildren();
    data.items.forEach(appendItem);
    updatePositions();
    dirty = false;
    $('save-state').textContent = '全部修改已保存';
    $('updated-at').textContent = data.updatedAt ? `上次保存：${new Date(data.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '当前为初始配置';
  }
  async function loadConfig() {
    if (busy) return;
    $('login-panel').hidden = true;
    $('editor').hidden = false;
    pending(true);
    message('editor-message', '正在读取配置…');
    try { render(await api('config')); message('editor-message', ''); }
    catch (error) { message('editor-message', error.message, 'error'); $('save-state').textContent = '读取未完成，请重新加载'; }
    finally { pending(false); $('save').disabled = !config; }
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('login-button').disabled = true;
    message('login-message', '正在验证…');
    try {
      await api('auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
      $('password').value = '';
      message('login-message', '');
      await loadConfig();
    } catch (error) { message('login-message', error.message, 'error'); }
    finally { $('login-button').disabled = false; }
  });
  $('config-form').addEventListener('input', () => { changed(); updatePositions(); });
  $('add-item').addEventListener('click', () => {
    if (busy || !config || $('items').children.length >= MAX_ITEMS) return;
    const card = appendItem({ id: `entry-${crypto.randomUUID()}`, name: '', url: '', remark: '' });
    changed();
    updatePositions();
    card.querySelector('[name="name"]').focus();
  });
  $('items').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || busy) return;
    const card = button.closest('.edit-card');
    const action = button.dataset.action;
    if (action === 'up' && card.previousElementSibling) card.previousElementSibling.before(card);
    else if (action === 'down' && card.nextElementSibling) card.nextElementSibling.after(card);
    else if (action === 'delete') card.remove();
    else return;
    changed();
    updatePositions();
    if (action === 'delete') message('editor-message', '入口已移除，点击“保存全部修改”后生效。重新加载可放弃未保存的改动。');
    else {
      // The same card stays focused when its position changes, including at a boundary.
      const next = card.querySelector(`[data-action="${action}"]`);
      (next.disabled ? card.querySelector(`[data-action="${action === 'up' ? 'down' : 'up'}"]`) : next).focus();
    }
  });
  $('config-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !config) return;
    const items = [...$('items').querySelectorAll('.edit-card')].map(card => ({ id: card.dataset.id, ...Object.fromEntries(['name', 'url', 'remark'].map(name => [name, card.querySelector(`[name="${name}"]`).value])) }));
    pending(true);
    $('save').textContent = '正在保存…';
    message('editor-message', '');
    try {
      render(await api('config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: config.version, items }) }));
      message('editor-message', '保存成功，前台刷新后即可看到最新内容。', 'success');
    } catch (error) {
      if (error.status === 401) { loginView(); message('login-message', '登录已过期，请重新输入授权密码。', 'error'); }
      else { message('editor-message', error.message, 'error'); $('save-state').textContent = '保存未完成，修改仍保留在本页'; }
    } finally { pending(false); $('save').textContent = '保存全部修改'; }
  });
  $('reload').addEventListener('click', () => { if (!dirty || confirm('重新加载会放弃尚未保存的修改，是否继续？')) loadConfig(); });
  $('logout').addEventListener('click', async () => {
    if (dirty && !confirm('退出会放弃尚未保存的修改，是否继续？')) return;
    try { await api('auth', { method: 'DELETE' }); loginView(); config = null; $('items').replaceChildren(); message('login-message', '已退出后台'); }
    catch (error) { message('editor-message', error.message, 'error'); }
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  api('auth').then(data => { if (data.authenticated) loadConfig(); else { loginView(); message('login-message', ''); } }).catch(error => { loginView(); message('login-message', error.message, 'error'); });
})();
