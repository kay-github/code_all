# AGENTS.md

## 1) Project Identity

- Name: `quick-space`
- Type: Next.js web app (App Router, TypeScript)
- Goal: Multi-space temporary notebook for cross-device sharing without account login.
- Current product headline: `免登录临时笔记本`
- This app lives in `apps/notes` and is mounted at `/notes`. The routes below are relative to that prefix. Keep its cookie path and client API URLs under the same prefix.

## 2) Core Product Rules

- Home (`/`) shows all space titles and paths.
- Admin entry is hidden from front pages; the route remains `/admin`.
- The public space (`DEFAULT_SPACE_SLUG`) is readable without authentication, but editing requires its space password.
- Private spaces require their space password before content is visible.
- Accessible content can be read, copied, previewed, and downloaded.
- Upload size is limited to `50MB` per file.
- Supported blocks are text, images, videos, and general files.
- Save, upload, authentication, synchronization, and failure outcomes use top-center toast feedback.

## 2.1) Client Reliability Conventions

- Space state polling uses `GET /api/spaces/[slug]/state` every 25 seconds and on focus/visibility changes. Refresh only when the note version or asset summary changes.
- A remote refresh must never replace dirty local text. `beforeunload` must remain active while the note differs from the last synchronized value.
- Note saves always send `baseUpdatedAt`. The server performs an atomic compare-and-update; a mismatch returns 409 and requires explicit overwrite confirmation.
- Clear-text follows the same conflict path as a normal save. Never bypass conflict detection merely because a destructive confirmation was already shown.
- Session-expiry responses refresh permissions while preserving the local draft.
- Multi-file uploads use batches of at most three concurrent files and `Promise.allSettled`, so all results are reconciled before the UI leaves its busy state.
- Reset the file input after each selection so the same failed file can be selected again.
- Blob uploads wait briefly for server-side registration and distinguish failed, registered, and still-pending files.
- Save/clear update local state without a full refresh. Unlock and delete use `useTransition` until the refreshed server content renders.
- Action rows must wrap on narrow screens; `.btn` labels remain on one line.
- `loading.tsx` skeletons exist for `/` and `/[slug]`.
- `SpaceQr` dynamically imports `qrcode-generator` on first open.

## 2.2) Server Reliability And Security Conventions

- Keep permission checks centralized in `src/lib/space-permission.ts`.
- Space cookies are signed and contain a fingerprint of the current password hash. Changing a space password invalidates its old sessions.
- `ADMIN_PASSWORD`, `SESSION_SECRET`, and `DATA_ENCRYPTION_KEY` are mandatory in production. The data and session keys must differ. Never restore the formerly exposed sample admin password.
- Compare direct secrets in constant time (`secureTextEqual`).
- New encrypted data uses v2 (`enc:v2:` / `ENC2`) with `DATA_ENCRYPTION_KEY`. v1 reads may try both the data key and the current session key for upgrade compatibility.
- Do not rotate `SESSION_SECRET` while any v1 record still depends on it. Do not rotate `DATA_ENCRYPTION_KEY` without an explicit decrypt/re-encrypt migration.
- Once v2 data has been written, do not roll back to an application version that only understands v1. Prefer a forward fix or a v2-compatible rollback build.
- Blob client uploads are registered only from `/api/blob/upload` `onUploadCompleted`. Client-side POST registration remains disabled.
- Validate completed uploads with token payload, space identity, Blob `head` metadata, maximum size, and a deterministic asset ID. Registration must remain idempotent.
- Only HTTPS URLs on a hostname ending in `.blob.vercel-storage.com`, with no credentials and a non-empty path, may be signed, read, registered, or deleted.
- Asset responses are `private, no-store` and `nosniff`; active content is forced to download with a sandbox CSP.
- Admin space deletion deletes trusted Blob objects before database rows. Its audit entry must not retain the deleted `spaceId` foreign key.
- Rate limits use the PostgreSQL `RateLimitBucket` atomic upsert so all serverless instances share counters. Do not replace this with process memory.
- Current limits: admin unlock 12/5 minutes/IP; space unlock 16/5 minutes/IP+slug; Blob token 60/5 minutes/IP; DB fallback upload 30/5 minutes/IP+slug.
- `writeAudit` runs after the response through `next/server` `after()` and must not block user-visible latency.

## 2.3) Performance Conventions

- Space pages query asset metadata only; never load encrypted binary payloads in list views.
- Home uses `_count` instead of fetching asset rows.
- `ensureDefaultSpace` runs only when the default space is absent and must tolerate concurrent first requests.
- Asset and audit time-order queries rely on committed indexes in Prisma migrations.
- Blob downloads prefer a short-lived signed CDN URL and fall back to the authenticated Blob SDK proxy.
- Signed redirects and proxied/DB assets must not use shared public caching.

## 3) Stack And Runtime

- Next.js 16 + React 19
- Bun 1.3.x
- Prisma ORM + PostgreSQL
- Vercel Blob private storage
- `bcryptjs`, `zod`, and `qrcode-generator`

Versions are pinned in `package.json`/`bun.lock`; update both together and run the complete check suite.

## 4) Architecture Overview

- Server pages:
  - `src/app/page.tsx`
  - `src/app/[slug]/page.tsx`
  - `src/app/admin/page.tsx`
- Client components:
  - `src/components/space-view.tsx`
  - `src/components/admin-panel.tsx`
- Admin APIs:
  - `POST /api/admin/unlock`
  - `POST /api/admin/logout`
  - `POST|PATCH|DELETE /api/admin/spaces`
- Space APIs:
  - `POST /api/spaces/[slug]/unlock`
  - `POST /api/spaces/[slug]/lock`
  - `GET /api/spaces/[slug]/state`
  - `PUT /api/spaces/[slug]/note`
  - `POST /api/spaces/[slug]/assets` (database fallback)
  - `GET /api/spaces/[slug]/assets/register` (registration status only)
  - `GET|DELETE /api/spaces/[slug]/assets/[assetId]`
- Blob API:
  - `POST /api/blob/upload` (token issuance and completion callback)

## 5) Permission Model

- Admin session: full read/write for all spaces.
- Valid space cookie: read/write for that space.
- Public space: read-only without a cookie.
- Every write requires an admin session or a valid current space session.
- Private asset reads require space read permission; public assets follow public-space read policy.

## 6) Data And Migrations

- `Space`: title, slug, password hash, timestamps.
- `Note`: one encrypted text value per space.
- `Asset`: metadata, `blob`/`db` storage marker, optional trusted Blob URL, optional encrypted DB payload.
- `AuditLog`: action, actor, IP, detail, timestamps.
- `RateLimitBucket`: shared fixed-window counters.

Schema: `prisma/schema.prisma`. Migration history: `prisma/migrations/`.

- Production and staging use `prisma migrate deploy` only.
- Never run `prisma db push` or `prisma migrate dev` against production.
- `prisma:push` exists only for disposable local databases.
- Commit every schema change with its migration SQL.
- Existing pre-migration databases must be verified and baselined with `20260224000000_baseline` before applying later migrations. Never mark an unapplied migration as applied.

## 7) Environment Variables

Required in production:

- `DATABASE_URL` (or one supported Postgres fallback variable)
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `DATA_ENCRYPTION_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `DEFAULT_SPACE_SLUG`
- `DEFAULT_SPACE_TITLE`

Supported database fallbacks:

- `POSTGRES_PRISMA_URL`
- `POSTGRES_URL`
- `POSTGRES_PRISMA_POSTGRES_URL`
- `POSTGRES_PRISMA_PRISMA_DATABASE_URL`

Optional:

- `VERCEL_BLOB_CALLBACK_URL`: required off Vercel when direct Blob upload completion must call a public HTTPS origin. Supply the origin only; the SDK appends the request path.
- `ALLOW_PRODUCTION_MIGRATIONS=1`: deployment-job consent flag only. Never persist it in preview or ordinary runtime environments.

## 8) Local Runbook

```bash
bun install
bun run prisma:generate
bunx prisma migrate deploy
bun run dev
```

Before handoff or commit:

```bash
bun run check
```

This runs lint, TypeScript, and Bun tests. Unit coverage currently includes atomic note saves, crypto v1/v2 compatibility and corruption, Blob URL trust, and safe asset headers.

The checked-in GitHub Actions workflow audits dependencies, uses ephemeral PostgreSQL to replay migrations and check schema parity, then runs lint, typecheck, tests, and a production build. CI and preview environments must never point at production.

## 9) Deployment And Operations

- Back up PostgreSQL and Vercel Blob before migrations, dependency upgrades, and key changes.
- A PostgreSQL dump does not include Blob object bytes. Preserve Blob objects plus their URL/path manifest separately.
- Restore first into an isolated environment with the encryption keys from the backup date, deploy migrations, then verify read/write/upload/download/conflict/auth flows.
- Ordinary `bun run build` generates Prisma Client and builds Next.js without changing the database.
- Production migration wrappers require `ALLOW_PRODUCTION_MIGRATIONS=1`. Prefer a separate, single-run `bun run prisma:migrate:deploy` release step; `build:production` is available only for environments that intentionally combine build and migration.
- Preview deployments use separate databases. Do not allow unrelated builds to mutate a shared production database.
- Production key rotation rules:
  - Admin cookies carry a keyed fingerprint of the current admin password, so changing `ADMIN_PASSWORD` and redeploying revokes existing admin sessions.
  - `SESSION_SECRET` rotation invalidates all cookies and is blocked operationally until session-key-encrypted v1 data is migrated.
  - `DATA_ENCRYPTION_KEY` requires an offline or dual-key re-encryption migration; changing the variable alone makes v2 data unreadable.
  - Blob and database credentials are rotated provider-side, updated in every runtime, redeployed, verified, and only then revoked.
- Full v1 inventory and backup/restore commands live in `README.md`.
- Monitor runtime logs for rate-limit database failures, Blob callback/cleanup failures, and decryption errors.

## 10) Coding Conventions

- Validate API input with `zod` and keep trust boundaries server-side.
- Use structured database/URL/crypto APIs; do not reconstruct trusted data with ad hoc strings.
- Persist security-sensitive actions to `AuditLog` without delaying the response.
- Preserve encrypted storage for notes and DB fallback assets.
- Add focused tests for concurrency, authentication, encryption, URL trust, response headers, and failure recovery when those paths change.
- Keep docs, `.env.example`, migration instructions, and tests synchronized with behavior.
- Never expose or commit passwords, tokens, connection strings, encryption keys, dumps, or restored production data.
