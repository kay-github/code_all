(function (root) {
  const defaults = {
    title: '大杂烩工具站',
    subtitle: '轻量、直接、即开即用。',
    items: [
      { id: 'proofreader', name: '错别字校对', description: '快速检查中文错别字和标点。', url: '/tools/typo-proofreader/', icon: '校', image: '', color: 'blue', visible: true, newTab: false },
      { id: 'notes', name: '临时笔记本', description: '免登录笔记空间，快速访问和复制内容。', url: 'https://note.688680.xyz/', icon: '记', image: '', color: 'orange', visible: true, newTab: false },
      { id: 'shooter', name: '飞机大战', description: '割草无双小游戏，自动开火，走位清屏。', url: '/shooter.html', icon: '战', image: '', color: 'green', visible: true, newTab: false },
      { id: 'grid', name: '网格交易管理器', description: '记录网格参数和交易流水，支持云端同步。', url: '/tools/grid-trading-manager/', icon: '格', image: '', color: 'blue', visible: true, newTab: false },
      { id: 'stocks', name: '股票回撤研究室', description: '研究真实历史回撤，测算反弹、估值与持仓。', url: '/tools/stock-rebound-lab/', icon: '研', image: '', color: 'blue', visible: true, newTab: false },
      { id: 'volume', name: '量能观察台', description: 'ETF与个股盘中量能、历史均量及双图联动对比。', url: '/tools/volume-lab/', icon: '量', image: '', color: 'green', visible: true, newTab: false },
      { id: 'optical', name: '光通信跌幅榜', description: 'A股光通信产业链跌幅榜单，盘中实时刷新，收盘自动更新。', url: '/tools/optical-decline-board/', icon: '光', image: '', color: 'purple', visible: true, newTab: false },
    ],
  };
  if (typeof module === 'object' && module.exports) module.exports = defaults;
  else root.ToolSiteDefaults = defaults;
})(typeof window === 'undefined' ? globalThis : window);
