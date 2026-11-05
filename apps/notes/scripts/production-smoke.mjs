import { randomBytes, randomUUID } from "node:crypto";

const baseUrl = process.env.SMOKE_BASE_URL?.replace(/\/$/, "");
const adminPassword = process.env.ADMIN_PASSWORD;

if (!baseUrl || !adminPassword) {
  throw new Error("Set SMOKE_BASE_URL and ADMIN_PASSWORD before running the production smoke test");
}
if (!baseUrl.startsWith("https://") && process.env.ALLOW_INSECURE_SMOKE !== "1") {
  throw new Error("SMOKE_BASE_URL must use HTTPS (or set ALLOW_INSECURE_SMOKE=1 for local testing)");
}

const slug = `smoke-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const spacePassword = randomUUID();
let adminCookie = "";
let spaceId = "";
let cleanupError = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(pathname, init = {}) {
  const headers = new Headers(init.headers);
  if (adminCookie) headers.set("Cookie", adminCookie);
  return fetch(`${baseUrl}${pathname}`, { ...init, headers, redirect: "manual" });
}

async function json(response, expectedStatus, label) {
  assert(response.status === expectedStatus, `${label}: expected ${expectedStatus}, received ${response.status}`);
  return response.json();
}

try {
  const home = await api("");
  assert(home.status === 200, `home: expected 200, received ${home.status}`);
  assert(home.headers.get("content-security-policy")?.includes("frame-ancestors 'self'"), "home: CSP missing");
  assert(home.headers.get("x-content-type-options") === "nosniff", "home: nosniff missing");
  assert(home.headers.get("x-frame-options") === "SAMEORIGIN", "home: frame protection missing");

  const unlock = await api("/api/admin/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: adminPassword }),
  });
  await json(unlock, 200, "admin unlock");
  const setCookie = unlock.headers.get("set-cookie");
  assert(setCookie, "admin unlock: session cookie missing");
  assert(setCookie.startsWith("qs_notes_admin=") && /;\s*Path=\/notes(?:;|$)/i.test(setCookie), "admin unlock: cookie path");
  adminCookie = setCookie.split(";", 1)[0];

  const created = await json(
    await api("/api/admin/spaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Release smoke test", slug, password: spacePassword }),
    }),
    200,
    "space create",
  );
  assert(typeof created.spaceId === "string" && created.spaceId, "space create: ID missing");
  spaceId = created.spaceId;

  const initialState = await json(await api(`/api/spaces/${slug}/state`), 200, "initial state");
  assert(typeof initialState.noteUpdatedAt === "string", "initial state: note version missing");

  const save = (content, baseUpdatedAt, force = false) =>
    api(`/api/spaces/${slug}/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, baseUpdatedAt, force }),
    });

  const concurrent = await Promise.all([
    save("concurrent-a", initialState.noteUpdatedAt),
    save("concurrent-b", initialState.noteUpdatedAt),
  ]);
  const statuses = concurrent.map((response) => response.status).sort((a, b) => a - b);
  assert(statuses[0] === 200 && statuses[1] === 409, `atomic save: received ${statuses.join(", ")}`);
  const winningResponse = concurrent.find((response) => response.status === 200);
  const winningSave = await winningResponse.json();
  assert(typeof winningSave.updatedAt === "string", "atomic save: updatedAt missing");

  const remoteSave = await json(
    await save("newer-remote-value", winningSave.updatedAt),
    200,
    "remote save",
  );
  const staleClear = await save("", winningSave.updatedAt);
  assert(staleClear.status === 409, `stale clear: expected 409, received ${staleClear.status}`);
  await json(await save("", remoteSave.updatedAt), 200, "current clear");

  const form = new FormData();
  form.set("file", new File(["<!doctype html><script>document.body.dataset.executed='1'</script>"], "smoke.html", {
    type: "text/html",
  }));
  const uploaded = await json(
    await api(`/api/spaces/${slug}/assets`, { method: "POST", body: form }),
    200,
    "HTML upload",
  );
  assert(typeof uploaded.assetId === "string" && uploaded.assetId, "HTML upload: asset ID missing");

  const downloaded = await api(`/api/spaces/${slug}/assets/${uploaded.assetId}`);
  assert(downloaded.status === 200, `HTML download: expected 200, received ${downloaded.status}`);
  assert(downloaded.headers.get("content-type")?.startsWith("application/octet-stream"), "HTML download: unsafe MIME");
  assert(downloaded.headers.get("content-disposition")?.startsWith("attachment;"), "HTML download: not forced attachment");
  assert(downloaded.headers.get("cache-control") === "private, no-store", "HTML download: unsafe cache policy");
  assert(downloaded.headers.get("x-content-type-options") === "nosniff", "HTML download: nosniff missing");
  assert(downloaded.headers.get("content-security-policy")?.includes("sandbox"), "HTML download: sandbox missing");

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    checks: [
      "security headers",
      "admin session",
      "atomic concurrent save",
      "stale clear conflict",
      "safe HTML attachment delivery",
    ],
  }, null, 2));
} finally {
  if (spaceId && adminCookie) {
    try {
      const cleanup = await api("/api/admin/spaces", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId }),
      });
      if (!cleanup.ok) cleanupError = new Error(`smoke cleanup failed with ${cleanup.status}`);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
}
