(function () {
  const $ = id => document.getElementById(id);
  let config = null, saved = '', csrf = '', busy = false, expiryTimer;
  const dirty = () => config && JSON.stringify(config) !== saved;
  function message(text, type = '') {
    $('status').textContent = text;
    $('status').className = `status ${type}`;
  }
  function showLogin(text = '') {
    clearTimeout(expiryTimer);
    csrf = '';
    $('login-panel').hidden = false;
    $('editor').hidden = true;
    $('logout').hidden = true;
    message(text, text ? 'error' : '');
    $('password').focus();
  }
  function trackSession(data) {
    csrf = data.csrf;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => showLogin('登录已过期。重新登录后可继续编辑，未保存的内容仍保留在此页面。'), Math.max(0, data.expires - Date.now()));
  }
  async function api(path, method = 'GET', body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`/api/site/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || '操作失败，请稍后重试');
      error.status = response.status;
      if (response.status === 429 && response.headers.get('Retry-After')) error.message = `尝试次数过多，请约 ${Math.ceil(Number(response.headers.get('Retry-After')) / 60)} 分钟后再试。`;
      throw error;
    }
    return data;
  }
  function handle(error) {
    const text = error.name === 'TimeoutError' || error.name === 'TypeError' ? '网络请求未完成，请检查网络后重试。' : error.message;
    if (error.status === 401 && !$('editor').hidden) showLogin(`${text}。未保存的内容仍保留在此页面。`);
    else message(text, 'error');
  }
  function setBusy(value) {
    busy = value;
    document.querySelectorAll('#editor input, #editor textarea, #editor select, #editor button, #login-form input, #login-form button, #logout').forEach(el => { el.disabled = value; });
    $('save').textContent = value ? '处理中…' : '保存更改';
    $('login-button').textContent = value ? '请稍候…' : '登录后台 →';
    if (!value && config) sync();
  }
  function sync() {
    const changed = dirty();
    $('save-state').textContent = changed ? '待保存' : '已保存';
    $('save-state').className = `badge${changed ? ' dirty' : ''}`;
    $('changes').textContent = changed ? '有未保存的更改' : '所有更改已保存';
    $('save').disabled = busy || !changed;
    $('add').disabled = busy || config.items.length >= 50;
    $('count').textContent = `${config.items.length} 个 · ${config.items.filter(item => item.visible).length} 个显示`;
    $('empty-editor').hidden = config.items.length > 0;
    $('updated').textContent = config.updatedAt ? `上次保存 ${new Date(config.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '当前为默认配置';
    $('preview-title').textContent = config.title;
    $('preview-subtitle').textContent = config.subtitle;
    window.ToolSiteCards.render($('preview'), config.items, true);
    document.querySelectorAll('[data-move]').forEach(button => {
      const index = config.items.findIndex(item => item.id === button.dataset.id);
      button.disabled = busy || (button.dataset.move === 'up' ? index === 0 : index === config.items.length - 1);
    });
    document.querySelectorAll('[data-clear-image]').forEach(button => {
      button.disabled = busy || !config.items.find(item => item.id === button.dataset.clearImage)?.image;
    });
  }
  function confirmAction(title, text, label = '确认') {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = text;
    $('confirm-button').textContent = label;
    $('confirm-dialog').returnValue = '';
    $('confirm-dialog').showModal();
    return new Promise(resolve => $('confirm-dialog').addEventListener('close', () => resolve($('confirm-dialog').returnValue === 'confirm'), { once: true }));
  }
  function field(item, key, labelText, options = {}) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    const id = `${item.id}-${key}`;
    label.htmlFor = id;
    label.textContent = labelText;
    const input = document.createElement(options.multiline ? 'textarea' : options.choices ? 'select' : 'input');
    input.id = id;
    input.name = id;
    if (options.choices) options.choices.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      input.append(option);
    });
    else {
      input.maxLength = options.max || 2048;
      input.required = !!options.required;
      input.placeholder = options.placeholder || '';
    }
    input.value = item[key];
    input.addEventListener('input', () => {
      item[key] = input.value;
      if (key === 'name') $(`name-${item.id}`).textContent = input.value || '未命名入口';
      sync();
    });
    wrap.append(label, input);
    return wrap;
  }
  function check(item, key, text, article) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = item[key];
    input.addEventListener('change', () => {
      item[key] = input.checked;
      article.classList.toggle('is-hidden', !item.visible);
      sync();
    });
    label.append(input, document.createTextNode(text));
    return label;
  }
  async function imageData(file) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)) throw new Error('请选择 JPG、PNG、WebP、GIF 或 AVIF 图片。');
    if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB，请选择较小的图片。');
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error('图片无法读取，请换一张图片。'); }
    let blob;
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('图片尺寸过大，请选择不超过 4000 万像素的图片。');
      const scale = Math.min(1, 256 / bitmap.width, 256 / bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
    } finally { bitmap.close(); }
    if (!blob) throw new Error('图片处理失败，请换一张图片。');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('图片读取失败，请重试。'));
      reader.readAsDataURL(blob);
    });
  }
  function imageUpload(item) {
    const block = document.createElement('div');
    block.className = 'image-upload';
    const thumb = document.createElement('span');
    thumb.className = 'upload-thumbnail';
    const actions = document.createElement('div');
    actions.className = 'upload-actions';
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'secondary';
    choose.setAttribute('aria-label', `上传${item.name || '入口'}的图标`);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'quiet';
    clear.textContent = '移除图片';
    clear.dataset.clearImage = item.id;
    clear.setAttribute('aria-label', `移除${item.name || '入口'}的图片`);
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
    picker.hidden = true;
    const feedback = document.createElement('p');
    feedback.className = 'field-help upload-feedback';
    feedback.setAttribute('role', 'status');
    feedback.textContent = '支持 JPG、PNG、WebP、GIF、AVIF，最大 10 MB，自动压缩为图标。';
    function refresh() {
      choose.textContent = item.image ? '更换图片' : '上传图片';
      thumb.textContent = item.icon;
      if (item.image) {
        const image = document.createElement('img');
        image.src = item.image;
        image.alt = `${item.name || '入口'}的图标预览`;
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => { thumb.textContent = item.icon; }, { once: true });
        thumb.replaceChildren(image);
      }
    }
    function update(image) {
      item.image = image;
      $(`${item.id}-image`).value = image;
      refresh();
      sync();
    }
    choose.addEventListener('click', () => picker.click());
    clear.addEventListener('click', () => {
      update('');
      feedback.textContent = '已恢复文字图标，保存更改后生效。';
    });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file || busy) return;
      setBusy(true);
      choose.textContent = '上传中…';
      feedback.textContent = '正在处理并上传图片…';
      try {
        const result = await api('image', 'POST', { data: await imageData(file) });
        update(result.image);
        feedback.textContent = '上传成功，已设为此入口图标。点击「保存更改」后首页生效。';
        message('图片上传成功，保存更改后首页生效。', 'success');
      } catch (error) {
        feedback.textContent = error.message;
        handle(error);
      } finally {
        picker.value = '';
        refresh();
        setBusy(false);
      }
    });
    actions.append(choose, clear);
    block.append(thumb, actions, picker, feedback);
    // Also reflect existing manually configured links and text icons in this thumbnail.
    block.refreshImage = refresh;
    refresh();
    return block;
  }
  function renderEntries() {
    $('entries').replaceChildren(...config.items.map((item, index) => {
      const article = document.createElement('article');
      article.className = `entry panel${item.visible ? '' : ' is-hidden'}`;
      const header = document.createElement('div');
      header.className = 'entry-header';
      const number = document.createElement('span');
      number.className = 'entry-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('strong');
      name.className = 'entry-name';
      name.id = `name-${item.id}`;
      name.textContent = item.name || '未命名入口';
      header.append(number, name);
      for (const [direction, arrow, offset] of [['up', '↑', -1], ['down', '↓', 1]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quiet';
        button.dataset.move = direction;
        button.dataset.id = item.id;
        button.textContent = arrow;
        button.setAttribute('aria-label', `${direction === 'up' ? '上移' : '下移'}${item.name}`);
        button.addEventListener('click', () => {
          const target = index + offset;
          if (target < 0 || target >= config.items.length) return;
          [config.items[index], config.items[target]] = [config.items[target], config.items[index]];
          renderEntries();
          document.querySelector(`[data-id="${item.id}"][data-move="${direction}"]`).focus();
        });
        header.append(button);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet danger';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除${item.name}`);
      remove.addEventListener('click', async () => {
        if (await confirmAction('删除这个入口？', `「${item.name || '未命名入口'}」将在保存后从首页移除。`, '删除入口')) {
          config.items = config.items.filter(entry => entry.id !== item.id);
          renderEntries();
        }
      });
      header.append(remove);
      const fields = document.createElement('div');
      fields.className = 'entry-fields';
      fields.append(field(item, 'name', '入口名称', { required: true, max: 40 }), field(item, 'url', '访问地址', { required: true, placeholder: '/tools/example/ 或 https://example.com' }), field(item, 'description', '描述', { max: 200, multiline: true, placeholder: '用一句话介绍这个工具' }));
      const upload = imageUpload(item);
      fields.append(upload);
      const options = document.createElement('div');
      options.className = 'entry-options';
      options.append(check(item, 'visible', '首页显示', article), check(item, 'newTab', '新窗口打开', article));
      fields.append(options);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '图标与图片设置';
      const row = document.createElement('div');
      row.className = 'field-row';
      row.append(field(item, 'icon', '文字图标', { required: true, max: 8 }), field(item, 'color', '图标配色', { choices: [['blue', '晴空蓝'], ['orange', '暖橙色'], ['green', '松叶绿'], ['purple', '浅紫色'], ['slate', '岩石灰']] }));
      const help = document.createElement('p');
      help.className = 'field-help';
      help.textContent = '留空使用文字图标；支持站内图片路径或 HTTPS 图片链接。图片加载失败时自动显示文字图标。';
      details.append(summary, row, field(item, 'image', '图片地址（可选）', { placeholder: 'https://example.com/icon.png' }), help);
      details.addEventListener('input', () => upload.refreshImage());
      fields.append(details);
      article.append(header, fields);
      return article;
    }));
    sync();
  }
  async function enterEditor() {
    if (!dirty()) { config = await api('config?admin=1'); saved = JSON.stringify(config); }
    $('site-title').value = config.title;
    $('site-subtitle').value = config.subtitle;
    $('login-panel').hidden = true;
    $('editor').hidden = false;
    $('logout').hidden = false;
    renderEntries();
    message(dirty() ? '已重新登录，可继续编辑未保存的内容。' : '');
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const password = $('password').value;
    $('password').value = '';
    setBusy(true);
    try { trackSession(await api('auth', 'POST', { password })); await enterEditor(); }
    catch (error) { handle(error); }
    finally { setBusy(false); }
  });
  for (const [id, key] of [['site-title', 'title'], ['site-subtitle', 'subtitle']]) $(''+id).addEventListener('input', () => { config[key] = $(id).value; sync(); });
  $('add').addEventListener('click', () => {
    if (config.items.length >= 50) return;
    const item = { id: `entry-${crypto.randomUUID()}`, name: '', description: '', url: '', icon: '新', image: '', color: 'blue', visible: true, newTab: false };
    config.items.push(item);
    renderEntries();
    $(`${item.id}-name`).focus();
  });
  $('editor').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !dirty()) return;
    setBusy(true);
    try {
      config = await api('config', 'PUT', config);
      saved = JSON.stringify(config);
      $('site-title').value = config.title;
      $('site-subtitle').value = config.subtitle;
      renderEntries();
      message('保存成功。首页刷新后即可看到最新内容。', 'success');
    } catch (error) { handle(error); }
    finally { setBusy(false); }
  });
  $('reload').addEventListener('click', async () => {
    if (dirty() && !await confirmAction('重新加载配置？', '未保存的更改将被丢弃，加载最近一次保存的内容。', '重新加载')) return;
    setBusy(true);
    try {
      const latest = await api('config?admin=1');
      config = latest;
      saved = JSON.stringify(config);
      await enterEditor();
      message('已加载最新配置。', 'success');
    } catch (error) { handle(error); }
    finally { setBusy(false); }
  });
  $('logout').addEventListener('click', async () => {
    if (dirty() && !await confirmAction('退出后台？', '当前有未保存的更改，退出后将丢弃这些更改。', '退出登录')) return;
    setBusy(true);
    try { await api('auth', 'DELETE'); config = null; saved = ''; showLogin(); message('已安全退出。', 'success'); }
    catch (error) { handle(error); }
    finally { setBusy(false); }
  });
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  (async () => {
    setBusy(true);
    try {
      const session = await api('auth');
      if (session.authenticated) { trackSession(session); await enterEditor(); }
      else showLogin();
    } catch (error) { showLogin(); handle(error); }
    finally { setBusy(false); }
  })();
})();
