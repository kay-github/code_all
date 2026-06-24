const assert = require("assert");
const {
  buildModelMessages,
  cleanModelText,
  getModelConfig,
  isModelConfigured,
  proofreadWithModel
} = require("../lib/modelProofreader");

assert.strictEqual(isModelConfigured({}), false);
assert.strictEqual(isModelConfigured({ XFYUN_API_KEY: "key" }), true);
assert.strictEqual(getModelConfig({ XFYUN_API_KEY: "key" }).model, "xopqwen36v35b");
assert.strictEqual(cleanModelText("```text\n反映物业不作为\n```"), "反映物业不作为");
assert.strictEqual(cleanModelText("“反映物业不作为”"), "反映物业不作为");

const messages = buildModelMessages("反映物业不足为，要求物业旅行指责");
assert.strictEqual(messages[0].role, "system");
assert.strictEqual(messages[1].role, "user");
assert.strictEqual(messages[2].role, "assistant");
assert.strictEqual(messages[3].role, "user");
assert.ok(messages[0].content.includes("不要润色"));

let capturedRequest;
const fetchImpl = async (url, options) => {
  capturedRequest = { url, options };
  return {
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: "反映物业不作为，要求物业履行职责" } }]
      };
    }
  };
};

proofreadWithModel("反映物业不足为，要求物业旅行指责", {
  fetchImpl,
  env: {
    XFYUN_API_KEY: "test-key",
    XFYUN_OPENAI_BASE_URL: "https://example.test/v2",
    XFYUN_MODEL: "model-id",
    XFYUN_LORA_ID: "0",
    XFYUN_TIMEOUT_MS: "1000"
  }
}).then((result) => {
  assert.strictEqual(result.corrected, "反映物业不作为，要求物业履行职责");
  assert.strictEqual(result.model, "model-id");
  assert.strictEqual(capturedRequest.url, "https://example.test/v2/chat/completions");
  assert.strictEqual(capturedRequest.options.headers.Authorization, "Bearer test-key");
  assert.strictEqual(capturedRequest.options.headers.lora_id, "0");
  const body = JSON.parse(capturedRequest.options.body);
  assert.strictEqual(body.model, "model-id");
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.stream, false);
  console.log("model proofreader tests passed");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
