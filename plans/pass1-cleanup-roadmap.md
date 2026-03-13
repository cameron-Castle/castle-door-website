# Pass 1 Cleanup Roadmap (Tier A + Tier B)

## Scope

This pass is limited to compatibility-safe cleanup only:

- No route contract changes
- No KV key format changes
- No R2 object path changes
- No UID resolution behavior changes

Critical invariants preserved:

- Canonical UID QR route remains [`/r/:uid`](Workers/reports-worker.js:2168)
- Historical report file access remains [`/file/...`](Workers/reports-worker.js:1881)
- Historical PDF viewer route remains [`/pdfviewer/...`](Workers/reports-worker.js:2002)
- Existing key assumptions remain (including `doorIndex:<UID>` and `door:<business>:<building>:<slug>` readers in [`fetch()`](Workers/reports-worker.js:2))

## Tier A (Documentation + Safety framing)

- Added this cleanup roadmap document for explicit pass boundaries and invariants.
- Captured the no-contract-change constraint for route, KV, and R2 behavior.

## Tier B (Low-risk structural cleanup)

Shared helper extraction completed in [`Workers/shared/helpers.js`](Workers/shared/helpers.js:1):

- [`slug`](Workers/shared/helpers.js:1)
- [`normalizeEmail`](Workers/shared/helpers.js:8)
- [`isValidEmail`](Workers/shared/helpers.js:10)
- [`normalizePortalRole`](Workers/shared/helpers.js:13)
- [`splitEmailList`](Workers/shared/helpers.js:18)
- [`parseCookies`](Workers/shared/helpers.js:33)
- [`getCookieValues`](Workers/shared/helpers.js:56)
- [`setCookie`](Workers/shared/helpers.js:80)
- [`readJsonBody`](Workers/shared/helpers.js:92)

Workers updated to consume shared helpers:

- Portal worker imports and uses shared helpers in [`Workers/castle-portal.js`](Workers/castle-portal.js:1)
- Reports worker imports shared helpers in [`Workers/reports-worker.js`](Workers/reports-worker.js:1)
- Admin worker imports shared helpers in [`Workers/door-admin.js`](Workers/door-admin.js:1)

## Verification

Syntax check succeeded for all touched worker files and helper module via [`node --check`](Workers/shared/helpers.js:1) run in workspace terminal.

## Deferred

- Tier C boundary cleanup (portal duplicate endpoint retirement path)
- Tier D route dispatch-map restructuring

