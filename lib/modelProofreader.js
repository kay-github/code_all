const SYSTEM_PROMPT = [
  "你是一个严格的中文错别字校对工具。",
  "只修正错别字、同音或近音误写、形近字、多字、漏字，以及明显错误标点。",
  "可以根据上下文修正语义上明显写错的词组，例如把“旅行指责”修正为“履行职责”。",
  "物业投诉语境中，“物业不足为”通常应修正为“物业不作为”，“旅行指责”通常应修正为“履行职责”。",
  "不要润色，不要改写句式，不要扩写或缩写，不要改变原文表达逻辑。",
  "如果没有需要修正的内容，必须原样返回。",
  "只输出修正后的完整文本，不要输出解释、标题、引号、Markdown 或 JSON。"
].join("\n");

const PROVIDER_DEFINITIONS = [
  {
    key: "xfyun",
    name: "Xfyun Qwen Corrector",
    apiKeyEnv: "XFYUN_API_KEY",
    baseUrlEnv: "XFYUN_OPENAI_BASE_URL",
    defaultBaseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    modelEnv: "XFYUN_MODEL",
    defaultModel: "xopqwen36v35b",
    timeoutEnv: "XFYUN_TIMEOUT_MS",
    buildExtraHeaders(env) {
      return { lora_id: env.XFYUN_LORA_ID || "0" };
    },
    extraBody: { search_disable: true, enable_thinking: false }
  },
  {
    key: "zhipu",
    name: "Zhipu GLM Corrector",
    apiKeyEnv: "ZHIPU_API_KEY",
    baseUrlEnv: "ZHIPU_BASE_URL",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelEnv: "ZHIPU_MODEL",
    defaultModel: "glm-4-flash-250414",
    timeoutEnv: "ZHIPU_TIMEOUT_MS"
  },
  {
    key: "siliconflow",
    name: "SiliconFlow Qwen Corrector",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    baseUrlEnv: "SILICONFLOW_BASE_URL",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    modelEnv: "SILICONFLOW_MODEL",
    defaultModel: "Qwen/Qwen3-8B",
    timeoutEnv: "SILICONFLOW_TIMEOUT_MS",
    extraBody: { enable_thinking: false }
  },
  {
    key: "dashscope",
    name: "DashScope Qwen Corrector",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelEnv: "DASHSCOPE_MODEL",
    defaultModel: "qwen-turbo",
    timeoutEnv: "DASHSCOPE_TIMEOUT_MS",
    extraBody: { enable_thinking: false }
  }
];

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_FAILURE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_QUOTA_COOLDOWN_MS = 10 * 60 * 1000;

const providerCooldowns = new Map();

function resetProviderCooldowns() {
  providerCooldowns.clear();
}

function getProviderOrder(env = process.env) {
  const defaultOrder = PROVIDER_DEFINITIONS.map((item) => item.key);
  const raw = (env.TYPO_PROVIDER_ORDER || "").trim();
  if (!raw) {
    return defaultOrder;
  }

  const requested = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => defaultOrder.includes(item));
  const remaining = defaultOrder.filter((item) => !requested.includes(item));
  return requested.concat(remaining);
}

function getProviderConfig(definition, env = process.env) {
  return {
    key: definition.key,
    name: definition.name,
    apiKey: env[definition.apiKeyEnv] || "",
    baseUrl: env[definition.baseUrlEnv] || definition.defaultBaseUrl,
    model: env[definition.modelEnv] || definition.defaultModel,
    timeoutMs: Number(env[definition.timeoutEnv] || String(DEFAULT_TIMEOUT_MS)),
    extraHeaders: definition.buildExtraHeaders ? definition.buildExtraHeaders(env) : {},
    extraBody: definition.extraBody || {}
  };
}

function getConfiguredProviders(env = process.env) {
  const byKey = new Map(PROVIDER_DEFINITIONS.map((item) => [item.key, item]));
  return getProviderOrder(env)
    .map((key) => getProviderConfig(byKey.get(key), env))
    .filter((config) => Boolean(config.apiKey));
}

function isModelConfigured(env = process.env) {
  return getConfiguredProviders(env).length > 0;
}

function getProviderStatus(env = process.env, nowMs = Date.now()) {
  const byKey = new Map(PROVIDER_DEFINITIONS.map((item) => [item.key, item]));
  return getProviderOrder(env).map((key) => {
    const config = getProviderConfig(byKey.get(key), env);
    const cooldown = providerCooldowns.get(key);
    const coolingDown = Boolean(cooldown && cooldown.until > nowMs);
    return {
      key: config.key,
      name: config.name,
      model: config.model,
      configured: Boolean(config.apiKey),
      coolingDown,
      cooldownReason: coolingDown ? cooldown.reason : null,
      cooldownRemainingMs: coolingDown ? cooldown.until - nowMs : 0
    };
  });
}

function buildModelMessages(text) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "请校对以下文本，只输出修正后的完整文本：\n反映物业不足为，要求物业旅行指责" },
    { role: "assistant", content: "反映物业不作为，要求物业履行职责" },
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

function isLongCooldownError(message) {
  const statusMatch = message.match(/^MODEL_REQUEST_FAILED:(\d{3}):/);
  if (!statusMatch) {
    return false;
  }
  const status = Number(statusMatch[1]);
  return status === 401 || status === 403 || status === 429;
}

function markProviderFailure(key, message, env, nowMs) {
  const longCooldown = isLongCooldownError(message);
  const cooldownMs = longCooldown
    ? Number(env.TYPO_QUOTA_COOLDOWN_MS || String(DEFAULT_QUOTA_COOLDOWN_MS))
    : Number(env.TYPO_FAILOVER_COOLDOWN_MS || String(DEFAULT_FAILURE_COOLDOWN_MS));
  providerCooldowns.set(key, { until: nowMs + cooldownMs, reason: message.slice(0, 200) });
}

async function callProvider(config, text, fetchImpl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...config.extraHeaders
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildModelMessages(text),
        stream: false,
        temperature: 0,
        max_tokens: Math.min(4096, Math.max(512, text.length * 3)),
        ...config.extraBody
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

    return { corrected, raw: data };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function proofreadWithModel(text, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const providers = getConfiguredProviders(env);

  if (!providers.length) {
    throw new Error("MODEL_NOT_CONFIGURED");
  }

  const attempts = [];
  const skipped = [];

  for (const config of providers) {
    const cooldown = providerCooldowns.get(config.key);
    if (cooldown && cooldown.until > now()) {
      skipped.push({ provider: config.name, key: config.key, reason: cooldown.reason });
      continue;
    }

    try {
      const { corrected, raw } = await callProvider(config, text, fetchImpl);
      providerCooldowns.delete(config.key);
      return {
        corrected,
        model: config.model,
        provider: config.name,
        providerKey: config.key,
        attempts,
        raw
      };
    } catch (error) {
      const message = error && error.name === "AbortError"
        ? "MODEL_REQUEST_TIMEOUT"
        : String((error && error.message) || error);
      markProviderFailure(config.key, message, env, now());
      attempts.push({ provider: config.name, key: config.key, error: message });
    }
  }

  const error = new Error("MODEL_ALL_PROVIDERS_FAILED");
  error.attempts = attempts;
  error.skipped = skipped;
  throw error;
}

module.exports = {
  PROVIDER_DEFINITIONS,
  buildModelMessages,
  cleanModelText,
  getConfiguredProviders,
  getProviderConfig,
  getProviderOrder,
  getProviderStatus,
  isModelConfigured,
  proofreadWithModel,
  resetProviderCooldowns
};
