const assert = require("assert");
const zlib = require("zlib");
const stockSnapshotApi = require("../api/stock-snapshot");
const { createHandler, httpEtag, responseRepresentation } = stockSnapshotApi;

async function invoke(handler, method = "GET", headers = {}) {
  const req = { method, headers };
  const res = {
    headers: {},
    statusCode: 0,
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = "") {
      this.body = body;
    }
  };
  await handler(req, res);
  return res;
}

async function run() {
  assert.strictEqual(httpEtag("abc"), '"abc"');
  assert.strictEqual(httpEtag('"abc"'), '"abc"');

  const body = JSON.stringify({
    envelopeVersion: "stock-ytd-current.v1",
    snapshotId: "stock-ytd-test"
  });
  let handler = createHandler({
    store: {
      loadCurrentEnvelopeWithMetadata: async () => ({
        body,
        etag: "blob-etag"
      })
    },
    logger: { error() {} }
  });
  let response = await invoke(handler);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers["Cache-Control"], "no-store");
  assert.ok(/^"sha256-/.test(response.headers.ETag));
  assert.strictEqual(response.body.toString("utf8"), body);

  response = await invoke(handler, "GET", {
    "if-none-match": response.headers.ETag
  });
  assert.strictEqual(response.statusCode, 304);
  assert.strictEqual(response.body, "");

  const largeBody = JSON.stringify({ data: "x".repeat(600 * 1024) });
  const compressed = responseRepresentation(largeBody, "gzip, deflate");
  assert.strictEqual(compressed.contentEncoding, "gzip");
  assert.ok(compressed.bytes.length < Buffer.byteLength(largeBody));
  assert.strictEqual(zlib.gunzipSync(compressed.bytes).toString("utf8"), largeBody);

  response = await invoke(handler, "POST");
  assert.strictEqual(response.statusCode, 405);

  handler = createHandler({
    store: { loadCurrentEnvelopeWithMetadata: async () => null },
    logger: { error() {} }
  });
  response = await invoke(handler);
  assert.strictEqual(response.statusCode, 404);
  assert.strictEqual(JSON.parse(response.body).error, "STOCK_SNAPSHOT_NOT_READY");

  handler = createHandler({
    store: {
      loadCurrentEnvelopeWithMetadata: async () => {
        throw new Error("BLOB_READ_WRITE_TOKEN=must-not-leak");
      }
    },
    logger: { error() {} }
  });
  response = await invoke(handler);
  assert.strictEqual(response.statusCode, 503);
  assert.ok(!response.body.includes("must-not-leak"));

  console.log("stock snapshot API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
