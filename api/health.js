const { MAX_TEXT_CHARS, MODEL, PROVIDER } = require("../lib/proofreader");
const { getModelConfig, isModelConfigured } = require("../lib/modelProofreader");

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
  const modelConfig = getModelConfig();
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    provider: isModelConfigured() ? "Xfyun Qwen Corrector" : PROVIDER,
    model: isModelConfigured() ? modelConfig.model : MODEL,
    fallbackProvider: PROVIDER,
    modelConfigured: isModelConfigured(),
    loaded: true,
    maxTextChars: MAX_TEXT_CHARS
  }));
};
