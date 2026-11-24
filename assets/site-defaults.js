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
      { id: 'cnvix', category: '盯盘与资金', name: '中国波指', description: 'A 股 30 天隐含波动率', badge: '每日 16:50', url: '/cnvix', icon: '波', color: 'board', tone: 'violet', kicker: '波动率', visible: true, image: '', newTab: false },
      { id: 'marketPulse', category: '盯盘与资金', name: '资金面盘面说明', description: '每日收盘后资金面复盘', badge: '每日 16:10', url: '/pulse', icon: '盘', color: 'board', tone: 'cyan', kicker: '资金面', visible: true, image: '', newTab: false },
      { id: 'gjd', category: '盯盘与资金', name: '国家队ETF追踪', description: '汇金 ETF 申赎与托底进度', badge: '次日更新', url: '/tools/national-team-etf/', icon: '国', color: 'board', tone: 'blue', kicker: '托底', visible: true, image: '', newTab: false },
      { id: 'fundRecovery', category: '盯盘与资金', name: '光模块双龙仓位回补', description: '基金是否已买回新易盛/旭创', badge: '每日 08:43', url: '/tools/fund-dragon-recovery/', icon: '仓', color: 'board', tone: 'indigo', kicker: '机构仓位', visible: true, image: '', newTab: false },
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
