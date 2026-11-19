const { MAX_TEXT_CHARS, MODEL, PROVIDER } = require("../lib/proofreader");
const { getProviderStatus, isModelConfigured } = require("../lib/modelProofreader");

module.exports = function handler(req, res) {
  // Reuse this existing function for the Top Radar control API so the Hobby
  // plan's 12-serverless-function limit is not exceeded. The public URL is
  // rewritten in vercel.json: /api/top-radar -> /api/health?tool=top-radar.
  if (req.query && req.query.tool === 'top-radar') {
    return require('../lib/topRadarApi')(req, res);
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const providers = getProviderStatus();
  const active = providers.find((item) => item.configured && !item.coolingDown) || providers.find((item) => item.configured);
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    provider: active ? active.name : PROVIDER,
    model: active ? active.model : MODEL,
    fallbackProvider: PROVIDER,
    modelConfigured: isModelConfigured(),
    providers,
    loaded: true,
    maxTextChars: MAX_TEXT_CHARS
  }));
};
