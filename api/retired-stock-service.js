"use strict";

const RETIRED_AT = "2026-08-15";

module.exports = function retiredStockService(_req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(410).json({
    error: {
      code: "STOCK_SERVICE_RETIRED",
      message: "股票 YTD 与区间统计服务已下线。",
      retiredAt: RETIRED_AT
    }
  });
};

module.exports.RETIRED_AT = RETIRED_AT;
