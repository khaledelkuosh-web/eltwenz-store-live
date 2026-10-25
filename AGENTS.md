# Eltwenz Store Project Guide

## Repository layout and architecture

- The repository root contains deployment configuration. The application source is in `outputs/`.
- The application is a Node.js 20, dependency-free HTTP server with a plain HTML/CSS/JavaScript storefront and admin UI. Run application commands from `outputs/`.
- `outputs/server.js` owns the API and local server. `outputs/netlify/functions/api.mjs` adapts the same request handler for Netlify Functions.
- `outputs/data/products.json` and `outputs/data/shipping-rates.json` are tracked seed data. Customer, order, inquiry, and token data are local runtime data and must remain ignored. Never print, copy, commit, or expose personal data or secrets while inspecting these files.
- Frontend source files and product images live under `outputs/`. `outputs/scripts/build-static.js` generates `outputs/public/`; edit the source files, never generated copies.
- `STORE_SCHEMA=legacy` is the default. With Supabase credentials it uses the existing `public.store_records` JSONB table; without them it uses local JSON files. `STORE_SCHEMA=relational` is an opt-in adapter that requires the additive migration in `outputs/supabase/migrations/` to be applied first. The Phase 1 export validator is dry-run only and does not import or modify data.
- Render and Netlify manifests both exist. Keep their schema setting at `legacy` until a separately reviewed data migration and cutover are completed. Neither manifest authorizes deployment or a production change.

## Conventions

- Keep browser code dependency-free unless an approved requirement justifies a dependency. Keep route behavior and user-facing copy consistent with the existing Arabic, RTL storefront.
- Use clear English identifiers in JavaScript and SQL. Keep customer-facing messages in the storefront's Egyptian Arabic style.
- Keep request validation and price, discount, shipping, and stock calculations on the server. Persist order-item price/name snapshots so later catalog edits do not rewrite order history.
- Product images are uploaded as files, limited to 5 MiB, and accepted only after server-side JPEG/PNG/WebP signature checks. Store generated names or provider URLs only; never trust a client filename or MIME type. Keep uploaded files out of Git. Local-file uploads on hosted deployments need a configured durable `ELTWENZ_IMAGE_UPLOAD_DIR`; otherwise use the configured Supabase Storage `product-images` bucket or keep uploads unavailable where the filesystem is ephemeral or read-only.
- For hosted product images, upload through the server to a dedicated Supabase Storage `product-images` bucket using the server-only `SUPABASE_SERVICE_ROLE_KEY`. Configure that bucket as public only because product images are intended for every storefront visitor; set a 5 MiB file limit and allow only JPEG/PNG/WebP. Never place Supabase service keys in browser code, logs, or product records. Public image URLs may be stored in product catalog rows. Do not call hosted image uploads operational until a configured project completes a real image upload and storefront readback.
- Make schema changes through versioned SQL migrations. Keep generated assets out of source edits and keep local/customer data out of Git.
- Make changes in small, reviewable milestones. Inspect the diff and run relevant checks at the end of each milestone.

## Security and privacy requirements

- Never commit credentials. `.env.example` may contain placeholder values only. Never expose `SUPABASE_SERVICE_ROLE_KEY` or provider credentials to a browser. Admin login uses the configured `ADMIN_TOKEN` to establish a signed, HttpOnly cookie session; `SESSION_SECRET` must be separate and at least 32 characters. Do not put either secret in browser storage or logs. Cookie-authenticated writes require same-origin and CSRF checks.
- Keep Supabase RLS enabled; do not grant `anon` or `authenticated` direct access to private order/customer data. Public reads must return only explicitly allowlisted catalog fields through the server.
- Treat phone numbers, addresses, order notes, customer records, inquiries, password hashes, and authentication tokens as sensitive. Avoid logging them, displaying them in command output, or including them in test fixtures.
- Keep password hashing salted and deliberately expensive; use timing-safe secret comparisons. Use Secure cookies over HTTPS, HttpOnly, SameSite protections for browser sessions, and CSRF defenses for cookie-authenticated writes.
- Validate and bound every public request on the server. Add abuse controls that work across server instances when the app is scaled; in-memory limits are only a best-effort local safeguard.
- Do not claim payment, carrier/shipping, SMS, WhatsApp, email, or other notification integrations are operational without real credentials, provider-side configuration, and an end-to-end verification. Current order/payment/shipping confirmation remains manual.
- Never deploy to production, change production data, create paid services, or raise billing limits without explicit user approval.

## Testing and verification

- `outputs/package.json` defines `start` and a Node built-in test runner script. Use `npm test` when npm is available; otherwise run `node --test` from `outputs/`.
- For every implementation milestone, run the checks relevant to the changed area: JavaScript syntax checks, static build, unit/API tests, and database migration checks where available. Add focused automated tests for changed behavior as part of approved implementation work.
- Supabase Storage tests must use mocked responses; never upload user files to a real project from automated tests.
- Never run destructive migration or data-reset checks against production. Use disposable/local or explicitly approved staging resources and sanitized fixtures.
- Report exact passed, failed, and not-run checks. `git diff --check` is a review check, not a test suite.
