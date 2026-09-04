# Castle Door Change Log

Purpose: durable, cross-chat record of production-impacting changes.

## 2026-09-04 — Low-risk cleanup pass on Workers + API functions, deferred list for the rest

### Scope
- [`Workers/reports-worker.js`](Workers/reports-worker.js)
- [`Workers/castle-portal.js`](Workers/castle-portal.js)
- [`Workers/door-admin.js`](Workers/door-admin.js)
- [`functions/api/quote-request.js`](functions/api/quote-request.js)
- [`functions/api/contact-request.js`](functions/api/contact-request.js)
- [`portal-sample.html`](portal-sample.html)
- [`CHATBOT/README.md`](CHATBOT/README.md)
- [`.gitignore`](.gitignore)

### Why this was done
- Follow-up to a full codebase read-through/assessment against the prior self-audits in [`pprobs.md`](../pprobs.md) and [`starting a fight.md`](../starting%20a%20fight.md).
- Explicit instruction: only make changes with no realistic chance of disrupting live production; anything uncertain goes on a deferred list instead of being guessed at.

### Implemented changes
- **HTML-escaped CTA email fields** (previously interpolated raw into outbound Resend HTML, allowing markup/link injection from an unauthenticated submitter) — added a local `escHtml()` and applied it to all client-supplied fields in [reports-worker.js CTA email body](Workers/reports-worker.js:460) and [castle-portal.js CTA email body](Workers/castle-portal.js:713). Matches the escaping pattern already used in `quote-request.js`/`contact-request.js`. No behavior change for normal text; only affects how special characters render.
- **Removed confirmed-dead code**: the `if (false && ...)` legacy `/portal` route block in castle-portal.js (was ~70 lines, unreachable since `false &&` always short-circuits) — deleted outright. Zero runtime behavior change; this resolves `pprobs.md` item 5.
- **Fixed the `displayName` "Main" fallback bug** in door-admin.js's buildings-list endpoint (`pprobs.md` item 2): a premature `displayName = "Main"` was set before the door-record-based fallback ever got a chance to run, permanently short-circuiting it. Removed the premature fallback so buildings without a `bldcfg` record now correctly pick up their name from an uploaded door record before falling back to "Main" — see [the fallback chain](Workers/door-admin.js:3743-3775). Also removed an adjacent duplicate `KV.put` call that wrote the identical value twice. **Note:** this restores the code's own clearly-documented intent (the fix follows a "Final fallback" comment that was literally duplicated by the bug), but it does mean some buildings currently displayed as "Main" in the admin UI will now show their real uploaded name, and the first admin page-load for a given building after this ships will trigger one additional KV write to seed `bldcfg:<biz>:<buildingCode>`.
- **Constant-time admin key comparison**: `POST /admin/login` compared `key !== env.ADMIN_KEY` directly (a timing side-channel). Added a small `timingSafeEqual()` helper and swapped it in — see [door-admin.js:91](Workers/door-admin.js:91) and [door-admin.js:818](Workers/door-admin.js:818). Accepts/rejects exactly the same keys as before; only removes timing variance.
- **Stopped leaking internal error detail to callers**: `quote-request.js` and `contact-request.js` returned Resend's raw error body and exception messages in the JSON response (`details` field). Confirmed the frontend (`quote.html`/`contact.html`) only ever reads `out.error`, never `out.details`, so this field was pure information disclosure with no functional use. Now logged server-side via `console.error` instead of returned to the caller.
- **De-hardcoded the quote recipient**: `quote-request.js` had `Cameron@castledoorandhardware.com` hardcoded; changed to `env.QUOTE_TO_EMAIL || "Cameron@castledoorandhardware.com"` (same default, now overridable without a code change), matching the pattern already used in `contact-request.js`.
- **Doc/hygiene only**: removed a dead `/sample-report` link from the orphaned [`portal-sample.html`](portal-sample.html) (target file no longer exists in the repo, and nothing links to this page); fixed a stale line in [`CHATBOT/README.md`](CHATBOT/README.md) that still said the chat assistant UI lives in `index.html` (it moved to `quote.html` in the SEO page-split done earlier); deduplicated [`.gitignore`](.gitignore), which had the same ~15-line block pasted in three times (72 lines → 42, no pattern changes).

### Verified with no changes needed
- `pprobs.md` item 3 (status normalization "flagged"/"Fail"/"Flagged" round-trip) — already fixed in a prior session, confirmed still correct.
- `pprobs.md` item 1 (wrong `businessCode` from `buildingCode` attribute in portal CTA) — confirmed not reproducible in current code; also double-guarded server-side.
- `starting a fight.md` items: `readyToSubmit`/`canSubmit` mismatch, `fireRated` boolean coercion, `requestType` silent default, client-trusted `currentStep`, missing rate limiting/logging on the production chatbot, and missing contradictory-combo validation — all confirmed already fixed in `functions/api/chatbot-quote.js` in a prior session.

### Explicitly deferred — needs a decision before touching, not done here
These all have a plausible failure mode if changed blindly, so nothing was edited:
- **Admin session model** (`door-admin.js`, `reports-worker.js`, `Workers/currentlivecode.js`): `admin_auth` cookie is a static `"ok"` string with no expiry, no per-session token, and no revocation. Real fix is a signed/expiring session, which is a behavior change to the live admin login flow and needs a coordinated rollout (this repo has no `wrangler.toml`/CI — deploys are manual via the Cloudflare dashboard per `plans/portal-routing-deploy-checklist.md`, so there's no way for me to verify a deploy here).
- **`pprobs.md` item 6** — door-admin.js UI filters businesses/buildings to exactly 6-character slugs in 6 places. Unclear whether non-6-char slugs are legacy data that's intentionally hidden or a real visibility bug; removing the filter could suddenly surface data admins don't expect to see.
- **`pprobs.md` item 4** — business/building code generation has no collision check (`Math.random()` + get-then-put, no compare-and-swap). Fixing this touches the live upload/ingest write path; needs a designed fix, not a quick patch.
- **`pprobs.md` item 7 (remainder)** — `/admin/stale-doors` and the duplicate-scan inside `/admin/hard-delete-uid` still do fully unbounded `KV.list`/`KV.get` scans (unlike `/admin/search`, which already has scan/time budgets). Hard-delete is destructive; changing its scan semantics needs an explicit decision on fail-safe vs. fail-fast behavior.
- **Rate limiting / CSRF-origin checks on `quote-request.js` and `contact-request.js`** — currently none. The chatbot endpoint's own rate limiter is also known-imperfect (in-memory `Map`, resets per isolate, doesn't hold up across Cloudflare's edge). Adding limits is a new behavior on a live public endpoint and needs a threshold/response design, not a guess.
- **`isConfusedReply()` in `chatbot-quote.js:748`** — flagged in `starting a fight.md` as a "precedence bug," but on inspection there's no actual operator-precedence error; the real issue is the match is too broad (any short message ending in "?" containing "wood/metal/new/replace" is classified as confused, including legitimate questions like "is wood okay for exterior?"). Narrowing this correctly is a judgment call about intended bot behavior, not a mechanical fix — left alone.
- **`chatbot-quote-preview.js` drift from production** — it's a hand-duplicated state machine, feature-flagged off by default (`CHATBOT_PREVIEW_ENABLED`), already missing several fixes `chatbot-quote.js` has (rate limiting, timeout/error logging, evidence-gated submit, contradiction validation, and the `requestType` default fix — its `requestType` enum doesn't even include `"unknown"` as a valid value, so changing just the default would need a matching schema change, not a one-line patch). Recommend deciding whether to keep syncing it or delete it, rather than partially patching it.
- **`Workers/currentlivecode.js`** — an untracked, ~600-line-stale duplicate of `door-admin.js` (missing `/admin/comment-settings`, `/admin/hard-delete-uid`, and a merge-modal bug fix that `door-admin.js` has). Left untouched since it's not part of any known deploy path and deleting someone's local file without being asked isn't something to do unprompted — but it should be either deleted or clearly relabeled as a dated snapshot so it doesn't get mistaken for a rollback reference.
- **`chatTranscript` trust in `quote-request.js`** — the chat transcript emailed to sales is entirely client-supplied and unverified (a user could fabricate assistant lines). Real fix means moving transcript storage server-side keyed by session, which is a bigger architecture change than a cleanup pass.

### Safety/compatibility impact
- No route, KV key, or R2 path changes.
- No changes to UID identity, QR behavior, or destructive admin flows (burn/hard-delete untouched).
- Every edited `.js` file passed `node --check` after editing.
- All changes are either (a) escaping/logging hardening with no functional behavior change for legitimate input, (b) removal of code already confirmed unreachable or a no-op duplicate, or (c) a narrowly-scoped bug fix restoring behavior the code's own comments already describe as intended — except the `displayName` fallback fix, which is called out above because it does change what some admin users will see and triggers one additional KV write per affected building on first view.

## 2026-05-29 — Mobile responsiveness pass for homepage

### Scope
- [`index.html`](index.html)

### Why this was done
- Requested a more mobile-friendly website experience across small phones and tablets.
- Needed to reduce header crowding, improve tap comfort, and tighten small-screen spacing without changing existing flows.

### Implemented changes
- Improved mobile header behavior in [`.site-header__inner`](index.html:1060) and [`.actions`](index.html:1072) by allowing wrap and horizontal scroll for action buttons instead of cramped overflow.
- Added button flex guard in [`.actions .btn`](index.html:151) so action chips keep readable width while scrolling.
- Reduced hero top spacing at tablet/phone sizes in [`.hero`](index.html:1080) for better first-screen composition.
- Increased touch comfort on smaller screens by adjusting [`.btn`](index.html:1094) min-height/padding and tightening content cards/forms in [`.card`](index.html:1099), [`.quote-form`](index.html:1100), [`.quote-panel`](index.html:1101), [`.contact-card`](index.html:1102), and [`.modal__card`](index.html:1103).
- Improved mobile readability and fit by tuning [`.section-copy`](index.html:1105), [`.hero__lead`](index.html:1106), [`.step p`](index.html:1107), map height in [`.map-card`](index.html:1109), and hero caption sizing in [`.hero-focus-photo__caption`](index.html:1111).
- Added an extra-small breakpoint for very narrow devices in [`@media (max-width: 390px)`](index.html:1118), including tighter container/panel sizing and compact quote controls.

### Safety/compatibility impact
- Presentation-only CSS updates on the public homepage.
- No Worker routes, no UID identity changes, no `/r/:uid` behavior changes, and no KV/R2 key/path changes.

### Follow-up mobile header correction (same day)
- Replaced horizontal-scroll header actions at mobile widths with wrapped action rows in [`.actions`](index.html:1072) to prevent clipped/awkward CTA presentation on narrow screens.
- Tuned mobile action button sizing in [`.actions .btn`](index.html:1080) for better fit and readability.
- Added two-column compact action behavior at extra-small widths in [`@media (max-width: 390px)`](index.html:1127) so top actions stay visible and tappable without overlap.

### Follow-up demo mobile alignment fix (same day)
- Forced demo cards to single-column stack on small phones in [`#demo .cards-3`](index.html:1110), overriding inline two-column grid that caused cramped side-by-side cards.
- Reset the first demo card span behavior on small screens in [`#demo .card[style*="grid-column"]`](index.html:1111) so all demo cards flow evenly.
- Switched demo screenshot viewport to a taller mobile ratio in [`.demo-slider__viewport`](index.html:1113) and top-focused crop in [`.demo-slider__viewport img`](index.html:1117) for better in-frame readability.

### Follow-up portal mobile table fix (same day)
- Updated portal small-screen layout in [`Workers/castle-portal.js`](Workers/castle-portal.js) so the door list no longer compresses columns off-screen.
- Added a card-style responsive table transform under [`@media(max-width:640px)`](Workers/castle-portal.js:1071): hides table header, renders each row as a stacked card, and labels each cell (`Door`, `Status`, `Building`, `Last inspected`, `Actions`) with pseudo-headings.
- Improved mobile action usability in [`#doorRows td.actions`](Workers/castle-portal.js:1091) by wrapping buttons/links and enforcing minimum tap height.

### Follow-up portal density trim (same day)
- Reduced vertical space usage of portal mobile door cards in [`@media(max-width:640px)`](Workers/castle-portal.js:1071) by tightening row spacing, cell padding, and label spacing.
- Removed redundant secondary door-id line on mobile via [`#doorRows td:first-child .muted`](Workers/castle-portal.js:1080) to prevent duplicated door text.
- Compactified mobile action row spacing and control height in [`#doorRows td.actions`](Workers/castle-portal.js:1086) for faster scanning with less scroll.

### Follow-up portal horizontal-density mode (same day)
- Switched mobile door list back to compact horizontal table mode in [`@media(max-width:640px)`](Workers/castle-portal.js:1071) so users can scan more doors per screen instead of tall stacked cards.
- Reduced mobile table typography and cell padding in [`tbody td`](Workers/castle-portal.js:1081), [`th`](Workers/castle-portal.js:1083), and [`.pill`](Workers/castle-portal.js:1087) for denser, readable rows.
- Shrunk mobile status/building filter footprint by changing [`.filters`](Workers/castle-portal.js:1074) to `search + compact status/building selects` and tightening control sizing in [`#q,#status,#building`](Workers/castle-portal.js:1076).

### Follow-up floating mobile filters + fit pass (same day)
- Made the mobile filter bar float/stick over the door list using sticky positioning and backdrop styling in [`.filters`](Workers/castle-portal.js:1077).
- Reduced column pressure so table fits better on narrow phones by hiding `Last inspected` at mobile width in [`table th:nth-child(4), table td:nth-child(4)`](Workers/castle-portal.js:1087).
- Further compacted row and control density for mobile scanability via [`tbody td`](Workers/castle-portal.js:1085), [`th`](Workers/castle-portal.js:1086), and [`#doorRows td.actions .link, #doorRows td.actions button`](Workers/castle-portal.js:1090).

## 2026-04-29 — Added Cloudflare Access app JSON backup file for temporary lockdown pause workflow

### Scope
- [`plans/lockdown-backup.json`](plans/lockdown-backup.json)

### Why this was done
- Needed a safe local backup of the Cloudflare Zero Trust Access application configuration before temporary deletion/pause.
- This supports fast rollback/recreation of the `Castledoor Lockdown` Access app without guessing prior settings.

### Implemented changes
- Created [`plans/lockdown-backup.json`](plans/lockdown-backup.json) and populated it with the exported Access app JSON payload.
- Fixed initial JSON syntax issue by removing an accidental leading empty object token so the file is valid JSON.

### Safety/compatibility impact
- No runtime website/worker logic changed.
- No UID identity, `/r/:uid`, KV key naming, or R2 object path behavior changed.
- Change is documentation/config-backup only for Cloudflare Access operations.

## 2026-04-27 — Quote intake recipient lock + rep badge removal + demo panel copy expansion

### Scope
- [`index.html`](index.html)
- [`functions/api/quote-request.js`](functions/api/quote-request.js)

### Why this was done
- Removed redundant quote-submit badge copy (`Delivered directly to ...`) per request.
- Required quote requests to route directly to Cameron.
- Expanded demo panel messaging so users understand what the portal demo and report viewer demo do and why each is useful.

### Implemented changes
- Removed the rep badge element from quote submit row in [`#qManualSubmitRow`](index.html:1368).
- Set hidden quote rep default to Cameron in [`qQuoteRep`](index.html:1366).
- Removed unused rep-rotation UI logic and references in quote script setup (`qRepBadge`, `quoteReps`, and [`pickQuoteRep()`](index.html:1554)).
- Forced quote-email recipient and rep naming to Cameron in [`onRequestPost()`](functions/api/quote-request.js:69).
- Replaced brief demo blurb with two detailed demo descriptions (Report Viewer Demo and Portal Demo) and retained direct links in [`#demo`](index.html:1175).

### Safety/compatibility impact
- No changes to UID identity, `/r/:uid`, KV key patterns, R2 object paths, or QR permanence behavior.
- Changes are limited to website quote-intake UX text/behavior and quote email recipient routing.

### Follow-up demo layout split (same day)
- Split the combined demo card into two separate cards in [`#demo`](index.html:1175): one for Report Viewer and one for Portal.
- Updated demo grid from two columns to three columns in [`cards-3` demo row](index.html:1184) to keep Quote Workflow, Report Viewer Demo, and Portal Demo as distinct panels.

### Follow-up demo slideshow upgrade (2026-04-29)
- Replaced static demo images with per-panel slideshow components in [`#demo`](index.html:1175):
  - Report Viewer slider now uses [`assets/report-1.png`](assets/report-1.png), [`assets/report-2.png`](assets/report-2.png), and [`assets/report-3.png`](assets/report-3.png).
  - Portal slider now uses [`assets/Portal-1.png`](assets/Portal-1.png), [`assets/Portal-2.png`](assets/Portal-2.png), and [`assets/Portal-3.png`](assets/Portal-3.png).
- Added reusable slider styling for viewport, nav buttons, dots, and counters in [`<style>`](index.html:520).
- Added lightweight slider controller logic in [`initDemoSliders()`](index.html:1845) with auto-rotate, dot navigation, prev/next controls, and pause-on-hover/focus behavior.

### Follow-up slider control removal + image fit tuning (2026-04-29)
- Removed all customer-facing manual slider controls (prev/next buttons, dots, and count bar) from both demo cards in [`#demo`](index.html:1192).
- Kept automatic rotation only via [`initDemoSliders()`](index.html:1917), so customers cannot choose a specific slide.
- Tuned screenshot rendering for edited images by changing demo image fit from `cover` to `contain` in [`.demo-slider__viewport img`](index.html:535), with centered positioning and a stable minimum viewport height in [`.demo-slider__viewport`](index.html:529).

### Follow-up readability sizing increase for edited screenshots (2026-04-29)
- Increased demo screenshot viewport size in [`.demo-slider__viewport`](index.html:529) by switching to `aspect-ratio: 16 / 9` and `min-height: 320px` for better legibility.
- Changed demo card grid from 3 columns to 2 columns in [`#demo`](index.html:1184), and made the Supply Quote card span full width so Report Viewer and Portal demos each get more horizontal space.

### Follow-up black-bar removal on demo screenshots (2026-04-29)
- Removed letterboxing behavior by switching demo screenshots from `object-fit: contain` to `object-fit: cover` in [`.demo-slider__viewport img`](index.html:535).
- Set `object-position: center top` in [`.demo-slider__viewport img`](index.html:535) to prioritize top content visibility while filling the frame.

### Follow-up asset rename alignment (2026-04-29)
- Updated demo slider image references in [`#demo`](index.html:1192) to match renamed files in [`assets`](assets):
  - Report Viewer: `report-1/2/3.png` → `report1/2/3.png`
  - Portal: `Portal-1/2/3.png` → `Portal1/2/3.png`

### Follow-up centering + de-zoom adjustment (2026-04-29)
- Updated demo image rendering in [`.demo-slider__viewport img`](index.html:535) from `object-fit: cover` to `object-fit: contain`.
- Set `object-position` to `center center` in [`.demo-slider__viewport img`](index.html:535) so screenshots stay centered.
- Changed viewport background in [`.demo-slider__viewport`](index.html:529) to blend with card surface and reduce harsh bar contrast.

## 2026-04-27 — Homepage repositioned to supplier-first (no service/report emphasis)

### Scope
- [`index.html`](index.html)

### Why this was done
- Requested website messaging shift to reflect core business reality: commercial door, frame, and hardware supplier.
- Requested removal of service-work emphasis and reduction of inspection-report focus.
- Requested imagery emphasis on shop/welding-table work.

### Implemented changes
- Updated SEO metadata in [`<head>`](index.html:6) to supplier-focused title/description.
- Updated brand subtitle and top nav actions in [`<header>`](index.html:1048) to remove report/portal emphasis and prioritize capabilities + quote flow.
- Switched hero primary image to shop welding photo and updated headline/copy/CTAs in [`#overview`](index.html:1068) for supply-first positioning.
- Rewrote hero highlight points and trust-story copy in [`#overview`](index.html:1093) to focus on supply, fabrication, and hardware guidance.
- Updated supporting shop imagery/captions in [`local-proof__photos`](index.html:1119) to emphasize storefront + welding-table context.
- Reworked [`#pathways`](index.html:1132) into supply-capabilities content (door supply, frame fabrication, hardware supply) with quote-oriented CTAs.
- Reworked [`#demo`](index.html:1171) into supplier process messaging and quote/contact entry points instead of report/portal demo links.
- Updated contact section headline/copy and quick-action CTA in [`#contact`](index.html:1379) to supply support and quote intake.

### Safety/compatibility impact
- Presentation/content-only homepage changes.
- No Worker route behavior, `/r/:uid`, KV key patterns, R2 object paths, or QR permanence behavior changed.

### Follow-up media adjustment (same day)
- Updated requested image set in [`#overview`](index.html:1068) and supporting sections to match preferred assets.
- Set top hero image to [`assets/shop-front1.png`](assets/shop-front1.png) in [`hero-focus-photo`](index.html:1070).
- Swapped supporting photos to [`assets/Shopside.png`](assets/Shopside.png), [`assets/weld1.png`](assets/weld1.png), and [`assets/weld2.png`](assets/weld2.png) across [`local-proof__photos`](index.html:1119) and [`#demo`](index.html:1180).

### Follow-up minor copy adjustment (same day)
- Updated section kicker casing from `Request quote` to `Request Quote` in [`#quote`](index.html:1196) for consistency.

### Follow-up copy correction (same day)
- Updated hero caption wording in [`#overview`](index.html:1068) from Wichita-built phrasing to `Built in America` to reflect that not all supplied frames are built on-site.

### Follow-up chatbot/navigation adjustment (same day)
- Removed interior/exterior fallback prompt behavior from low-signal and off-topic reply fallbacks in [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js) by changing default next focus to frame-size collection (`frameWidthIn`) instead of `application`.
- Added a header demo banner button next to capabilities in [`<header>`](index.html:1048) linking directly to [`#demo`](index.html:1171).

### Follow-up quote UI polish (same day)
- Updated primary button styling in [`index.html`](index.html) to remove the bright orange ombré and use a darker neutral gradient.
- Hid the `What to include` side panel by default and now show it only for assistant mode via [`#quoteInfoPanel`](index.html) toggle logic in [`setQuoteExperience()`](index.html).

### Follow-up visual cleanup + assistant labeling (same day)
- Removed Demo button emphasis in header by switching it from primary styling to standard [`btn`](index.html) in [`<header>`](index.html:1048).
- Replaced redundant `Talk to the Team` demo card with a shop-build snapshot card using [`assets/weld3.png`](assets/weld3.png) in [`#demo`](index.html:1171).
- Updated assistant label text to `Assistant (BETA)` in [`#chatbotBox`](index.html:1225) so users see beta status immediately.
- Further reduced orange bleed by moving primary button background from gradient to darker solid neutral tones in [`.btn--primary`](index.html:156).

### Follow-up chatbot intake priority adjustment (same day)
- Updated chatbot intake behavior in [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js) so information gathering stays prioritized while allowing intentional skips.
- Added `deferredFields` handling in [`sanitizeDraft()`](functions/api/chatbot-quote.js:258) to persist skip choices.
- Updated [`getNextField()`](functions/api/chatbot-quote.js:744) to avoid re-asking deferred non-core fields (`frameWidthIn`, `frameDepth`, `company`).
- Updated prompt wording in [`buildNextQuestion()`](functions/api/chatbot-quote.js:754) and [`buildClarifyingQuestion()`](functions/api/chatbot-quote.js:767) to explicitly allow `skip`.
- Added skip-intent capture in [`mapShortAnswerByStep()`](functions/api/chatbot-quote.js:594) to mark deferred fields and continue intake flow without blocking.

### Follow-up primary button gradient restore (same day)
- Restored a stronger warm ombré treatment for primary actions in [`.btn--primary`](index.html:156) and [`.btn--primary:hover`](index.html:163), while adding a muted disabled state for better visual consistency in [`.btn--primary:disabled`](index.html:167).

### Follow-up quote delivery routing UI lock (same day)
- Updated front-end quote rep picker source in [`quoteReps`](index.html:1538) to Cameron-only so manual quote intake no longer randomly displays or submits to Brad/Kale from the website UI.

### Follow-up demo access restore (same day)
- Restored direct access links for both report viewer and portal demos inside [`#demo`](index.html:1175) by replacing the second card content with:
  - `Open Demo Report Viewer` → `https://r.castledoorict.com/reports/p0bwkg/09in5f/co1?scope=all`
  - `Open Demo Portal` → `https://castledoorict.com/portal?biz=p0bwkg`

## 2026-04-27 — Force chatbot quote emails to Cameron only

### Scope
- [`functions/api/quote-request.js`](functions/api/quote-request.js)

### Why this was done
- Chatbot-generated quote emails were reaching non-Cameron reps during testing.
- Required behavior is that chatbot quote submissions always route to Cameron only.

### Implemented changes
- Added chatbot detection in [`onRequestPost()`](functions/api/quote-request.js:1) using transcript presence (`cleanedTranscript.length > 0`).
- Updated recipient routing so chatbot submissions force [`quoteTo`](functions/api/quote-request.js:74) to `Cameron@castledoorandhardware.com`.
- Updated [`quoteRepName`](functions/api/quote-request.js:75) for chatbot submissions to always resolve as `Cameron` for subject/display consistency.
- Preserved existing non-chatbot/manual quote routing logic via `quoteRepMap` + `QUOTE_TO_EMAIL` fallback.

### Safety/compatibility impact
- No changes to UID identity, `/r/:uid`, KV keys, R2 object paths, or QR behavior.
- Change is isolated to quote-email recipient routing logic in quote request handling.

## 2026-04-24 — Chatbot intake redesign for frame-first quoting + live captured-values panel

### Scope
- [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js)
- [`functions/api/quote-request.js`](functions/api/quote-request.js)
- [`index.html`](index.html)

### Why this was done
- Updated chatbot interaction to match approved intake behavior: brief responses, one question at a time, and required collection of name/email/company plus frame width/height/depth.
- Replaced right-side quote checklist semantics with live captured-value display using `N/A` placeholders.
- Added rough-opening-to-frame deduction support and aligned assistant/manual submit validation with the new required fields.

### Implemented changes
- In [`getNextField()`](functions/api/chatbot-quote.js:745), changed progression priority to frame size/depth and contact/company requirements.
- Added frame-size fields and rough-opening derivation handling in [`sanitizeDraft()`](functions/api/chatbot-quote.js:274), [`applyDeterministicExtraction()`](functions/api/chatbot-quote.js:392), and [`mapShortAnswerByStep()`](functions/api/chatbot-quote.js:594).
- Added concise response control via [`enforceTwoLineReply()`](functions/api/chatbot-quote.js:200) and applied it before orchestration in [`onRequestPost()`](functions/api/chatbot-quote.js:166).
- Updated domain-QA behavior to “educate then ask” in [`buildDomainQaReply()`](functions/api/chatbot-quote.js:815).
- Updated required submission/evidence checks for frame width/height/depth + company/email/name in [`getMissingSubmitFields()`](functions/api/chatbot-quote.js:1089) and [`hasRequiredEvidence()`](functions/api/chatbot-quote.js:1419).
- Added guided form inputs for frame width/height in [`#guidedFields`](index.html:1269) and wired them into live panel rendering, manual payload build, and guided validation in [`refreshQuoteChecklist()`](index.html:1593) and quote submit handling in [`quoteForm.addEventListener("submit", ...)`](index.html:1989).
- Updated assistant submit gating to require the same field set in [`chatbotSubmit` click handler](index.html:1931).
- Added frame size fields to quote email payload rendering in [`functions/api/quote-request.js`](functions/api/quote-request.js:23) and guided summary blocks in [`guidedHtml`](functions/api/quote-request.js:151).

### Safety/compatibility impact
- No changes to UID identity, `/r/:uid`, KV key patterns, R2 object paths, or QR permanence behavior.
- Changes are constrained to quote-intake UX and quote email payload formatting.

## 2026-04-24 — Active quote checklist in quote side panel

### Scope
- [`index.html`](index.html)

### Why this was done
- Requested the highlighted quote-side panel to act as a live checklist that updates based on required quote information.

### Implemented changes
- Replaced static checklist content with dynamic checklist container and summary message in the quote panel.
- Added checklist item UI states (missing/complete/optional) and status-pill styling to improve at-a-glance clarity.
- Added live checklist rendering logic for both manual form modes and assistant mode.
- Wired checklist refresh behavior to relevant form inputs, quote mode/experience changes, chatbot response updates, and post-submit reset.

### Safety/compatibility impact
- Static presentation/client-side behavior only.
- No Worker routes, UID logic, `/r/:uid`, KV key patterns, or R2 object path behavior changed.

### Follow-up bug fix (same day)
- Fixed checklist logic that incorrectly showed some untouched fields as `Complete`.
- Added non-applicable (`N/A`) state handling for conditional rows (wall detail and wood species) in [`index.html`](index.html).
- Corrected manual checklist booleans so fire-rated/vision-kit rows only show complete when explicitly selected.

## 2026-04-24 — Homepage theme redesign using PIC references imagery

### Scope
- [`index.html`](index.html)

### Why this was done
- Requested a full visual theme refresh of the public website using provided [`PIC references`](PIC references) photos.
- Needed a stronger industrial/fabrication visual identity aligned with real weld-shop work.

### Implemented changes
- Updated global theme tokens in [`:root`](index.html:10) to a deeper steel-blue palette with warm spark accents for stronger brand contrast.
- Refined page atmosphere/background and sticky header surface styling in [`body`](index.html:34) and [`.site-header`](index.html:53).
- Updated primary CTA styling in [`.btn--primary`](index.html:155) to a dark-to-heat gradient matching the new visual direction.
- Enhanced hero treatment in [`.hero-focus-photo`](index.html:338) with stronger framing, cinematic overlay, adjusted crop, and caption contrast for readability.
- Shifted panel/surface tones across sections via [`.panel`](index.html:444), [`.local-proof`](index.html:325), and [`.contact-panel`](index.html:851) to keep contrast and consistency with darker imagery.
- Replaced hero image with high-impact weld image from [`PIC references/ChatGPT Image Apr 24, 2026, 12_49_37 PM.png`](PIC references/ChatGPT Image Apr 24, 2026, 12_49_37 PM.png) in [`#overview`](index.html:1025).
- Expanded trust photo area to two supporting weld images and updated captions/alt text in [`#overview`](index.html:1060):
  - [`PIC references/ChatGPT Image Apr 24, 2026, 01_31_36 PM.png`](PIC references/ChatGPT Image Apr 24, 2026, 01_31_36 PM.png)
  - [`PIC references/ChatGPT Image Apr 24, 2026, 11_50_10 AM.png`](PIC references/ChatGPT Image Apr 24, 2026, 11_50_10 AM.png)

### Safety/compatibility impact
- Static website presentation only.
- No Worker routes, UID logic, `/r/:uid`, KV key patterns, or R2 object path behavior changed.

### Follow-up fix (same day)
- Resolved broken homepage image rendering caused by direct paths containing spaces/commas.
- Switched live image references in [`#overview`](index.html:1037) from `PIC references/...` to URL-safe files under [`assets`](assets):
  - [`assets/welder-frame-fab.png`](assets/welder-frame-fab.png)
  - [`assets/welder-corner-detail.png`](assets/welder-corner-detail.png)
- Updated hero back to storefront in [`#overview`](index.html:1037) using [`assets/shop-front.png`](assets/shop-front.png) so the office presence matches the refreshed industrial theme.

### Follow-up image swap (same day)
- Replaced the secondary trust photo in [`#overview`](index.html:1088) with a stronger weld action shot.
- Added URL-safe asset [`assets/welder-sparks-midshot.png`](assets/welder-sparks-midshot.png) and updated the second trust image source in [`index.html`](index.html).

### Follow-up theme shift (same day)
- Adjusted homepage visual system in [`index.html`](index.html) from blue-forward tones to darker industrial neutrals (charcoal, steel-brown, copper heat accents).
- Updated key surfaces and components to match weld-shop photo mood, including header, buttons, cards, trust/story panels, quote UI, contact blocks, and modal styling in [`<style>`](index.html:10).
- Preserved route behavior and application logic; this is a presentation-only theme update.

## 2026-04-24 — Added DNG-to-JPG batch conversion utility script

### Scope
- [`scripts/convert-dng-to-jpg.py`](scripts/convert-dng-to-jpg.py)

### Why this was done
- Needed real file conversion (not extension rename) from `.dng` to `.jpg`.
- Existing environment did not have `ImageMagick` or `ffmpeg` available in PATH, so a Python-based converter was added.

### Implemented changes
- Added CLI utility [`scripts/convert-dng-to-jpg.py`](scripts/convert-dng-to-jpg.py) to batch-convert RAW DNG files into JPGs.
- Added options for:
  - input directory (`--input`)
  - recursive scanning (`--recursive`)
  - JPG quality (`--quality`)
  - overwrite control (`--overwrite`)
  - optional source cleanup (`--delete-dng`)
- Added dependency checks with install guidance for `rawpy` and `Pillow`.
- Included top-of-file usage examples for quick run commands.

### Safety/compatibility impact
- No Worker routes changed.
- No UID, `/r/:uid`, KV key, binding, or R2 object path changes.
- Change is an additive local utility script only.

## 2026-04-23 — Door material unknown handling in chatbot intake

### Scope
- [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js)

### Why this was done
- Added explicit handling when a customer says they do not know the door material during guided intake.

### Implemented changes
- In [`step === "doorMaterial"`](functions/api/chatbot-quote.js:605), added unknown-intent detection for phrases like `unknown`, `not sure`, `don't know`, `idk`, and `unsure`.
- When detected, sets [`draft.doorMaterial`](functions/api/chatbot-quote.js:617) to `unknown` and appends a deduplicated note via [`appendUniqueNote()`](functions/api/chatbot-quote.js:836): `Customer does not know door material yet.`

### Safety/compatibility impact
- Route behavior unchanged (`POST /api/chatbot-quote`).
- No UID, `/r/:uid`, KV key, R2 path, or worker binding changes.

## 2026-04-22 — Set chatbot model default to GPT-5.4-mini

### Scope
- [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js)
- [`functions/api/chatbot-quote-preview.js`](functions/api/chatbot-quote-preview.js)

### Why this was done
- Requested default model routing to `gpt-5.4-mini` for chatbot quote endpoints.

### Implemented changes
- Updated OpenAI model fallback in [`getOpenAIUpdates()`](functions/api/chatbot-quote.js:1720) from `gpt-5.4-nano` to `gpt-5.4-mini`.
- Updated preview endpoint model fallback in [`getOpenAIUpdates()`](functions/api/chatbot-quote-preview.js:333) from `gpt-4.1-nano` to `gpt-5.4-mini`.

### Safety/compatibility impact
- Route paths unchanged (`POST /api/chatbot-quote`, `POST /api/chatbot-quote-preview`).
- UID routing and `/r/:uid` behavior unchanged.
- No KV key, R2 object path, or binding-name changes.

## 2026-04-21 — Homepage trust-first aesthetic refresh (local-business tone)

### Scope
- [`index.html`](index.html)

### Why this was done
- The homepage felt impersonal and "scammy" without visual proof or a human/local voice.
- Needed a warmer, trust-first presentation aligned with a Wichita local-service identity.

### Implemented changes
- Updated hero copy in [`#overview`](index.html:872) to emphasize local team support over SaaS-style language.
- Added new trust section layout/styles (`local-proof`, `local-proof__story`, `local-proof__photos`, `trust-photo`) in [`<style>`](index.html:325) for a more personal visual block.
- Added owner-note style content and local-proof bullets under the hero in [`#overview`](index.html:930).
- Added two photo cards with captions and accessible `alt` text in the new trust section to provide immediate visual proof/context.
- Replaced temporary external stock image URLs with local uploaded assets in [`#overview` trust photos](index.html:1030):
  - [`assets/shop-front.png`](assets/shop-front.png)
  - [`assets/Shopside.png`](assets/Shopside.png)
- Follow-up: promoted [`assets/shop-front.png`](assets/shop-front.png) to a top-of-hero main-focus image and increased visual prominence via new [`hero-focus-photo`](index.html:338) styling and placement above the hero content in [`#overview`](index.html:955).
- Follow-up: simplified the lower trust image block to a single secondary support photo ([`assets/Shopside.png`](assets/Shopside.png)) so the top image remains the primary visual anchor.
- Follow-up: increased secondary trust photo prominence by adding [`trust-photo--secondary`](index.html:388) and applying it to the lower support image in [`#overview`](index.html:1042).
- Updated responsive rules so the new trust/photo layout collapses cleanly on tablet/mobile in [`@media` rules](index.html:820).

### Safety/compatibility impact
- Public routes and portal/report links: unchanged.
- UID identity model and `/r/:uid` behavior: unchanged.
- No worker/KV/R2 behavior changed; static homepage presentation update only.

## 2026-04-21 — Homepage content simplification + contractor-first personalization

### Scope
- [`index.html`](index.html)

### Why this was done
- Homepage needed a more direct, personal contractor-facing message and less marketing-heavy structure.
- Requested removal of sections/buttons that felt redundant.

### Implemented changes
- Removed the hero “Platform experience” card block from [`#overview`](index.html:955).
- Rewrote owner note copy to emphasize working alongside contractors, calling with questions, and one-office-in-Wichita context in [`#overview`](index.html:1018).
- Removed the “Continuity over time” panel and removed duplicate portal login CTA in the access area in [`#access`](index.html:1108).
- Removed the entire service-flow section (`#service`) and corresponding footer anchor.
- Added team visibility (`Cameron, Kale, Josh`) in contact metadata at [`#contact`](index.html:1317).
- Added recipient multi-choice to “Email the Experts” modal with `recipient` field (`Cameron/Kale/Josh`) and included it in contact payload submission in [`contactModalForm` submit handler](index.html:1902).
- Reduced primary-colored CTA use in top-level/quick-action sections by converting those buttons to standard [`btn`](index.html:131).
- Follow-up: updated top hero photo caption to single-location wording with explicit address (`3515 N Santa Fe, Wichita, KS 67219`) in [`hero-focus-photo__caption`](index.html:968).
- Follow-up: normalized Role Pathways customer CTA styling by removing `btn--primary` from `Open Reports` so it matches surrounding non-highlighted action buttons in [`#pathways`](index.html:1073).
- Follow-up: merged former public/secure access sales messaging into [`#pathways`](index.html:1051) and removed standalone `#access` section plus footer `#access` anchor for a tighter single sales narrative.
- Follow-up: added custom-work capability message in owner-note proof points: custom frame sizes can be welded when not in stock in [`#overview`](index.html:1026).
- Follow-up: renamed trust-story heading from `Owner note` to `Who we are` and updated intro line to team-based wording in [`#overview`](index.html:1027).
- Follow-up: added phone number to top hero caption and collapsed pathways access bullets into an expandable `details` block in [`#pathways`](index.html:1051) for a cleaner scan-first layout.

### Safety/compatibility impact
- Public routes and report links remain intact.
- No worker, KV, UID, or R2 logic changed.
- Static homepage and contact-form payload shape update only.

## 2026-04-17 — Hide Admin report toggle in demo sandbox viewer

### Scope
- [`Workers/reports-worker.js`](Workers/reports-worker.js)

### Why this was done
- Sandbox customers should not be shown an explicit "Admin report" option in the report viewer UI.

### Implemented changes
- Updated report meta line rendering in [`GET /reports/...`](Workers/reports-worker.js:3034) so sandbox mode always labels viewer as `Customer report`.
- Updated viewer toggle rendering in [`viewerToggleHtml`](Workers/reports-worker.js:3065) so admin/customer toggle buttons are not rendered when sandbox mode is active.

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` behavior: unchanged.
- KV key naming and R2 object path assumptions: unchanged.
- Change is presentation-layer only for sandbox viewer controls.

## 2026-04-17 — Sandbox multi-business portal scope in demo sessions

### Scope
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Demo users needed to switch/manage more than one sandbox business inside one portal session.
- Previous sandbox fast-login/session bootstrap paths only scoped `allowedBusinesses` to a single preferred business.

### Implemented changes
- Added sandbox business discovery helper [`listSandboxBusinessCodes()`](Workers/castle-portal.js:96) to enumerate `bizcfg:*` records with `sandbox_demo === true`.
- Updated sandbox auto-bootstrap path in [`GET /portal`](Workers/castle-portal.js:915) to include all sandbox businesses in session `allowedBusinesses` and `accessByBusiness`.
- Updated sandbox auth-start quick-login path in [`POST /api/portal/auth/start`](Workers/castle-portal.js:1917) to include all sandbox businesses in session `allowedBusinesses` and `accessByBusiness`.
- Portal business switcher remains fed by session scope, so multi-business sandbox options now appear without changing UID routing semantics.

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` behavior: unchanged.
- KV/R2 key/path assumptions: unchanged.
- Change is constrained to sandbox session scoping and portal UX.

## 2026-04-17 — Admin tools door rename (local alias)

### Scope
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Portal managers requested a door rename control alongside business/building rename in Admin tools.
- Desired behavior is customer-specific display customization without changing UID identity or shared server records.

### Implemented changes
- Added Admin tools UI controls for door rename:
  - `Search Door` input with datalist suggestions
  - `Door display name` input
  - `Save Door name` action
- Extended local alias model to include `doors` map in existing local state.
- Added local alias resolver for door labels and applied it during dashboard shaping so Overview table reflects renamed door labels.
- Added manager-side wiring to:
  - populate selectable door targets from current dashboard doors
  - prefill current door display label when selecting a target
  - persist door alias keys (doorId / doorSlug / normalized variants)
  - refresh Overview + target suggestions after saves
- Updated reset flow so `Reset changes` also clears door alias inputs/state for the current business/user browser context.

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` behavior: unchanged.
- KV key naming and R2 paths: unchanged.
- Door rename is local alias UX only; no historical event/PDF mutation.

## 2026-04-17 — Hide signed-in manager email in Default repair destination field

### Scope
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Manager requested that the Default repair destination input not visibly echo their own signed-in email.

### Implemented changes
- Updated manager settings hydration in portal client script to detect when `defaultTo` matches signed-in email and hide it from the visible input.
- Added in-memory `hiddenRepairDefaultTo` handling so existing routing is preserved even when the field is visually blank/hidden.
- Save flow now uses:
  - typed value when provided
  - otherwise hidden preserved default
  - preserving previous behavior while avoiding UI email exposure.
- Placeholder updates to indicate hidden state (`(hidden — your email)`) when applicable.

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` behavior: unchanged.
- CTA routing persistence keys and behavior: unchanged.

### Follow-up fix (same day)
- Hardened `Default repair destination` input against browser autofill that can re-insert viewer email after script hydration.
- Added input attributes (`autocomplete="off"`, distinct name, lpignore) and delayed/email-scrub rechecks on focus/blur/timers in [`Workers/castle-portal.js`](Workers/castle-portal.js).

## 2026-04-17 — Portal per-customer local alias names (business/building)

### Scope
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Customer-specific naming preferences were being overwritten by shared business/building names.
- Needed each signed-in portal customer to keep their own preferred display names without changing shared server-side naming.

### Implemented changes
- Added browser-local alias state in portal UI keyed by signed-in email + business code.
- Added local alias helpers in [`GET /portal` client script](Workers/castle-portal.js):
  - alias storage key generation
  - load/save aliases in `localStorage`
  - business/building alias resolvers
- Updated dashboard data shaping so Overview uses local building aliases while preserving server records.
- Updated business selector + header label to use local business alias when present.
- Updated Admin tools rename actions to save locally for the current signed-in customer/session browser context instead of writing shared KV display names.
- Kept existing portal API endpoints and server-side naming untouched for compatibility.

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` behavior: unchanged.
- KV key patterns and R2 paths: unchanged by this update.
- Name customization is now per-customer local UI state, avoiding cross-customer rename collisions.

### Follow-up fix (same day)
- Fixed local building alias key matching in [`Workers/castle-portal.js`](Workers/castle-portal.js) so aliases persist when moving between `Admin tools` and `Overview`.
- Added normalized alias-key lookups/writes for `buildingCode` and prior selected display-name fallback to avoid revert behavior caused by mixed key shapes.
- Added `Reset changes` UI action in [`GET /portal`](Workers/castle-portal.js) above logout to clear per-customer local alias storage for the active business and refresh Overview/Admin tools to server/default names.

## 2026-04-16 — Portal manager section moved behind an “Admin tools” tab

### Scope
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Manager-only controls were visible as a full section under the dashboard.
- Needed clearer UX separation between day-to-day report viewing and manager actions.

### Implemented changes
- Added portal tab controls in [`GET /portal`](Workers/castle-portal.js:1052) for:
  - `Overview`
  - `Admin tools`
- Wrapped KPI/filter/table content in an overview pane and added tab state toggling via [`setActiveTab()`](Workers/castle-portal.js:1179).
- Updated manager block behavior so it remains manager-only and is shown under the new Admin tools tab instead of always visible.
- Adjusted tab placement so **Admin tools** now renders directly beside the business selector in the top control row.
- Fixed tab pane visibility gating so manager controls reliably render when the `Admin tools` tab is selected (added explicit manager-enabled state in tab switch logic).

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` behavior: unchanged.
- KV key naming and write behavior: unchanged.
- Historical inspection/PDF behavior: unchanged.

## 2026-04-16 — Portal manager rename controls + last-inspection date/time rendering

### Scope
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Portal managers needed customer-side controls to rename business and building display names without changing UID identity.
- Portal last-inspection display needed date + time output, including compatibility for mixed timestamp formats.

### Implemented changes
- Added manager UI controls in [`GET /portal`](Workers/castle-portal.js) for:
  - business display name updates
  - building display name updates
- Added new portal manager APIs in [`Workers/castle-portal.js`](Workers/castle-portal.js):
  - `GET /api/portal/settings/display`
  - `POST /api/portal/settings/display/business`
  - `POST /api/portal/settings/display/building`
- Kept writes compatibility-safe by using existing KV namespaces and key patterns:
  - business display name writes to `bizcfg:<businessCode>` in `ENROLL_TOKENS`
  - building display name writes to `bldcfg:<businessCode>:<buildingCode>` in `REPORTS_KV`
- Added format + parsing improvements for inspection timestamps in portal dashboard processing:
  - introduced robust parse helper for legacy `MM-DD-YYYY h:mm A` and ISO-like values
  - switched dashboard door sorting/metrics to timestamp-based comparison instead of raw string sort
  - updated table display to render date and time together with fallback behavior

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` route behavior: unchanged.
- Existing KV key naming patterns preserved (`bizcfg:*`, `bldcfg:*`, `door:*`, `doorIndex:*`).
- Historical PDFs and event history: unchanged.

## 2026-04-16 — Portal demo login UX unblock + temporary auth tracing logs

### Scope
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Demo portal login still blocked empty input with a hard `Email is required.` client check.
- Needed user-requested demo copy/behavior: login screen should allow “email or anything” and proceed into demo.
- Needed short-term runtime traces to verify whether sandbox or non-sandbox auth branches are reached in production requests.

### Implemented changes
- Updated [`GET /portal/login`](Workers/castle-portal.js) demo UX when `biz` is sandbox-enabled:
  - helper text now says “type in an email or anything”
  - input uses text mode and sandbox-specific placeholder
  - submit button label switches to `Login`
- Updated login client script in [`GET /portal/login`](Workers/castle-portal.js):
  - removed empty-input block for sandbox mode
  - keeps strict empty-email block for non-sandbox mode
  - falls back to `demo@castledoorict.com` when sandbox input is blank
- Added temporary debug logs in [`Workers/castle-portal.js`](Workers/castle-portal.js) for:
  - login page sandbox detection
  - `/portal` access check + magic bootstrap + sandbox auto-bootstrap + login redirect branches
  - `/api/portal/auth/start` request branch selection and invalid-email rejection path

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` behavior: unchanged.
- KV key naming and R2 object path assumptions: unchanged.
- Non-sandbox portal auth constraints remain in place; permissive input handling is sandbox-branch only.

## 2026-04-16 — Demo entrypoint alignment + sandbox instant portal login

### Scope
- [`index.html`](index.html)
- [`Workers/castle-portal.js`](Workers/castle-portal.js)

### Why this was done
- Homepage demo links were still pointing to static/example pages instead of the live sandbox demo business.
- Demo portal experience needed frictionless sign-in so prospects can enter with any email when sandbox mode is enabled.

### Implemented changes

#### 1) Homepage demo/report links now target live sandbox routes
- Repointed report/demo CTAs in [`index.html`](index.html) to:
  - `https://r.castledoorict.com/reports/p0bwkg/09in5f/co1?scope=all`
- Repointed portal demo/example CTAs in [`index.html`](index.html) to:
  - `https://castledoorict.com/portal?biz=p0bwkg`

#### 2) Sandbox instant login in portal worker
- Added sandbox-aware auth shortcut in [`POST /api/portal/auth/start`](Workers/castle-portal.js):
  - when requested `businessCode` is sandbox-enabled (`bizcfg:<biz>.sandbox_demo === true`), worker creates a portal session directly
  - returns `portalUrl` for immediate redirect
  - bypasses member-invite/email-link dependency for demo businesses only
- Updated [`GET /portal/login`](Workers/castle-portal.js) UI messaging and client payload to include `businessCode` and auto-redirect when `portalUrl` is returned.
- Updated unauthenticated portal redirect behavior to preserve selected demo business by routing to `/portal/login?biz=...`.
- Added direct sandbox session bootstrap on `GET /portal?biz=...` when the selected business is sandbox-enabled and no session is present, so demo visitors can land directly in portal without touching a login form.
- Hardened access/session guards to allow sandbox sessions without requiring existing `portalMember:<biz>:<email>` records in sandbox mode while preserving non-sandbox behavior.

### Verification
- Syntax check passed:
  - `node --check Workers/castle-portal.js`

### Safety/compatibility impact
- UID identity model: unchanged.
- `/r/:uid` identity and canonical mapping: unchanged.
- Historical report/PDF access: unchanged.
- KV key naming and R2 object path assumptions: unchanged.
- Non-sandbox portal authentication behavior remains intact; instant-login behavior is constrained to sandbox-enabled businesses.

---

## 2026-04-16 — Demo sandbox mode for reports + portal with admin business toggle

### Scope
- [`Workers/reports-worker.js`](Workers/reports-worker.js)
- [`Workers/castle-portal.js`](Workers/castle-portal.js)
- [`Workers/door-admin.js`](Workers/door-admin.js)

### Why this was done
- Sales/demo workflows needed fully interactive behavior without permanent side effects.
- Demo businesses should behave like production for reads, while all mutating actions are simulated.
- Admin needed an explicit control to enable/disable sandbox mode per business.

### Implemented changes

#### 1) Business-level sandbox flag
- Added business config flag `sandbox_demo` under existing `bizcfg:<businessCode>` records.
- Reports and portal workers now detect sandbox status from business config.

#### 2) `/r/:uid` auto-enters demo sandbox for sandboxed businesses
- Updated QR short-route redirect behavior in reports worker so when UID resolves to a sandbox business, redirect includes `?demo=1`.
- UID lookup and canonical routing remain unchanged; behavior is additive.

#### 3) Reports worker sandbox behavior
- Added sandbox-aware CTA handling for [`POST /api/cta-request`](Workers/reports-worker.js): returns simulated success and skips KV write/email send in sandbox mode.
- Added sandbox-aware customer comment handling for [`POST /api/customer-comment`](Workers/reports-worker.js): returns simulated approved comment payload and skips KV write in sandbox mode.
- Added report-view demo banner and metadata mode indicator.
- Added session-local browser comment simulation (session storage) so comments appear functional per visitor session and clear when session ends.
- Added client-side simulated CTA confirmation IDs in sandbox mode.

#### 4) Portal worker sandbox behavior
- Added sandbox-aware CTA handling for [`POST /api/portal/cta-submit`](Workers/castle-portal.js) with simulated success/no write/no email.
- Added sandbox simulation for mutating portal manager endpoints:
  - [`POST /api/portal/settings/repair`](Workers/castle-portal.js)
  - [`POST /api/portal/members/invite`](Workers/castle-portal.js)
  - [`POST /api/portal/members/comment-permission`](Workers/castle-portal.js)
  - [`POST /api/portal/members/remove`](Workers/castle-portal.js)
- Added portal demo banner and sandbox response markers in UI messaging.
- Included sandbox status in portal read APIs (`/api/portal/me`, `/api/portal/dashboard`).

#### 5) Admin worker toggle for sandbox mode
- Extended Security tab UI with “Demo sandbox (no permanent writes)” checkbox.
- Updated [`POST /admin/security-mode`](Workers/door-admin.js) to persist `sandbox_demo` and return it in response.
- Business row normalization now includes sandbox flag so UI reflects current state.

### Verification
- Syntax checks passed:
  - `node --check Workers/reports-worker.js`
  - `node --check Workers/castle-portal.js`
  - `node --check Workers/door-admin.js`

### Safety/compatibility impact
- UID identity model: unchanged.
- QR permanence: unchanged; no UID format or QR mapping key scheme changes.
- `/r/:uid` resolution: preserved; only appends demo query for sandbox businesses.
- Historical inspection events/PDF retention: unchanged.
- KV key naming patterns and R2 object path assumptions: unchanged.
- Mutations for sandbox businesses are intentionally simulated, preventing production side effects from demo interactions.

---

## 2026-04-06 — Building normalization + conditional Buildings selector visibility

### Scope
- [`Workers/reports-worker.js`](Workers/reports-worker.js)

### Why this was done
- Building values from uploads could appear as blank, `0`, `null`, or typo variants of "main", creating inconsistent display/grouping.
- The Buildings selector needed to be hidden when only one building exists, and shown only when more than one building exists.

### Implemented changes
- Added canonical building normalizer [`normalizeBuildingName`](Workers/reports-worker.js:930) to map blank/`0`/`null`/`undefined` and common main-like typo variants to `Main`.
- Applied normalization in upload parse and write paths so new records consistently store and code-map main-like building values:
  - [`parseUploadFieldsFromBaseName()`](Workers/reports-worker.js:979)
  - main upload normalization near [`building = normalizeBuildingName(building)`](Workers/reports-worker.js:1650)
  - building-code assignment via [`getOrCreateBuildingCode()`](Workers/reports-worker.js:966)
  - admin upload path normalization near [`Workers/reports-worker.js:2003`](Workers/reports-worker.js:2003)
- Updated report display metadata line to render normalized building value via [`normalizedMetaBuilding`](Workers/reports-worker.js:2928).
- Updated building sidebar fallback naming to use normalized uploaded building values at [`Workers/reports-worker.js:3027`](Workers/reports-worker.js:3027).
- Updated sidebar template so Buildings section renders only when `buildingSummaries.length > 1` at [`Workers/reports-worker.js:4278`](Workers/reports-worker.js:4278).

### Safety/compatibility impact
- UID identity model: unchanged.
- QR permanence (`/r/:uid`): unchanged.
- Historical report/PDF access paths: unchanged.
- KV key pattern names: unchanged; this change normalizes input values before existing key usage.

---

## 2026-04-03 — Worker reliability + admin visibility fixes

### Scope
- [`Workers/reports-worker.js`](Workers/reports-worker.js)
- [`Workers/door-admin.js`](Workers/door-admin.js)

### Why this was done
- Legacy typed links (for example `/reports/<uid>`) could render a single-door view without full sidebar context.
- Admin-host report opens could bounce through auth/host routing inconsistently.
- Businesses with live report data could be missing from Admin Business tab.
- Upload success could return before all critical KV pointers/config were persisted.

### Implemented changes

#### 1) Legacy link canonical recovery in reports worker
- Added stronger legacy UID candidate resolution for `/reports/:uid`:
  - exact token
  - sanitized token
  - lower/upper variants
- Added fallback recovery from door records when `doorIndex:<uid>` is missing.
- Added canonical redirect recovery to `/reports/:businessCode/:buildingCode/:doorSlug` when mapping is recovered.
- Added fallback object/history discovery across UID variants to avoid false “No reports yet”.

#### 2) Upload write consistency hardening
- Changed critical upload indexing writes from background `waitUntil(...)` to awaited `Promise.all(...)` so successful upload now guarantees:
  - `door:<businessCode>:<buildingCode>:<doorSlug>`
  - `door:<uid>`
  - `doorIndex:<uid>`
  - `bizcfg:<businessCode>`

#### 3) Admin report-host/session compatibility
- Added reports-owned path redirects on admin worker so report/viewer paths are forwarded to reports origin.
- Updated admin auth cookie domain strategy to support cross-subdomain admin/report flows (configurable with `ADMIN_COOKIE_DOMAIN`, with castledoor domain inference fallback).

#### 4) Admin diagnostics + business visibility fixes
- Added diagnostic endpoint:
  - `GET /admin/diag/business-code?code=<businessCode>`
  - Reports whether `bizcfg:<code>` exists and samples door/index consistency.
- Updated `GET /admin/businesses` to rebuild live list (no stale snapshot return path).
- Expanded business discovery to merge report-discovered business codes from `REPORTS_KV` `door:*` keys even if `bizcfg:*` is missing.

### Operational outcome observed
- Legacy and short UID routes started resolving toward canonical report routes more reliably.
- Admin Business tab began showing previously missing businesses, enabling admin tools for those records.

### Compatibility + safety notes
- UID identity model preserved.
- No QR reprint requirement introduced.
- No historical PDF deletion.
- No rewrite of inspection event history.
- Changes are additive/recovery-oriented compatibility fixes.

---

## 2026-04-03 — Documentation source-of-truth normalization

### Scope
- [`AGENT.md`](AGENT.md)
- [`.roo/rules/rules.md`](.roo/rules/rules.md)

### Why this was done
- The repository needed a clearer, enforceable source-of-truth split between operational guidance and hard invariants.
- Route ownership language needed to be tightened against live worker code to reduce ambiguity before future edits.
- [`.roo/rules/rules.md`](.roo/rules/rules.md) needed normalization to plain Markdown for consistent tooling/readability.

### Implemented changes
- Updated [`AGENT.md`](AGENT.md) to state precedence explicitly: [`.roo/rules/rules.md`](.roo/rules/rules.md) invariants win on conflict.
- Expanded [`AGENT.md`](AGENT.md) with concrete worker-route ownership evidence derived from:
  - [`Workers/reports-worker.js`](Workers/reports-worker.js)
  - [`Workers/castle-portal.js`](Workers/castle-portal.js)
  - [`Workers/door-admin.js`](Workers/door-admin.js)
- Added/clarified in [`AGENT.md`](AGENT.md):
  - Core bindings and key-pattern expectations
  - Non-negotiable invariants
  - Change-safety checklist for route/KV/R2-sensitive work
  - Explicit note that production route ownership is determined by Cloudflare route bindings.
- Normalized [`.roo/rules/rules.md`](.roo/rules/rules.md) from wrapper-style content to plain Markdown content without changing its policy intent.

### Safety/compatibility impact
- UID identity model: unchanged.
- QR permanence: unchanged; no QR reprint requirement introduced.
- Inspection history integrity: unchanged; no history mutation logic added.
- Historical PDF retention/access: unchanged; no R2 object/path behavior changed.
- Route/KV/R2 runtime assumptions: no runtime behavior change; documentation now explicitly records assumptions and ownership constraints.

---

## 2026-04-03 — Prompt Markdown formatting maintenance (non-runtime)

### Scope
- [`prompts.md`](prompts.md) in the active local workspace (`c:/CID`)
- [`plans/change-log.md`](plans/change-log.md)

### Why this was done
- The prompt document was difficult to read due to inconsistent Markdown structure.
- A formatting-only pass was requested to improve readability while preserving existing information.

### Implemented changes
- Applied Markdown-structure cleanup to [`prompts.md`](prompts.md):
  - normalized top-level title/subtitle headings
  - improved section heading markers for numbered sections
  - normalized list formatting where structure was malformed
- No worker runtime code paths were edited in this update.

### Safety/compatibility impact
- UID/QR permanence: unchanged.
- Inspection history integrity: unchanged.
- Historical PDF retention: unchanged.
- Routes: no changes to `/r/:uid`, `/reports/...`, `/upload`, `/file/...`, or `/pdfviewer/...` behavior.
- KV/R2 assumptions: no key naming changes, no binding changes, no R2 object path changes.

---

## 2026-04-03 — Homepage CTA cleanup + demo-path UX updates

### Scope
- [`index.html`](index.html)
- [`sample-report.html`](sample-report.html)
- [`portal-sample.html`](portal-sample.html)

### Why this was done
- Header CTAs were visually crowded and included duplicate quote/navigation signals.
- Requested UX changes required clearer top-of-page actions and stronger demo discoverability.
- Some demo-target links produced production 404 behavior when using `.html` paths.
- Contact hours copy needed production-ready wording.

### Implemented changes
- Header/navigation and spacing refinements in [`index.html`](index.html):
  - Removed crowded top nav links and consolidated to action buttons.
  - Kept a single primary quote CTA in header.
  - Tightened header/hero spacing and responsive button visibility behavior.
- Re-themed homepage palette in [`index.html`](index.html) to darker navy/charcoal with teal accents (CSS-variable and key accent updates).
- Updated contact hours line in [`index.html`](index.html) to: Mon–Fri 7:30 AM–4:30 PM with later availability by notice.
- Added “See It in Action” section in [`index.html`](index.html) with demo CTAs and hero jump link to `#demo`.
- Added demo pages:
  - [`sample-report.html`](sample-report.html)
  - [`portal-sample.html`](portal-sample.html)
- Updated CTA destinations to reduce dead-link risk:
  - Real secure sign-in paths use `https://castledoorict.com/portal/login`.
  - Report demo links use `/sample-report`.
  - Role-pathways example portal link uses `/portal-sample`.
- Auto-populated demo email field in [`portal-sample.html`](portal-sample.html) with `Demo@YourDomain.com` for immediate click-through behavior.

### Safety/compatibility impact
- UID identity: unchanged.
- QR permanence (`/r/:uid`): unchanged; no QR route logic modified.
- Inspection history integrity: unchanged; no event mutation paths touched.
- Historical PDF retention/access: unchanged; no `/file/...` or `/pdfviewer/...` runtime logic edited.
- KV/R2 assumptions: unchanged; no KV key pattern changes and no R2 object path changes.
- Route impact callout: this update changed homepage/demo hyperlink targets only (front-end CTA destinations), not Worker routing logic or storage behavior.

---

## 2026-04-03 — Quote-assistant transcript forwarding + phone opt-out propagation

### Scope
- [`index.html`](index.html)
- [`functions/api/quote-request.js`](functions/api/quote-request.js)

### Why this was done
- Quote submissions from assistant mode needed to include full chat transcript with the quote details for rep visibility.
- Assistant flow needed explicit phone opt-out propagation so submissions do not force a phone number when customer skips it.
- Outbound quote emails needed to preserve and display customer-provided opening dimensions from assistant intake payload.

### Implemented changes
- Updated assistant UI payload builder in [`index.html`](index.html) to:
  - capture/store turn-by-turn assistant transcript (role, text, timestamp)
  - include `chatTranscript` in `/api/quote-request` payload
  - include `phoneOptOut` in payload
  - include size fields (`sizeWidthIn`, `sizeHeightIn`, `doorHeightIn`, `sizeAssumed`) in payload
- Updated quote email endpoint in [`functions/api/quote-request.js`](functions/api/quote-request.js) to:
  - accept/sanitize `chatTranscript`, `phoneOptOut`, and assistant size fields
  - render chat transcript in both HTML and plain-text outbound email
  - render phone as “customer opted out” when applicable
  - include opening size details in guided/custom email sections

### Safety/compatibility impact
- UID identity model: unchanged.
- QR permanence (`/r/:uid`): unchanged; no QR or report-route behavior modified.
- Inspection history integrity: unchanged; no history mutation paths changed.
- Historical PDF retention: unchanged; no PDF storage/read path changes.
- KV/R2 assumptions: unchanged; no key naming, binding, or object path changes.
- Route impact callout: no new routes introduced; existing [`/api/quote-request`](functions/api/quote-request.js) behavior was extended for payload/email content only.

---

## 2026-04-03 — Chatbot conversational hardening + frame-depth authority (backfill of last in-chat code edits)

### Scope
- [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js)
- [`functions/api/tests/test-chatbot.js`](functions/api/tests/test-chatbot.js)
- [`functions/api/tests/chatbot-behavior-spec.md`](functions/api/tests/chatbot-behavior-spec.md)
- [`functions/api/tests/testprompt.md`](functions/api/tests/testprompt.md) (renamed during session to behavior spec)

### Why this was done
- Chatbot responses were still too form-like/chatty in some turns and did not adapt cleanly to limited-information replies.
- User-provided frame depth (for example `5-3/4 frame`) was not always treated as authoritative, causing unnecessary wall-thickness loops.
- Test artifact folder contained a prototype endpoint copy instead of executable data-validation checks.

### Implemented changes
- Extended conversation strategy in [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js):
  - added turn-style handling for pushback/correction/uncertain/clarification/recommendation/style-feedback
  - tightened follow-up composition to be shorter and more contextual
  - updated OpenAI system instructions to prefer concise, adaptive follow-up behavior
- Added deterministic frame-depth capture in [`functions/api/chatbot-quote.js`](functions/api/chatbot-quote.js):
  - parses phrases such as `5-3/4 frame`, `frame depth 5-3/4`, and decimal variants
  - treats captured `frameDepth` as authoritative input and avoids forcing wall-thickness derivation
  - suppresses wall-thickness unknown output when frame depth is already present
- Replaced [`functions/api/tests/test-chatbot.js`](functions/api/tests/test-chatbot.js) with executable validation checks for reference fixtures (`reference-guide (1).json` / `reference-guide (1).yaml`) covering structure, manufacturer coverage, hinge buckets, undercut exceptions, and drywall chart sanity.
- Renamed prompt scratch doc from [`functions/api/tests/testprompt.md`](functions/api/tests/testprompt.md) to [`functions/api/tests/chatbot-behavior-spec.md`](functions/api/tests/chatbot-behavior-spec.md) for clearer intent.

### Safety/compatibility impact
- UID identity model: unchanged.
- QR permanence (`/r/:uid`): unchanged.
- Inspection history integrity: unchanged.
- Historical PDF retention/access: unchanged.
- KV/R2 assumptions: unchanged; no binding, key-pattern, or object-path changes.
- Route impact callout: behavior changed only for existing chatbot route [`POST /api/chatbot-quote`](functions/api/chatbot-quote.js); no new routes were introduced.

---

## 2026-04-03 — Historical backfill from archived task transcripts in [`changelog update/`](changelog%20update)

### Scope
- Updated changelog record only:
  - [`plans/change-log.md`](plans/change-log.md)
- Historical source artifacts reviewed:
  - [`changelog update/roo_task_mar-11-2026_2-27-21-pm.md`](changelog%20update/roo_task_mar-11-2026_2-27-21-pm.md)
  - [`changelog update/roo_task_mar-11-2026_4-03-44-pm.md`](changelog%20update/roo_task_mar-11-2026_4-03-44-pm.md)
  - [`changelog update/roo_task_mar-12-2026_2-08-42-pm.md`](changelog%20update/roo_task_mar-12-2026_2-08-42-pm.md)
  - [`changelog update/roo_task_mar-12-2026_2-43-19-pm.md`](changelog%20update/roo_task_mar-12-2026_2-43-19-pm.md)
  - [`changelog update/roo_task_mar-12-2026_3-25-49-pm.md`](changelog%20update/roo_task_mar-12-2026_3-25-49-pm.md)
  - [`changelog update/roo_task_mar-12-2026_8-48-03-am.md`](changelog%20update/roo_task_mar-12-2026_8-48-03-am.md)
  - [`changelog update/roo_task_mar-12-2026_9-45-06-am.md`](changelog%20update/roo_task_mar-12-2026_9-45-06-am.md)
  - [`changelog update/roo_task_mar-12-2026_11-51-57-am.md`](changelog%20update/roo_task_mar-12-2026_11-51-57-am.md)
  - [`changelog update/roo_task_mar-12-2026_12-32-53-pm.md`](changelog%20update/roo_task_mar-12-2026_12-32-53-pm.md)
  - [`changelog update/roo_task_mar-12-2026_12-37-01-pm.md`](changelog%20update/roo_task_mar-12-2026_12-37-01-pm.md)
  - [`changelog update/roo_task_mar-13-2026_1-11-18-pm.md`](changelog%20update/roo_task_mar-13-2026_1-11-18-pm.md)
  - [`changelog update/roo_task_mar-13-2026_1-45-28-pm.md`](changelog%20update/roo_task_mar-13-2026_1-45-28-pm.md)
  - [`changelog update/roo_task_mar-13-2026_3-18-18-pm.md`](changelog%20update/roo_task_mar-13-2026_3-18-18-pm.md)
  - [`changelog update/roo_task_mar-13-2026_8-01-39-am.md`](changelog%20update/roo_task_mar-13-2026_8-01-39-am.md)
  - [`changelog update/roo_task_mar-13-2026_9-25-53-am.md`](changelog%20update/roo_task_mar-13-2026_9-25-53-am.md)
  - [`changelog update/roo_task_mar-13-2026_10-55-43-am.md`](changelog%20update/roo_task_mar-13-2026_10-55-43-am.md)
  - [`changelog update/roo_task_mar-17-2026_4-00-19-pm.md`](changelog%20update/roo_task_mar-17-2026_4-00-19-pm.md)
  - [`changelog update/roo_task_mar-17-2026_9-13-43-am.md`](changelog%20update/roo_task_mar-17-2026_9-13-43-am.md)
  - [`changelog update/roo_task_mar-17-2026_12-16-11-pm.md`](changelog%20update/roo_task_mar-17-2026_12-16-11-pm.md)
  - [`changelog update/roo_task_mar-17-2026_12-47-50-pm.md`](changelog%20update/roo_task_mar-17-2026_12-47-50-pm.md)
  - [`changelog update/roo_task_mar-23-2026_1-51-17-pm.md`](changelog%20update/roo_task_mar-23-2026_1-51-17-pm.md)
  - [`changelog update/roo_task_mar-23-2026_3-18-25-pm.md`](changelog%20update/roo_task_mar-23-2026_3-18-25-pm.md)
  - [`changelog update/roo_task_mar-23-2026_12-49-16-pm.md`](changelog%20update/roo_task_mar-23-2026_12-49-16-pm.md)
  - [`changelog update/roo_task_mar-24-2026_2-10-41-pm.md`](changelog%20update/roo_task_mar-24-2026_2-10-41-pm.md)
  - [`changelog update/roo_task_mar-24-2026_4-09-02-pm.md`](changelog%20update/roo_task_mar-24-2026_4-09-02-pm.md)
  - [`changelog update/roo_task_mar-26-2026_2-49-04-pm.md`](changelog%20update/roo_task_mar-26-2026_2-49-04-pm.md)

### Why this was done
- Historical implementation notes existed across many archived task files and needed to be reflected in the durable production changelog.
- The goal was to capture factual, append-only history of what was changed, with explicit safety framing for UID identity and report evidence integrity.

### Implemented changes
- Added a consolidated historical backfill entry based on archived `apply_patch` and completion records.
- Consolidated historically touched files from those transcripts (code + docs + assets):
  - [`Workers/reports-worker.js`](Workers/reports-worker.js)
  - [`Workers/door-admin.js`](Workers/door-admin.js)
  - [`Workers/castle-portal.js`](Workers/castle-portal.js)
  - [`Workers/shared/helpers.js`](Workers/shared/helpers.js)
  - [`index.html`](index.html)
  - [`functions/api/quote-request.js`](functions/api/quote-request.js)
  - [`functions/api/contact-request.js`](functions/api/contact-request.js)
  - [`assets/vision-kit-reference.svg`](assets/vision-kit-reference.svg)
  - [`scripts/qbo-subject-autofill.user.js`](scripts/qbo-subject-autofill.user.js)
  - [`plans/portal-routing-deploy-checklist.md`](plans/portal-routing-deploy-checklist.md)
  - [`plans/pass1-cleanup-roadmap.md`](plans/pass1-cleanup-roadmap.md)
  - [`externalmemory.md`](externalmemory.md)
  - [`FFREPLACE/app/main.js`](FFREPLACE/app/main.js)
  - Temporary artifact lifecycle recorded in archive: add/delete of [`plans/portal-get-block-replacement.txt`](plans/portal-get-block-replacement.txt)
- Noted transcript files with no detected code patch/write operations:
  - [`changelog update/roo_task_mar-12-2026_8-48-03-am.md`](changelog%20update/roo_task_mar-12-2026_8-48-03-am.md)
  - [`changelog update/roo_task_mar-13-2026_10-55-43-am.md`](changelog%20update/roo_task_mar-13-2026_10-55-43-am.md)

### Safety/compatibility impact
- UID identity model: unchanged by this backfill action; this entry is documentation-only in [`plans/change-log.md`](plans/change-log.md).
- QR permanence: unchanged; no change to QR format or `/r/:uid` contract in this update.
- Inspection history integrity: unchanged by this backfill write.
- Historical PDF retention/access: unchanged by this backfill write.
- Route/KV/R2 assumptions callout: this backfill references prior historical worker changes that touched route behavior and KV interaction patterns, but **this specific thread update does not modify runtime routes, KV key naming, bindings, or R2 object paths**.

---

## 2026-04-03 — Per-chat extraction of archived transcript changes

### Scope
- Changelog extraction/update only:
  - [`plans/change-log.md`](plans/change-log.md)
- Source transcripts reviewed individually:
  - [`changelog update/roo_task_mar-11-2026_2-27-21-pm.md`](changelog%20update/roo_task_mar-11-2026_2-27-21-pm.md)
  - [`changelog update/roo_task_mar-11-2026_4-03-44-pm.md`](changelog%20update/roo_task_mar-11-2026_4-03-44-pm.md)
  - [`changelog update/roo_task_mar-12-2026_2-08-42-pm.md`](changelog%20update/roo_task_mar-12-2026_2-08-42-pm.md)
  - [`changelog update/roo_task_mar-12-2026_2-43-19-pm.md`](changelog%20update/roo_task_mar-12-2026_2-43-19-pm.md)
  - [`changelog update/roo_task_mar-12-2026_3-25-49-pm.md`](changelog%20update/roo_task_mar-12-2026_3-25-49-pm.md)
  - [`changelog update/roo_task_mar-12-2026_8-48-03-am.md`](changelog%20update/roo_task_mar-12-2026_8-48-03-am.md)
  - [`changelog update/roo_task_mar-12-2026_9-45-06-am.md`](changelog%20update/roo_task_mar-12-2026_9-45-06-am.md)
  - [`changelog update/roo_task_mar-12-2026_11-51-57-am.md`](changelog%20update/roo_task_mar-12-2026_11-51-57-am.md)
  - [`changelog update/roo_task_mar-12-2026_12-32-53-pm.md`](changelog%20update/roo_task_mar-12-2026_12-32-53-pm.md)
  - [`changelog update/roo_task_mar-12-2026_12-37-01-pm.md`](changelog%20update/roo_task_mar-12-2026_12-37-01-pm.md)
  - [`changelog update/roo_task_mar-13-2026_1-11-18-pm.md`](changelog%20update/roo_task_mar-13-2026_1-11-18-pm.md)
  - [`changelog update/roo_task_mar-13-2026_1-45-28-pm.md`](changelog%20update/roo_task_mar-13-2026_1-45-28-pm.md)
  - [`changelog update/roo_task_mar-13-2026_3-18-18-pm.md`](changelog%20update/roo_task_mar-13-2026_3-18-18-pm.md)
  - [`changelog update/roo_task_mar-13-2026_8-01-39-am.md`](changelog%20update/roo_task_mar-13-2026_8-01-39-am.md)
  - [`changelog update/roo_task_mar-13-2026_9-25-53-am.md`](changelog%20update/roo_task_mar-13-2026_9-25-53-am.md)
  - [`changelog update/roo_task_mar-13-2026_10-55-43-am.md`](changelog%20update/roo_task_mar-13-2026_10-55-43-am.md)
  - [`changelog update/roo_task_mar-17-2026_4-00-19-pm.md`](changelog%20update/roo_task_mar-17-2026_4-00-19-pm.md)
  - [`changelog update/roo_task_mar-17-2026_9-13-43-am.md`](changelog%20update/roo_task_mar-17-2026_9-13-43-am.md)
  - [`changelog update/roo_task_mar-17-2026_12-16-11-pm.md`](changelog%20update/roo_task_mar-17-2026_12-16-11-pm.md)
  - [`changelog update/roo_task_mar-17-2026_12-47-50-pm.md`](changelog%20update/roo_task_mar-17-2026_12-47-50-pm.md)
  - [`changelog update/roo_task_mar-23-2026_1-51-17-pm.md`](changelog%20update/roo_task_mar-23-2026_1-51-17-pm.md)
  - [`changelog update/roo_task_mar-23-2026_3-18-25-pm.md`](changelog%20update/roo_task_mar-23-2026_3-18-25-pm.md)
  - [`changelog update/roo_task_mar-23-2026_12-49-16-pm.md`](changelog%20update/roo_task_mar-23-2026_12-49-16-pm.md)
  - [`changelog update/roo_task_mar-24-2026_2-10-41-pm.md`](changelog%20update/roo_task_mar-24-2026_2-10-41-pm.md)
  - [`changelog update/roo_task_mar-24-2026_4-09-02-pm.md`](changelog%20update/roo_task_mar-24-2026_4-09-02-pm.md)
  - [`changelog update/roo_task_mar-26-2026_2-49-04-pm.md`](changelog%20update/roo_task_mar-26-2026_2-49-04-pm.md)

### Why this was done
- Requested extraction was per-chat, not only consolidated.
- Prior summary was broadened; this append captures chat-by-chat factual deltas detected from archived patch activity and completion notes.

### Implemented changes
- Added per-chat extraction summary:
  - [`roo_task_mar-11-2026_2-27-21-pm.md`](changelog%20update/roo_task_mar-11-2026_2-27-21-pm.md): edits detected in [`Workers/door-admin.js`](Workers/door-admin.js) and [`Workers/reports-worker.js`](Workers/reports-worker.js); completion notes indicate debug-endpoint removal and status-write normalization.
  - [`roo_task_mar-11-2026_4-03-44-pm.md`](changelog%20update/roo_task_mar-11-2026_4-03-44-pm.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js) and [`Workers/door-admin.js`](Workers/door-admin.js); completion notes indicate portal redirect/invite wiring fixes.
  - [`roo_task_mar-12-2026_2-08-42-pm.md`](changelog%20update/roo_task_mar-12-2026_2-08-42-pm.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js), [`Workers/reports-worker.js`](Workers/reports-worker.js), and [`plans/portal-routing-deploy-checklist.md`](plans/portal-routing-deploy-checklist.md); completion notes indicate loop/invite-route hardening.
  - [`roo_task_mar-12-2026_2-43-19-pm.md`](changelog%20update/roo_task_mar-12-2026_2-43-19-pm.md): edits detected in [`Workers/door-admin.js`](Workers/door-admin.js); completion notes indicate first-manager onboarding/dashboard flow updates.
  - [`roo_task_mar-12-2026_3-25-49-pm.md`](changelog%20update/roo_task_mar-12-2026_3-25-49-pm.md): edits detected in [`Workers/door-admin.js`](Workers/door-admin.js) and [`Workers/castle-portal.js`](Workers/castle-portal.js); completion notes indicate redirect/login flow hardening.
  - [`roo_task_mar-12-2026_8-48-03-am.md`](changelog%20update/roo_task_mar-12-2026_8-48-03-am.md): no `apply_patch` file-write markers detected.
  - [`roo_task_mar-12-2026_9-45-06-am.md`](changelog%20update/roo_task_mar-12-2026_9-45-06-am.md): edits detected in [`Workers/door-admin.js`](Workers/door-admin.js), [`Workers/castle-portal.js`](Workers/castle-portal.js), and [`Workers/reports-worker.js`](Workers/reports-worker.js); completion notes indicate admin-host invite correction and portal-session acceptance fixes.
  - [`roo_task_mar-12-2026_11-51-57-am.md`](changelog%20update/roo_task_mar-12-2026_11-51-57-am.md): edits detected in [`index.html`](index.html), [`Workers/reports-worker.js`](Workers/reports-worker.js), [`Workers/castle-portal.js`](Workers/castle-portal.js), and added [`plans/portal-routing-deploy-checklist.md`](plans/portal-routing-deploy-checklist.md).
  - [`roo_task_mar-12-2026_12-32-53-pm.md`](changelog%20update/roo_task_mar-12-2026_12-32-53-pm.md): edits detected in [`Workers/reports-worker.js`](Workers/reports-worker.js), [`Workers/castle-portal.js`](Workers/castle-portal.js), [`Workers/door-admin.js`](Workers/door-admin.js), plus temporary add/delete artifact [`plans/portal-get-block-replacement.txt`](plans/portal-get-block-replacement.txt).
  - [`roo_task_mar-12-2026_12-37-01-pm.md`](changelog%20update/roo_task_mar-12-2026_12-37-01-pm.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js); completion note indicates stray-token cleanup.
  - [`roo_task_mar-13-2026_1-11-18-pm.md`](changelog%20update/roo_task_mar-13-2026_1-11-18-pm.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js), [`Workers/reports-worker.js`](Workers/reports-worker.js), [`Workers/door-admin.js`](Workers/door-admin.js), added/updated [`Workers/shared/helpers.js`](Workers/shared/helpers.js), and added [`plans/pass1-cleanup-roadmap.md`](plans/pass1-cleanup-roadmap.md); completion notes include helper introduction and later helper rollback/inline restoration.
  - [`roo_task_mar-13-2026_1-45-28-pm.md`](changelog%20update/roo_task_mar-13-2026_1-45-28-pm.md): edits detected in [`Workers/reports-worker.js`](Workers/reports-worker.js); completion notes indicate report-viewer UX/status/sidebar refinements.
  - [`roo_task_mar-13-2026_3-18-18-pm.md`](changelog%20update/roo_task_mar-13-2026_3-18-18-pm.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js); completion notes indicate portal UX and naming/display fixes.
  - [`roo_task_mar-13-2026_8-01-39-am.md`](changelog%20update/roo_task_mar-13-2026_8-01-39-am.md): edits detected in [`Workers/reports-worker.js`](Workers/reports-worker.js), [`Workers/door-admin.js`](Workers/door-admin.js), and [`Workers/castle-portal.js`](Workers/castle-portal.js); completion notes indicate route-ownership and loop-stability hardening.
  - [`roo_task_mar-13-2026_9-25-53-am.md`](changelog%20update/roo_task_mar-13-2026_9-25-53-am.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js); completion notes indicate direct sign-in and loop mitigations.
  - [`roo_task_mar-13-2026_10-55-43-am.md`](changelog%20update/roo_task_mar-13-2026_10-55-43-am.md): no `apply_patch` file-write markers detected.
  - [`roo_task_mar-17-2026_4-00-19-pm.md`](changelog%20update/roo_task_mar-17-2026_4-00-19-pm.md): edits detected in [`Workers/reports-worker.js`](Workers/reports-worker.js), [`Workers/door-admin.js`](Workers/door-admin.js), and add/update of [`externalmemory.md`](externalmemory.md).
  - [`roo_task_mar-17-2026_9-13-43-am.md`](changelog%20update/roo_task_mar-17-2026_9-13-43-am.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js) and [`Workers/door-admin.js`](Workers/door-admin.js); completion notes indicate admin diagnostics and portal KPI/UX updates.
  - [`roo_task_mar-17-2026_12-16-11-pm.md`](changelog%20update/roo_task_mar-17-2026_12-16-11-pm.md): no `apply_patch` file-write markers detected in transcript extraction.
  - [`roo_task_mar-17-2026_12-47-50-pm.md`](changelog%20update/roo_task_mar-17-2026_12-47-50-pm.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js) and [`Workers/door-admin.js`](Workers/door-admin.js); completion notes indicate email-first multi-business portal sign-in flow.
  - [`roo_task_mar-23-2026_1-51-17-pm.md`](changelog%20update/roo_task_mar-23-2026_1-51-17-pm.md): edits detected in [`index.html`](index.html) and [`Workers/castle-portal.js`](Workers/castle-portal.js); completion notes indicate marketing updates and root-render alignment.
  - [`roo_task_mar-23-2026_3-18-25-pm.md`](changelog%20update/roo_task_mar-23-2026_3-18-25-pm.md): edits detected in [`index.html`](index.html); completion notes indicate trust/copy refinement passes.
  - [`roo_task_mar-23-2026_12-49-16-pm.md`](changelog%20update/roo_task_mar-23-2026_12-49-16-pm.md): edit detected in [`FFREPLACE/app/main.js`](FFREPLACE/app/main.js); completion notes indicate runtime validation tightening.
  - [`roo_task_mar-24-2026_2-10-41-pm.md`](changelog%20update/roo_task_mar-24-2026_2-10-41-pm.md): edits detected in [`Workers/castle-portal.js`](Workers/castle-portal.js), [`index.html`](index.html), and added [`functions/api/quote-request.js`](functions/api/quote-request.js).
  - [`roo_task_mar-24-2026_4-09-02-pm.md`](changelog%20update/roo_task_mar-24-2026_4-09-02-pm.md): edits detected in [`index.html`](index.html), [`functions/api/quote-request.js`](functions/api/quote-request.js), [`functions/api/contact-request.js`](functions/api/contact-request.js), and added [`assets/vision-kit-reference.svg`](assets/vision-kit-reference.svg).
  - [`roo_task_mar-26-2026_2-49-04-pm.md`](changelog%20update/roo_task_mar-26-2026_2-49-04-pm.md): add/update/delete/add cycle and subsequent edits detected for [`scripts/qbo-subject-autofill.user.js`](scripts/qbo-subject-autofill.user.js).

### Safety/compatibility impact
- This entry is a transcript-extraction backfill only in [`plans/change-log.md`](plans/change-log.md); no runtime code changes were made in this thread.
- UID identity and QR permanence: unchanged by this documentation append.
- Inspection history and PDF retention: unchanged by this documentation append.
- Route/KV/R2 callout: multiple archived chats involved worker-route and KV behavior changes historically, but this specific update only records those changes and does not alter route handlers, KV key patterns, bindings, or R2 paths.

---

## 2026-04-03 — Detailed chat-by-chat archival extraction

### Scope
- Documentation update in [`plans/change-log.md`](plans/change-log.md) with detailed extraction from each archived chat in [`changelog update/`](changelog%20update).

### Why this was done
- Prior backfill was too high-level.
- Requested output format requires concrete implemented deltas per chat, not only transcript references.

### Implemented changes

#### [`roo_task_mar-11-2026_2-27-21-pm.md`](changelog%20update/roo_task_mar-11-2026_2-27-21-pm.md)
- Removed debug endpoint handling from [`Workers/reports-worker.js`](Workers/reports-worker.js).
- Standardized status-write behavior in [`Workers/door-admin.js`](Workers/door-admin.js) so status is canonical and severity is compatibility-mirrored.
- Added compatibility ownership comments for portal-route shims in [`Workers/reports-worker.js`](Workers/reports-worker.js).

#### [`roo_task_mar-11-2026_4-03-44-pm.md`](changelog%20update/roo_task_mar-11-2026_4-03-44-pm.md)
- Updated root/portal redirect handling in [`Workers/castle-portal.js`](Workers/castle-portal.js).
- Corrected admin-driven invite wiring and host targeting in [`Workers/door-admin.js`](Workers/door-admin.js).
- Improved admin portal tab behavior and invite email path handling in [`Workers/door-admin.js`](Workers/door-admin.js).

#### [`roo_task_mar-12-2026_2-08-42-pm.md`](changelog%20update/roo_task_mar-12-2026_2-08-42-pm.md)
- Applied portal/login loop and session-cookie fixes in [`Workers/castle-portal.js`](Workers/castle-portal.js).
- Added compatibility updates for invite acceptance and portal path ownership in [`Workers/reports-worker.js`](Workers/reports-worker.js).
- Updated routing checklist in [`plans/portal-routing-deploy-checklist.md`](plans/portal-routing-deploy-checklist.md).

#### [`roo_task_mar-12-2026_2-43-19-pm.md`](changelog%20update/roo_task_mar-12-2026_2-43-19-pm.md)
- Implemented first-manager onboarding flow updates in [`Workers/door-admin.js`](Workers/door-admin.js), including direct sign-in/dashboard activation behavior.

#### [`roo_task_mar-12-2026_3-25-49-pm.md`](changelog%20update/roo_task_mar-12-2026_3-25-49-pm.md)
- Applied invite-email compatibility fixes and redirect-loop corrections across [`Workers/door-admin.js`](Workers/door-admin.js) and [`Workers/castle-portal.js`](Workers/castle-portal.js).
- Adjusted marketing/login entry behavior in [`Workers/castle-portal.js`](Workers/castle-portal.js).

#### [`roo_task_mar-12-2026_8-48-03-am.md`](changelog%20update/roo_task_mar-12-2026_8-48-03-am.md)
- No code patch/write markers detected in transcript extraction.

#### [`roo_task_mar-12-2026_9-45-06-am.md`](changelog%20update/roo_task_mar-12-2026_9-45-06-am.md)
- Fixed admin-domain invite leakage in [`Workers/door-admin.js`](Workers/door-admin.js).
- Patched portal-host redirect/acceptance behavior in both [`Workers/castle-portal.js`](Workers/castle-portal.js) and [`Workers/reports-worker.js`](Workers/reports-worker.js).
- Corrected invite acceptance to establish usable portal session before secured flows.

#### [`roo_task_mar-12-2026_11-51-57-am.md`](changelog%20update/roo_task_mar-12-2026_11-51-57-am.md)
- Updated marketing/front-page content in [`index.html`](index.html).
- Added/updated portal route and deployment behavior in [`Workers/reports-worker.js`](Workers/reports-worker.js) and [`Workers/castle-portal.js`](Workers/castle-portal.js).
- Added deployment runbook at [`plans/portal-routing-deploy-checklist.md`](plans/portal-routing-deploy-checklist.md).

#### [`roo_task_mar-12-2026_12-32-53-pm.md`](changelog%20update/roo_task_mar-12-2026_12-32-53-pm.md)
- Implemented portal-first/comment visibility and dashboard UX changes in [`Workers/reports-worker.js`](Workers/reports-worker.js), [`Workers/castle-portal.js`](Workers/castle-portal.js), and [`Workers/door-admin.js`](Workers/door-admin.js).
- Added then removed temporary migration artifact [`plans/portal-get-block-replacement.txt`](plans/portal-get-block-replacement.txt).

#### [`roo_task_mar-12-2026_12-37-01-pm.md`](changelog%20update/roo_task_mar-12-2026_12-37-01-pm.md)
- Removed stray literal token sequence causing script/runtime break in [`Workers/castle-portal.js`](Workers/castle-portal.js).

#### [`roo_task_mar-13-2026_1-11-18-pm.md`](changelog%20update/roo_task_mar-13-2026_1-11-18-pm.md)
- Added shared helper module [`Workers/shared/helpers.js`](Workers/shared/helpers.js), propagated imports across workers, then later rolled back to standalone helpers.
- Applied pass-1 cleanup touches across [`Workers/castle-portal.js`](Workers/castle-portal.js), [`Workers/reports-worker.js`](Workers/reports-worker.js), and [`Workers/door-admin.js`](Workers/door-admin.js).
- Added plan artifact [`plans/pass1-cleanup-roadmap.md`](plans/pass1-cleanup-roadmap.md).

#### [`roo_task_mar-13-2026_1-45-28-pm.md`](changelog%20update/roo_task_mar-13-2026_1-45-28-pm.md)
- Updated report-viewer UX/theming/sidebar/status behavior in [`Workers/reports-worker.js`](Workers/reports-worker.js).
- Applied sidebar layering and mobile-hamburger visibility fixes.

#### [`roo_task_mar-13-2026_3-18-18-pm.md`](changelog%20update/roo_task_mar-13-2026_3-18-18-pm.md)
- Implemented portal UX/metrics and business/building display-name improvements in [`Workers/castle-portal.js`](Workers/castle-portal.js).
- Fixed undefined escape helper usage path in [`Workers/castle-portal.js`](Workers/castle-portal.js).

#### [`roo_task_mar-13-2026_8-01-39-am.md`](changelog%20update/roo_task_mar-13-2026_8-01-39-am.md)
- Applied route-ownership and no-loop hardening across [`Workers/reports-worker.js`](Workers/reports-worker.js), [`Workers/door-admin.js`](Workers/door-admin.js), and [`Workers/castle-portal.js`](Workers/castle-portal.js).

#### [`roo_task_mar-13-2026_9-25-53-am.md`](changelog%20update/roo_task_mar-13-2026_9-25-53-am.md)
- Switched portal login behavior toward direct sign-in and loop mitigation in [`Workers/castle-portal.js`](Workers/castle-portal.js).
- Updated report-link host targeting from portal host to reports host.

#### [`roo_task_mar-13-2026_10-55-43-am.md`](changelog%20update/roo_task_mar-13-2026_10-55-43-am.md)
- No code patch/write markers detected in transcript extraction.

#### [`roo_task_mar-17-2026_4-00-19-pm.md`](changelog%20update/roo_task_mar-17-2026_4-00-19-pm.md)
- Applied ownership hardening and admin context-leak fixes in [`Workers/reports-worker.js`](Workers/reports-worker.js) and [`Workers/door-admin.js`](Workers/door-admin.js).
- Added and updated operational memory artifact [`externalmemory.md`](externalmemory.md).

#### [`roo_task_mar-17-2026_9-13-43-am.md`](changelog%20update/roo_task_mar-17-2026_9-13-43-am.md)
- Added portal KPI/filter updates in [`Workers/castle-portal.js`](Workers/castle-portal.js).
- Added admin diagnostics/scanner and freeze/search stability fixes in [`Workers/door-admin.js`](Workers/door-admin.js).

#### [`roo_task_mar-17-2026_12-16-11-pm.md`](changelog%20update/roo_task_mar-17-2026_12-16-11-pm.md)
- No code patch/write markers detected in transcript extraction.

#### [`roo_task_mar-17-2026_12-47-50-pm.md`](changelog%20update/roo_task_mar-17-2026_12-47-50-pm.md)
- Implemented email-first and multi-business portal sign-in flow updates in [`Workers/castle-portal.js`](Workers/castle-portal.js) and [`Workers/door-admin.js`](Workers/door-admin.js).

#### [`roo_task_mar-23-2026_1-51-17-pm.md`](changelog%20update/roo_task_mar-23-2026_1-51-17-pm.md)
- Applied marketing/contact updates in [`index.html`](index.html).
- Updated root/landing rendering behavior in [`Workers/castle-portal.js`](Workers/castle-portal.js).

#### [`roo_task_mar-23-2026_3-18-25-pm.md`](changelog%20update/roo_task_mar-23-2026_3-18-25-pm.md)
- Applied multiple trust/copy and production-marketing refinements in [`index.html`](index.html).

#### [`roo_task_mar-23-2026_12-49-16-pm.md`](changelog%20update/roo_task_mar-23-2026_12-49-16-pm.md)
- Tightened dynamic-form runtime validation in [`FFREPLACE/app/main.js`](FFREPLACE/app/main.js).

#### [`roo_task_mar-24-2026_2-10-41-pm.md`](changelog%20update/roo_task_mar-24-2026_2-10-41-pm.md)
- Removed portal-worker root-page ownership and shifted marketing rendering expectations.
- Applied broad marketing UX updates in [`index.html`](index.html).
- Added quote endpoint implementation in [`functions/api/quote-request.js`](functions/api/quote-request.js).

#### [`roo_task_mar-24-2026_4-09-02-pm.md`](changelog%20update/roo_task_mar-24-2026_4-09-02-pm.md)
- Applied quote/contact flow enhancements in [`index.html`](index.html).
- Expanded quote handling in [`functions/api/quote-request.js`](functions/api/quote-request.js).
- Added and refined contact API in [`functions/api/contact-request.js`](functions/api/contact-request.js).
- Added vision-kit vector asset [`assets/vision-kit-reference.svg`](assets/vision-kit-reference.svg).

#### [`roo_task_mar-26-2026_2-49-04-pm.md`](changelog%20update/roo_task_mar-26-2026_2-49-04-pm.md)
- Added and iteratively refined QBO subject autofill userscript in [`scripts/qbo-subject-autofill.user.js`](scripts/qbo-subject-autofill.user.js), including delete/recreate cycle and final override-control behavior.

### Compatibility + safety notes
- This entry is documentation-only in [`plans/change-log.md`](plans/change-log.md).
- UID identity and QR permanence were not changed by this append action.
- Inspection history and historical PDF retention were not changed by this append action.
- Route/KV/R2 callout: archived chats include historical route and KV-sensitive edits, but this thread only records extracted history and does not mutate runtime routes, KV keys, bindings, or R2 object paths.

---

## 2026-04-06 — Door-admin burn flow validation + binding diagnosis

### Scope
- [`Workers/door-admin.js`](Workers/door-admin.js)
- [`Workers/reports-worker.js`](Workers/reports-worker.js)
- [`plans/change-log.md`](plans/change-log.md)

### Why this was done
- Validate the finalized hard-delete (BURN) behavior on the canonical admin worker.
- Confirm whether burn failures were caused by code regressions vs deployment configuration.
- Document operational guidance for safe UID burn + reuse workflows.

### Implemented/verified changes
- Verified merge modal bugfix exists in admin UI script using [`confirmBtn.disabled`](Workers/door-admin.js:1787) and reset at [`confirmBtn.disabled = false`](Workers/door-admin.js:1802).
- Verified search results include both report actions with customer-first ordering via [`buildCustomerReportHref()`](Workers/door-admin.js:2495), [`buildAdminReportHref()`](Workers/door-admin.js:2503), and action labels [`Open Customer Report`](Workers/door-admin.js:2584) + [`Open Admin Report`](Workers/door-admin.js:2594).
- Verified BURN UI/action exists at [`BURN UID`](Workers/door-admin.js:2602), typed gate [`DELETE UID ${uid}`](Workers/door-admin.js:4204), and endpoint [`/admin/hard-delete-uid`](Workers/door-admin.js:4189).
- Verified escaped newline safety in inline admin script prompt/alert strings at [`"Destructive hard delete.\\n..."`](Workers/door-admin.js:2612) and [`"UID burn complete.\\nKV deleted..."`](Workers/door-admin.js:2634) to avoid prior template-literal parse issues.
- Verified module load/syntax sanity by importing [`Workers/door-admin.js`](Workers/door-admin.js) in Node (no parse errors).

### Production issue diagnosed
- Burn attempts failed with `Missing REPORTS_BUCKET binding`, which is triggered by the explicit guard [`if (!env.REPORTS_BUCKET)`](Workers/door-admin.js:4193).
- Root cause identified as deployment binding configuration for door-admin (missing R2 binding), not missing objects in R2.
- Confirmed upload path expects same R2 binding pattern in reports worker via [`env.REPORTS_BUCKET.put(...)`](Workers/reports-worker.js:1760).

### Operational guidance recorded
- For burn to execute fully, door-admin must have R2 binding name `REPORTS_BUCKET` mapped to the live reports bucket.
- If R2 objects were manually deleted earlier, burn can still complete KV cleanup when binding exists; R2 delete count may simply be lower/zero.
- After burn, UID can be reused on a new upload because `/upload` recreates UID/path pointers and new report objects.

### Compatibility + safety notes
- UID identity model intentionally overridden only for explicit destructive admin action (typed confirmation gate).
- No QR format change introduced.
- No KV key naming schema changes introduced.
- No R2 object path schema changes introduced.
- Route/KV/R2 callout: this thread validated existing runtime behavior and deployment prerequisites; no new route contracts were introduced.
