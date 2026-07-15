const { MAX_TEXT_CHARS, MODEL, PROVIDER, buildDiffCorrections, proofreadText } = require("../lib/proofreader");
const { isModelConfigured, proofreadWithModel } = require("../lib/modelProofreader");

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function readRequestText(payload) {
  if (payload && typeof payload.text === "string") {
    return payload.text;
  }

  if (payload && Array.isArray(payload.messages)) {
    for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
      const item = payload.messages[index];
      if (item && item.role === "user" && typeof item.content === "string") {
        return item.content;
      }
    }
  }

  if (payload && typeof payload.input === "string") {
    return payload.input;
  }

  return "";
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }

  if (typeof req.body === "string") {
    return Promise.resolve(JSON.parse(req.body || "{}"));
  }

  if (typeof req.on !== "function") {
    return Promise.resolve({});
  }

  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(rawBody || "{}"));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", message: "仅支持 POST 请求" });
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (error) {
    sendJson(res, 400, { error: "BAD_REQUEST", message: "请求格式错误" });
    return;
  }

  const text = readRequestText(payload);
  if (!text.trim()) {
    sendJson(res, 400, { error: "EMPTY_TEXT", message: "请输入待校对文本" });
    return;
  }

  if (text.length > MAX_TEXT_CHARS) {
    sendJson(res, 413, {
      error: "TEXT_TOO_LONG",
      message: `文本过长，请控制在 ${MAX_TEXT_CHARS} 字以内`
    });
    return;
  }

  const ruleResult = proofreadText(text);
  let result = ruleResult.result;
  let corrections = ruleResult.corrections;
  let model = MODEL;
  let provider = PROVIDER;
  let fallback = false;
  let attempts = [];

  if (isModelConfigured()) {
    try {
      const modelResult = await proofreadWithModel(text);
      result = proofreadText(modelResult.corrected).result;
      corrections = buildDiffCorrections(text, result);
      model = modelResult.model;
      provider = modelResult.provider;
      attempts = modelResult.attempts || [];

      if (result === text && ruleResult.result !== text) {
        result = ruleResult.result;
        corrections = ruleResult.corrections;
        provider = `${modelResult.provider} + ${PROVIDER}`;
      }
    } catch (error) {
      fallback = true;
      attempts = error.attempts || [];
    }
  }

  sendJson(res, 200, {
    result,
    text: result,
    correctedText: result,
    corrections,
    model,
    provider,
    attempts,
    fallback
  });
};
