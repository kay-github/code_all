const assert = require("assert");
const crypto = require("crypto");
const {
  DEFAULT_REF,
  DEFAULT_REPOSITORY,
  DEFAULT_WORKFLOW_REF,
  GITHUB_OIDC_AUDIENCE,
  authorizeStockPublish,
  bearerToken,
  parseJwt,
  secretMatches,
  validateClaims,
  verifyGithubOidcToken
} = require("../lib/stockPublishAuth");

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(privateKey, header, claims) {
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKey
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function run() {
  assert.strictEqual(bearerToken("Bearer abc"), "abc");
  assert.strictEqual(bearerToken("Basic abc"), null);
  assert.strictEqual(secretMatches("same", "same"), true);
  assert.strictEqual(secretMatches("same", "different"), false);

  const now = Date.parse("2026-07-14T12:30:00.000Z");
  const nowSeconds = Math.floor(now / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: GITHUB_OIDC_AUDIENCE,
    iat: nowSeconds - 30,
    nbf: nowSeconds - 30,
    exp: nowSeconds + 300,
    repository: DEFAULT_REPOSITORY,
    ref: DEFAULT_REF,
    workflow_ref: DEFAULT_WORKFLOW_REF,
    sub: `repo:${DEFAULT_REPOSITORY}:ref:${DEFAULT_REF}`
  };
  assert.strictEqual(validateClaims(claims, { now }), claims);
  assert.throws(
    () => validateClaims({ ...claims, ref: "refs/heads/other" }, { now }),
    (error) => error.code === "PUBLISH_TOKEN_CLAIMS_INVALID"
  );
  assert.throws(
    () => validateClaims({ ...claims, exp: nowSeconds - 60 }, { now }),
    (error) => error.code === "PUBLISH_TOKEN_EXPIRED"
  );

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
  const token = signJwt(privateKey, { alg: "RS256", kid: jwk.kid }, claims);
  assert.strictEqual(parseJwt(token).claims.repository, DEFAULT_REPOSITORY);
  const verified = await verifyGithubOidcToken(token, {
    jwks: { keys: [jwk] },
    now
  });
  assert.strictEqual(verified.workflow_ref, DEFAULT_WORKFLOW_REF);
  const tokenParts = token.split(".");
  const invalidSignature = Buffer.from(tokenParts[2], "base64url");
  invalidSignature[0] ^= 1;
  const invalidToken = [
    tokenParts[0],
    tokenParts[1],
    invalidSignature.toString("base64url")
  ].join(".");
  await assert.rejects(
    verifyGithubOidcToken(invalidToken, {
      jwks: { keys: [jwk] },
      now
    }),
    (error) => error.code === "PUBLISH_TOKEN_INVALID"
  );

  let auth = await authorizeStockPublish(
    { headers: { authorization: "Bearer manual-secret" } },
    { CRON_SECRET: "manual-secret" }
  );
  assert.deepStrictEqual(auth, { type: "manual", subject: "manual" });

  auth = await authorizeStockPublish(
    { headers: { authorization: `Bearer ${token}` } },
    {},
    {
      verifyGithubOidcToken: async (value, options) => {
        assert.strictEqual(value, token);
        assert.strictEqual(options.repository, DEFAULT_REPOSITORY);
        return claims;
      }
    }
  );
  assert.strictEqual(auth.type, "github-oidc");
  assert.strictEqual(auth.subject, claims.sub);

  await assert.rejects(
    authorizeStockPublish({ headers: {} }, {}),
    (error) => error.code === "PUBLISH_AUTH_REQUIRED"
  );

  console.log("stock publish auth tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
