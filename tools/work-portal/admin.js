(() => {
  const $ = id => document.getElementById(id);
  let config = null;
  let dirty = false;
  let busy = false;

  function message(id, text, kind = '') { $(id).textContent = text; $(id).className = `message ${kind}`; }
  function loginView() { $('editor').hidden = true; $('login-panel').hidden = false; $('login-button').disabled = false; dirty = false; }
  function pending(value) { busy = value; $('save').disabled = value; $('reload').disabled = value; $('logout').disabled = value; $('config-fields').disabled = value; }
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
    data.items.forEach((item, index) => {
      const fragment = $('item-template').content.cloneNode(true);
      const card = fragment.querySelector('.edit-card');
      card.dataset.id = item.id;
      card.setAttribute('aria-label', `${index + 1}. ${item.name}`);
      fragment.querySelector('.number').textContent = String(index + 1).padStart(2, '0');
      fragment.querySelector('h2').textContent = item.name;
      for (const name of ['name', 'url', 'remark']) fragment.querySelector(`[name="${name}"]`).value = item[name];
      $('items').append(fragment);
    });
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
  $('config-form').addEventListener('input', () => { dirty = true; $('save-state').textContent = '有尚未保存的修改'; message('editor-message', ''); });
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
      else message('editor-message', error.message, 'error');
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
