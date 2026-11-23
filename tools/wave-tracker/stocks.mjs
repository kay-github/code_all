import { renderStockStudy } from './stock-view.mjs?v=1';

const root = document.getElementById('stock-study-content');
async function load() {
  try {
    const response = await fetch('/tools/wave-tracker/data/stocks.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('个股数据读取失败');
    const payload = await response.json();
    if (!payload.results?.length) throw new Error('个股数据未就绪');
    renderStockStudy(root, payload);
  } catch (error) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新加载';
    retry.addEventListener('click', load, { once: true });
    root.replaceChildren(document.createTextNode(`${error.message}。 `), retry);
  }
}
load();
