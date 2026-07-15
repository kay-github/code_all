const { MAX_TEXT_CHARS, MODEL, PROVIDER } = require("../lib/proofreader");
const { getProviderStatus, isModelConfigured } = require("../lib/modelProofreader");

module.exports = function handler(req, res) {
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
