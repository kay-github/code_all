"use strict";

const crypto = require("crypto");

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const GITHUB_OIDC_AUDIENCE = "stock-ytd-publish";
const DEFAULT_REPOSITORY = "kay-github/code_all";
const DEFAULT_REF = "refs/heads/main";
const DEFAULT_WORKFLOW_REF =
  `${DEFAULT_REPOSITORY}/.github/workflows/stock-ytd.yml@${DEFAULT_REF}`;
const MAX_TOKEN_LENGTH = 20000;
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;

let cachedJwks = null;
let cachedJwksExpiresAt = 0;

function authError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return null;
  const value = headers[name.toLowerCase()] || headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return null;
  return match[1];
}

function secretMatches(token, expected) {
  if (!token || !expected) return false;
  const left = Buffer.from(String(token));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function decodeBase64UrlJson(value, label) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    throw authError("PUBLISH_TOKEN_INVALID", `${label} is invalid`);
  }
}

function parseJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw authError("PUBLISH_TOKEN_INVALID", "publish token is invalid");
  }
  const header = decodeBase64UrlJson(parts[0], "publish token header");
  const claims = decodeBase64UrlJson(parts[1], "publish token claims");
  return {
    header,
    claims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], "base64url")
  };
}

async function fetchGithubJwks(options = {}) {
  const now = options.now == null ? Date.now() : Number(options.now);
  if (!options.disableCache && cachedJwks && now < cachedJwksExpiresAt) {
    return cachedJwks;
  }
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(options.jwksUrl || GITHUB_OIDC_JWKS, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs || 5000)
  });
  if (!response.ok) {
    throw authError("PUBLISH_JWKS_UNAVAILABLE", "GitHub OIDC keys are unavailable");
  }
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.keys) || payload.keys.length === 0) {
    throw authError("PUBLISH_JWKS_INVALID", "GitHub OIDC keys are invalid");
  }
  if (!options.disableCache) {
    cachedJwks = payload;
    cachedJwksExpiresAt = now + 60 * 60 * 1000;
  }
  return payload;
}

function audienceMatches(actual, expected) {
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

function validateClaims(claims, options = {}) {
  const nowSeconds = Math.floor(
    (options.now == null ? Date.now() : Number(options.now)) / 1000
  );
  const expectedRepository = options.repository || DEFAULT_REPOSITORY;
  const expectedRef = options.ref || DEFAULT_REF;
  const expectedWorkflowRef = options.workflowRef || DEFAULT_WORKFLOW_REF;
  const expectedAudience = options.audience || GITHUB_OIDC_AUDIENCE;
  if (claims.iss !== GITHUB_OIDC_ISSUER) {
    throw authError("PUBLISH_TOKEN_CLAIMS_INVALID", "publish token issuer is invalid");
  }
  if (!audienceMatches(claims.aud, expectedAudience)) {
    throw authError("PUBLISH_TOKEN_CLAIMS_INVALID", "publish token audience is invalid");
  }
  if (
    !Number.isFinite(Number(claims.iat)) ||
    !Number.isFinite(Number(claims.exp)) ||
    Number(claims.iat) > nowSeconds + 60 ||
    Number(claims.exp) <= nowSeconds - 30 ||
    Number(claims.exp) - Number(claims.iat) > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw authError("PUBLISH_TOKEN_EXPIRED", "publish token lifetime is invalid");
  }
  if (claims.nbf != null && Number(claims.nbf) > nowSeconds + 30) {
    throw authError("PUBLISH_TOKEN_CLAIMS_INVALID", "publish token is not active");
  }
  if (
    claims.repository !== expectedRepository ||
    claims.ref !== expectedRef ||
    claims.workflow_ref !== expectedWorkflowRef
  ) {
    throw authError("PUBLISH_TOKEN_CLAIMS_INVALID", "publish token workflow identity is invalid");
  }
  return claims;
}

async function verifyGithubOidcToken(token, options = {}) {
  const parsed = parseJwt(token);
  if (parsed.header.alg !== "RS256" || typeof parsed.header.kid !== "string") {
    throw authError("PUBLISH_TOKEN_INVALID", "publish token algorithm is invalid");
  }
  const jwks = options.jwks || await fetchGithubJwks(options);
  const jwk = jwks.keys.find((key) => key && key.kid === parsed.header.kid);
  if (!jwk || jwk.kty !== "RSA") {
    throw authError("PUBLISH_TOKEN_INVALID", "publish token key is unavailable");
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch (error) {
    throw authError("PUBLISH_JWKS_INVALID", "GitHub OIDC key is invalid");
  }
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(parsed.signingInput),
    publicKey,
    parsed.signature
  );
  if (!valid) {
    throw authError("PUBLISH_TOKEN_INVALID", "publish token signature is invalid");
  }
  return validateClaims(parsed.claims, options);
}

async function authorizeStockPublish(req, env = process.env, options = {}) {
  const token = bearerToken(requestHeader(req, "authorization"));
  if (!token) {
    throw authError("PUBLISH_AUTH_REQUIRED", "publish authorization is required");
  }
  if (
    secretMatches(token, env.STOCK_PUBLISH_SECRET) ||
    secretMatches(token, env.CRON_SECRET)
  ) {
    return { type: "manual", subject: "manual" };
  }
  const claims = await (options.verifyGithubOidcToken || verifyGithubOidcToken)(token, {
    repository: env.STOCK_PUBLISH_REPOSITORY || DEFAULT_REPOSITORY,
    ref: env.STOCK_PUBLISH_REF || DEFAULT_REF,
    workflowRef: env.STOCK_PUBLISH_WORKFLOW_REF || DEFAULT_WORKFLOW_REF,
    audience: GITHUB_OIDC_AUDIENCE,
    fetchImpl: options.fetchImpl,
    now: options.now
  });
  return {
    type: "github-oidc",
    subject: String(claims.sub || "github-actions").slice(0, 200)
  };
}

function resetJwksCache() {
  cachedJwks = null;
  cachedJwksExpiresAt = 0;
}

module.exports = {
  GITHUB_OIDC_AUDIENCE,
  DEFAULT_REPOSITORY,
  DEFAULT_REF,
  DEFAULT_WORKFLOW_REF,
  bearerToken,
  secretMatches,
  parseJwt,
  validateClaims,
  fetchGithubJwks,
  verifyGithubOidcToken,
  authorizeStockPublish,
  resetJwksCache
};
