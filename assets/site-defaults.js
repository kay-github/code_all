(function (root) {
  const defaults = {
    title: '大杂烩工具站',
    subtitle: '轻量、直接、即开即用。',
    items: [
      { id: 'investment', category: '投资交易', name: '333投资理论', description: '管理三类仓位，设定投资目标，跟踪基本面、技术与资金及市场情绪。', url: '/tools/investment-theory/', icon: '333', image: '', color: 'blue', visible: true, newTab: false },
      { id: 'notes', category: '效率工具', name: '临时笔记本', description: '免登录笔记空间，快速访问和复制内容。', url: '/notes/', icon: '记', image: '', color: 'orange', visible: true, newTab: false },
      { id: 'grid', category: '投资交易', name: '网格交易管理器', description: '记录网格参数和交易流水，支持云端同步。', url: '/tools/grid-trading-manager/', icon: '格', image: '', color: 'blue', visible: true, newTab: false },
      { id: 'stocks', category: '市场研究', name: '股票回撤研究室', description: '研究真实历史回撤，测算反弹、估值与持仓。', url: '/tools/stock-rebound-lab/', icon: '研', image: '', color: 'blue', visible: true, newTab: false },
      { id: 'volume', category: '市场研究', name: '量能观察台', description: 'ETF与个股盘中量能、历史均量及双图联动对比。', url: '/tools/volume-lab/', icon: '量', image: '', color: 'green', visible: true, newTab: false },
      { id: 'optical', category: '市场研究', name: '光通信跌幅榜', description: 'A股光通信产业链跌幅榜单，盘中实时刷新，收盘自动更新。', url: '/tools/optical-decline-board/', icon: '光', image: '', color: 'purple', visible: true, newTab: false },
      { id: 'fundRecovery', category: '市场研究', name: '光模块双龙仓位回补', description: '根据净值与定报观察双龙回补线索，区分收益关联和已披露持仓。', url: '/tools/fund-dragon-recovery/', icon: '仓', image: '', color: 'purple', visible: true, newTab: false, pinned: true },
      { id: 'gjd', category: '市场研究', name: '国家队ETF追踪', description: '国家队ETF托底买入与本轮资金流向，附924以来完整建仓到派发周期复盘。', url: '/tools/national-team-etf/', icon: '国', image: '', color: 'orange', visible: true, newTab: false },
    ],
  };
  if (typeof module === 'object' && module.exports) module.exports = defaults;
  else root.ToolSiteDefaults = defaults;
})(typeof window === 'undefined' ? globalThis : window);
