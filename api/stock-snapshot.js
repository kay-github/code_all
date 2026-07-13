"use strict";

const crypto = require("crypto");
const zlib = require("zlib");
const { createStockSnapshotBlobStore } = require("../lib/stockSnapshotBlobStore");

const GZIP_THRESHOLD_BYTES = 512 * 1024;

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function requestHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return null;
  const value = headers[name.toLowerCase()] || headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function httpEtag(value) {
  const etag = String(value || "").trim();
  if (!etag) return null;
  if (/^(W\/)?"[^"]+"$/.test(etag)) return etag;
  return `"${etag.replace(/["\\]/g, "")}"`;
}

function responseRepresentation(body, acceptEncoding = "") {
  const raw = Buffer.from(body, "utf8");
  const useGzip = raw.length >= GZIP_THRESHOLD_BYTES &&
    /(?:^|[,\s])gzip(?:[,\s]|$)/i.test(String(acceptEncoding));
  const bytes = useGzip
    ? zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED, mtime: 0 })
    : raw;
  const hash = crypto.createHash("sha256").update(bytes).digest("base64url");
  return {
    bytes,
    contentEncoding: useGzip ? "gzip" : null,
    etag: httpEtag(`sha256-${hash}`)
  };
}

function createHandler(options = {}) {
  const store = options.store || createStockSnapshotBlobStore(options.storeOptions);
  const logger = options.logger || console;
  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, {
        error: "METHOD_NOT_ALLOWED",
        message: "仅支持 GET 请求"
      });
      return;
    }

    try {
      const current = await store.loadCurrentEnvelopeWithMetadata();
      if (!current) {
        sendJson(res, 404, {
          error: "STOCK_SNAPSHOT_NOT_READY",
          message: "股票快照尚未生成"
        });
        return;
      }
      if (!current.etag) {
        throw Object.assign(new Error("stock snapshot Blob ETag is missing"), {
          code: "STOCK_SNAPSHOT_ETAG_MISSING"
        });
      }
      const representation = responseRepresentation(
        current.body,
        requestHeader(req, "accept-encoding")
      );
      res.setHeader("ETag", representation.etag);
      res.setHeader("Vary", "Accept-Encoding");
      if (requestHeader(req, "if-none-match") === representation.etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      if (representation.contentEncoding) {
        res.setHeader("Content-Encoding", representation.contentEncoding);
      }
      res.setHeader("Content-Length", String(representation.bytes.length));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.statusCode = 200;
      res.end(representation.bytes);
    } catch (error) {
      logger.error("stock snapshot gateway error", {
        name: error && error.name,
        code: error && error.code
      });
      sendJson(res, 503, {
        error: "STOCK_SNAPSHOT_UNAVAILABLE",
        message: "股票快照暂时不可用"
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.httpEtag = httpEtag;
module.exports.responseRepresentation = responseRepresentation;
