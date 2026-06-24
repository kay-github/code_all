const assert = require("assert");

process.env.XFYUN_API_KEY = "test-key";
process.env.XFYUN_OPENAI_BASE_URL = "https://example.test/v2";
process.env.XFYUN_MODEL = "model-id";
process.env.XFYUN_LORA_ID = "0";

global.fetch = async () => ({
  ok: true,
  async json() {
    return {
      choices: [{ message: { content: "反映物业不作为，要求物业履行职责" } }]
    };
  }
});

const handler = require("../api/proofread");

const req = {
  method: "POST",
  body: { text: "反映物业不足为，要求物业旅行指责" }
};

const res = {
  headers: {},
  status: 0,
  body: "",
  setHeader(key, value) {
    this.headers[key] = value;
  },
  set statusCode(value) {
    this.status = value;
  },
  get statusCode() {
    return this.status;
  },
  end(body) {
    this.body = body;
  }
};

Promise.resolve(handler(req, res)).then(() => {
  const data = JSON.parse(res.body);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.result, "反映物业不作为，要求物业履行职责");
  assert.strictEqual(data.model, "model-id");
  assert.strictEqual(data.provider, "Xfyun Qwen Corrector");
  assert.deepStrictEqual(
    data.corrections.map((item) => [item.source, item.target]),
    [["足", "作"], ["旅", "履"], ["指", "职"]]
  );
  console.log("api proofread tests passed");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
