const assert = require("assert");
const {
  buildModelMessages,
  cleanModelText,
  getConfiguredProviders,
  getProviderOrder,
  getProviderStatus,
  isModelConfigured,
  normalizeMode,
  proofreadWithModel,
  resetProviderCooldowns
} = require("../lib/modelProofreader");

function jsonResponse(content) {
  return {
    ok: true,
    async json() {
      return { choices: [{ message: { content } }] };
    }
  };
}

function errorResponse(status, body) {
  return {
    ok: false,
    status,
    async text() {
      return body || "";
    }
  };
}

// 配置识别
assert.strictEqual(isModelConfigured({}), false);
assert.strictEqual(isModelConfigured({ XFYUN_API_KEY: "key" }), true);
assert.strictEqual(isModelConfigured({ ZHIPU_API_KEY: "key" }), true);

// 顺序：默认 + 环境变量重排
assert.deepStrictEqual(getProviderOrder({}), ["xfyun", "zhipu", "siliconflow", "dashscope", "google"]);
assert.deepStrictEqual(
  getProviderOrder({ TYPO_PROVIDER_ORDER: "zhipu, xfyun" }),
  ["zhipu", "xfyun", "siliconflow", "dashscope", "google"]
);

// 只返回配置了 key 的提供商
const configured = getConfiguredProviders({ ZHIPU_API_KEY: "z-key", DASHSCOPE_API_KEY: "d-key" });
assert.deepStrictEqual(configured.map((item) => item.key), ["zhipu", "dashscope"]);
assert.strictEqual(configured[0].model, "glm-4-flash-250414");
assert.strictEqual(configured[0].baseUrl, "https://open.bigmodel.cn/api/paas/v4");

const sfConfigured = getConfiguredProviders({ SILICONFLOW_API_KEY: "s-key" });
assert.strictEqual(sfConfigured[0].model, "Qwen/Qwen3-8B");
assert.strictEqual(sfConfigured[0].extraBody.enable_thinking, false);

// Google Gemini：OpenAI 兼容端点 + 关闭思考
const googleConfigured = getConfiguredProviders({ GEMINI_API_KEY: "g-key" });
assert.strictEqual(googleConfigured[0].key, "google");
assert.strictEqual(googleConfigured[0].model, "gemini-flash-latest");
assert.strictEqual(googleConfigured[0].baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
assert.strictEqual(googleConfigured[0].extraBody.reasoning_effort, "none");

// 文本清理
assert.strictEqual(cleanModelText("```text\n反映物业不作为\n```"), "反映物业不作为");
assert.strictEqual(cleanModelText("“反映物业不作为”"), "反映物业不作为");

const messages = buildModelMessages("反映物业不足为，要求物业旅行指责");
assert.strictEqual(messages[0].role, "system");
assert.ok(messages[0].content.includes("不要润色"));

// 深度校对模式：额外覆盖逻辑与重复问题
const deepMessages = buildModelMessages("测试文本", "deep");
assert.strictEqual(deepMessages[0].role, "system");
assert.ok(deepMessages[0].content.includes("逻辑不通"));
assert.ok(deepMessages[0].content.includes("重复"));
assert.ok(deepMessages[deepMessages.length - 1].content.includes("请深度校对以下文本"));
assert.strictEqual(normalizeMode("deep"), "deep");
assert.strictEqual(normalizeMode("unknown"), "typo");
assert.strictEqual(normalizeMode(undefined), "typo");

async function run() {
  // 1) 首选提供商成功
  resetProviderCooldowns();
  let capturedRequest;
  const okFetch = async (url, options) => {
    capturedRequest = { url, options };
    return jsonResponse("反映物业不作为，要求物业履行职责");
  };

  const single = await proofreadWithModel("反映物业不足为，要求物业旅行指责", {
    fetchImpl: okFetch,
    env: {
      XFYUN_API_KEY: "test-key",
      XFYUN_OPENAI_BASE_URL: "https://example.test/v2",
      XFYUN_MODEL: "model-id",
      XFYUN_LORA_ID: "7",
      XFYUN_TIMEOUT_MS: "1000"
    }
  });
  assert.strictEqual(single.corrected, "反映物业不作为，要求物业履行职责");
  assert.strictEqual(single.model, "model-id");
  assert.strictEqual(single.providerKey, "xfyun");
  assert.strictEqual(capturedRequest.url, "https://example.test/v2/chat/completions");
  assert.strictEqual(capturedRequest.options.headers.Authorization, "Bearer test-key");
  assert.strictEqual(capturedRequest.options.headers.lora_id, "7");
  const body = JSON.parse(capturedRequest.options.body);
  assert.strictEqual(body.model, "model-id");
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.stream, false);

  // 2) 首选 429 超额 → 自动切换到第二家
  resetProviderCooldowns();
  const failoverEnv = {
    XFYUN_API_KEY: "x-key",
    ZHIPU_API_KEY: "z-key",
    ZHIPU_MODEL: "glm-test"
  };
  const calls = [];
  const failoverFetch = async (url) => {
    calls.push(url);
    if (url.includes("xf-yun")) {
      return errorResponse(429, "quota exceeded");
    }
    return jsonResponse("反映物业不作为");
  };

  const failover = await proofreadWithModel("反映物业不足为", { fetchImpl: failoverFetch, env: failoverEnv });
  assert.strictEqual(failover.providerKey, "zhipu");
  assert.strictEqual(failover.model, "glm-test");
  assert.strictEqual(failover.attempts.length, 1);
  assert.ok(failover.attempts[0].error.startsWith("MODEL_REQUEST_FAILED:429"));
  assert.strictEqual(calls.length, 2);

  // 3) 429 后进入冷却：下一次请求直接跳过首选，只打第二家
  const secondCalls = [];
  const secondFetch = async (url) => {
    secondCalls.push(url);
    return jsonResponse("反映物业不作为");
  };
  const cooled = await proofreadWithModel("反映物业不足为", { fetchImpl: secondFetch, env: failoverEnv });
  assert.strictEqual(cooled.providerKey, "zhipu");
  assert.strictEqual(secondCalls.length, 1);
  assert.ok(secondCalls[0].includes("bigmodel.cn"));

  const status = getProviderStatus(failoverEnv);
  const xfyunStatus = status.find((item) => item.key === "xfyun");
  assert.strictEqual(xfyunStatus.coolingDown, true);
  assert.ok(xfyunStatus.cooldownReason.startsWith("MODEL_REQUEST_FAILED:429"));

  // 4) 全部失败 → 抛出汇总错误
  resetProviderCooldowns();
  const allFailFetch = async () => errorResponse(500, "server down");
  await assert.rejects(
    () => proofreadWithModel("反映物业不足为", { fetchImpl: allFailFetch, env: failoverEnv }),
    (error) => {
      assert.strictEqual(error.message, "MODEL_ALL_PROVIDERS_FAILED");
      assert.strictEqual(error.attempts.length, 2);
      return true;
    }
  );

  // 5) 网络异常（fetch 抛错）也会触发切换
  resetProviderCooldowns();
  const networkFetch = async (url) => {
    if (url.includes("xf-yun")) {
      throw new Error("socket hang up");
    }
    return jsonResponse("反映物业不作为");
  };
  const networkFailover = await proofreadWithModel("反映物业不足为", { fetchImpl: networkFetch, env: failoverEnv });
  assert.strictEqual(networkFailover.providerKey, "zhipu");
  assert.strictEqual(networkFailover.attempts[0].error, "socket hang up");

  // 6) preferGoogle：google 提到首位，其余顺序不变；失败仍可回落到国内提供商
  resetProviderCooldowns();
  const preferEnv = {
    XFYUN_API_KEY: "x-key",
    ZHIPU_API_KEY: "z-key",
    GEMINI_API_KEY: "g-key"
  };
  const preferCalls = [];
  const preferFetch = async (url, options) => {
    preferCalls.push(url);
    return jsonResponse("反映物业不作为");
  };
  const preferred = await proofreadWithModel("反映物业不足为", {
    fetchImpl: preferFetch,
    env: preferEnv,
    preferGoogle: true
  });
  assert.strictEqual(preferred.providerKey, "google");
  assert.ok(preferCalls[0].includes("generativelanguage.googleapis.com"));

  // 不勾选时 google 保持在链尾，首选仍是 xfyun
  resetProviderCooldowns();
  const defaultCalls = [];
  const defaultFetch = async (url) => {
    defaultCalls.push(url);
    return jsonResponse("反映物业不作为");
  };
  const defaulted = await proofreadWithModel("反映物业不足为", { fetchImpl: defaultFetch, env: preferEnv });
  assert.strictEqual(defaulted.providerKey, "xfyun");
  assert.strictEqual(defaultCalls.length, 1);

  // preferGoogle 时 google 失败自动回落
  resetProviderCooldowns();
  const preferFailCalls = [];
  const preferFailFetch = async (url) => {
    preferFailCalls.push(url);
    if (url.includes("generativelanguage")) {
      return errorResponse(429, "gemini quota exceeded");
    }
    return jsonResponse("反映物业不作为");
  };
  const preferFallback = await proofreadWithModel("反映物业不足为", {
    fetchImpl: preferFailFetch,
    env: preferEnv,
    preferGoogle: true
  });
  assert.strictEqual(preferFallback.providerKey, "xfyun");
  assert.strictEqual(preferFallback.attempts.length, 1);
  assert.ok(preferFallback.attempts[0].error.startsWith("MODEL_REQUEST_FAILED:429"));

  // 7) deep 模式请求体使用深度校对提示词
  resetProviderCooldowns();
  let deepRequest;
  const deepFetch = async (url, options) => {
    deepRequest = JSON.parse(options.body);
    return jsonResponse("修正后的文本");
  };
  await proofreadWithModel("测试文本", {
    fetchImpl: deepFetch,
    env: { GEMINI_API_KEY: "g-key" },
    mode: "deep"
  });
  assert.ok(deepRequest.messages[0].content.includes("逻辑不通"));
  assert.strictEqual(deepRequest.reasoning_effort, "none");
  assert.strictEqual(deepRequest.model, "gemini-flash-latest");

  resetProviderCooldowns();
  console.log("model proofreader tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
