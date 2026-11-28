(function (root) {
  const defaults = {
    title: '大杂烩工具站',
    subtitle: '行情看板、研究工具、持仓记账，按用途分组。',
    // 顺序即首页分组顺序。description 控制在 18 字内，badge 只标自动更新频率。
    // tone 是每张卡片自己的色相，kicker 是角色标签；同组内靠这两个字段拉开区别。
    categoryOrder: ['盯盘与资金', '研究与情景', '投资管理与工具'],
    items: [
      { id: 'taoding', category: '盯盘与资金', name: '逃顶雷达', description: '顶部信号分档，触发微信提醒', badge: '每日 15:10', url: '/taoding', icon: '顶', color: 'board', tone: 'ember', kicker: '顶部风险', visible: true, image: '', newTab: false },
      { id: 'optical', category: '盯盘与资金', name: '光通信跌幅榜', description: '产业链个股跌幅排行', badge: '盘中实时', url: '/tools/optical-decline-board/', icon: '光', color: 'board', tone: 'rose', kicker: '产业链', visible: true, image: '', newTab: false },
      { id: 'volume', category: '盯盘与资金', name: '量能观察台', description: '盘中量能与历史均量对比', badge: '盘中实时', url: '/tools/volume-lab/', icon: '量', color: 'board', tone: 'teal', kicker: '量能', visible: true, image: '', newTab: false },
      { id: 'marketPulse', category: '盯盘与资金', name: '资金面盘面说明', description: '午盘与收盘资金面复盘', badge: '11:30 / 15:00', url: '/pulse', icon: '盘', color: 'board', tone: 'cyan', kicker: '资金面', visible: true, image: '', newTab: false },
      { id: 'sectorRotation', category: '盯盘与资金', name: 'A股板块轮动', description: '行业ETF入场、离场与强弱排名', badge: '收盘后', url: '/tools/sector-rotation/', icon: '轮', color: 'board', tone: 'indigo', kicker: '板块信号', visible: true, image: '', newTab: false },
      { id: 'trendSignals', category: '盯盘与资金', name: '趋势买卖点', description: '核心指数趋势买卖点与回测', badge: '每日 15:35', url: '/trend', icon: '势', color: 'board', tone: 'amber', kicker: '趋势信号', visible: true, image: '', newTab: false },
      { id: 'waveDiscovery', category: '盯盘与资金', name: '主升浪发现器', description: '行业 ETF 主升浪早期线索', badge: '每日 15:35', url: '/wave', icon: '升', color: 'board', tone: 'rose', kicker: '主升浪', visible: true, image: '', newTab: false },
      { id: 'marketPulseHistory', category: '盯盘与资金', name: '资金面历史档案', description: '按日回看午盘与收盘归档', badge: '每日归档', url: '/pulse/history', icon: '档', color: 'board', tone: 'violet', kicker: '历史', visible: true, image: '', newTab: false },
      { id: 'gjd', category: '盯盘与资金', name: '国家队ETF追踪', description: '汇金 ETF 申赎与托底进度', badge: '次日更新', url: '/tools/national-team-etf/', icon: '国', color: 'board', tone: 'blue', kicker: '托底', visible: true, image: '', newTab: false },
      { id: 'fundRecovery', category: '盯盘与资金', name: '光模块双龙仓位回补', description: '根据净值与定报观察双龙回补线索，区分收益关联和已披露持仓。', badge: '每日 08:43', url: '/tools/fund-dragon-recovery/', icon: '仓', color: 'board', tone: 'indigo', kicker: '机构仓位', visible: true, image: '', newTab: false },
      { id: 'stocks', category: '研究与情景', name: '股票回撤研究室', description: '历史回撤与反弹测算', url: '/tools/stock-rebound-lab/', icon: '研', color: 'research', tone: 'rose', kicker: '回撤', visible: true, image: '', newTab: false },
      { id: 'cycleMirror', category: '研究与情景', name: '周期镜像', description: '5·19 与 9·24 走势叠加追踪', badge: '每日 15:20', url: '/mirror', icon: '镜', color: 'research', tone: 'indigo', kicker: '周期', visible: true, image: '', newTab: false },
      { id: 'waveTracker', category: '研究与情景', name: '指数波浪跟踪', description: '三大指数波浪情景与点位', badge: '收盘后', url: '/waves', icon: '浪', color: 'research', tone: 'cyan', kicker: '波浪', visible: true, image: '', newTab: false },
      { id: 'investment', category: '投资管理与工具', name: '333投资理论', description: '三类仓位与投资目标管理', url: '/tools/investment-theory/', icon: '333', color: 'tool', tone: 'blue', kicker: '仓位', visible: true, image: '', newTab: false },
      { id: 'grid', category: '投资管理与工具', name: '网格交易管理器', description: '网格参数与交易流水', url: '/tools/grid-trading-manager/', icon: '格', color: 'tool', tone: 'teal', kicker: '交易', visible: true, image: '', newTab: false },
      { id: 'notes', category: '投资管理与工具', name: '临时笔记本', description: '免登录速记与复制', url: '/notes/', icon: '记', color: 'tool', tone: 'amber', kicker: '速记', visible: true, image: '', newTab: false },
    ],
  };
  if (typeof module === 'object' && module.exports) module.exports = defaults;
  else root.ToolSiteDefaults = defaults;
})(typeof window === 'undefined' ? globalThis : window);
