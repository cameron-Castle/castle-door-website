# Portal Routing Deployment Checklist (`castledoorict.com` canonical)

## Code changes included in this repo

- Updated all homepage portal CTAs to absolute canonical sign-in URL in [`index.html`](index.html:530).
- Added compatibility redirect guard for portal paths in [`fetch()`](Workers/reports-worker.js:2) to reduce host-drift issues.

## Cloudflare route ownership required (production)

Critical:

- If `castledoorict.com/*` is unowned, [`GET /`](Workers/castle-portal.js:730) never reaches a worker, so there is no landing page by definition.

Set these routes to **portal worker**:

- `castledoorict.com/*`
- `www.castledoorict.com/*`
- `castledoorict.com/portal*`
- `www.castledoorict.com/portal*`
- `castledoorict.com/api/portal*`
- `www.castledoorict.com/api/portal*`

Keep these routes on **reports worker**:

- `r.castledoorict.com/r/*`
- `r.castledoorict.com/reports*`
- `r.castledoorict.com/file*`
- `r.castledoorict.com/pdfviewer*`
- any existing upload/report endpoints already serving production report flows

## Portal worker bindings checklist

Required:

- `ENROLL_TOKENS`
- `REPORTS_KV`
- `DEVICE_TOKENS`

Email/login and CTA support:

- `RESEND_API_KEY`
- `RESEND_FROM`
- `RESEND_FALLBACK_TO` (optional)
- `CASTLE_DISPATCH_EMAIL` (optional)
- `REPORTS_ORIGIN` (optional, defaults in worker)

## Post-deploy smoke tests

1. `GET /portal/login` on `https://castledoorict.com` returns login HTML (not homepage, not 404).
2. Submit login form (`POST /api/portal/auth/start`) returns JSON 200 with `traceId` (from [`/api/portal/auth/start`](Workers/castle-portal.js:433)).
3. Magic link callback sets `castle_portal` cookie with secure flags and lands on `/portal`.
4. `/portal` renders dashboard and calls `/api/portal/dashboard` successfully.
5. `https://r.castledoorict.com/r/<UID>` still resolves as before.
6. Reports URLs and historical PDF access are unchanged.

## Login diagnostics now available

[`/api/portal/auth/start`](Workers/castle-portal.js:433) now emits a `traceId` in JSON and logs one of:

- `member-missing-or-inactive`
- `magic-created`
- `email-provider-not-configured`

Use `traceId` to correlate user report -> worker log line quickly.

## Rollback safety

- If any portal deployment issue occurs, revert only portal route ownership; do **not** alter UID/report routes.
- Do not change KV key schemes (`doorIndex:*`, `door:*`, `bizcfg:*`, `portal*`, `enroll:*`) during this routing fix.
