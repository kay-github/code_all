const MODEL_PROVIDER = "Xfyun Qwen Corrector";
const DEFAULT_BASE_URL = "https://maas-api.cn-huabei-1.xf-yun.com/v2";
const DEFAULT_MODEL = "xopqwen36v35b";
const DEFAULT_LORA_ID = "0";

const SYSTEM_PROMPT = [
  "你是一个严格的中文错别字校对工具。",
  "只修正错别字、同音或近音误写、形近字、多字、漏字，以及明显错误标点。",
  "可以根据上下文修正语义上明显写错的词组，例如把“旅行指责”修正为“履行职责”。",
  "不要润色，不要改写句式，不要扩写或缩写，不要改变原文表达逻辑。",
  "如果没有需要修正的内容，必须原样返回。",
  "只输出修正后的完整文本，不要输出解释、标题、引号、Markdown 或 JSON。"
].join("\n");

function getModelConfig(env = process.env) {
  return {
    apiKey: env.XFYUN_API_KEY || "",
    baseUrl: env.XFYUN_OPENAI_BASE_URL || DEFAULT_BASE_URL,
    model: env.XFYUN_MODEL || DEFAULT_MODEL,
    loraId: env.XFYUN_LORA_ID || DEFAULT_LORA_ID,
    timeoutMs: Number(env.XFYUN_TIMEOUT_MS || "45000")
  };
}

function isModelConfigured(env = process.env) {
  return Boolean(getModelConfig(env).apiKey);
}

function buildModelMessages(text) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `请校对以下文本，只输出修正后的完整文本：\n${text}` }
  ];
}

function cleanModelText(value) {
  if (typeof value !== "string") {
    return "";
  }

  let text = value.trim();
  const fenceMatch = text.match(/^```(?:text|txt|markdown)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("“") && text.endsWith("”"))) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

async function proofreadWithModel(text, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = getModelConfig(env);

  if (!config.apiKey) {
    throw new Error("MODEL_NOT_CONFIGURED");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "lora_id": config.loraId
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildModelMessages(text),
        stream: false,
        temperature: 0,
        max_tokens: Math.min(4096, Math.max(512, text.length * 3)),
        search_disable: true,
        enable_thinking: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`MODEL_REQUEST_FAILED:${response.status}:${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const corrected = cleanModelText(data?.choices?.[0]?.message?.content || data?.output_text || "");
    if (!corrected) {
      throw new Error("MODEL_RESULT_EMPTY");
    }

    return {
      corrected,
      model: config.model,
      provider: MODEL_PROVIDER,
      raw: data
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  MODEL_PROVIDER,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_LORA_ID,
  buildModelMessages,
  cleanModelText,
  getModelConfig,
  isModelConfigured,
  proofreadWithModel
};
