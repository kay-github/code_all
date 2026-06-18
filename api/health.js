const { MAX_TEXT_CHARS, MODEL, PROVIDER } = require("../lib/proofreader");

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
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    provider: PROVIDER,
    model: MODEL,
    loaded: true,
    maxTextChars: MAX_TEXT_CHARS
  }));
};
