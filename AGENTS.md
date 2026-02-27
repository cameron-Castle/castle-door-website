# CASTLE DOOR – UID-CENTRIC INSPECTION PLATFORM  
## Authoritative LLM Training Prompt (Production Operating Rules)

You are onboarding into a **live, production** Cloudflare Workers system used in the real world.  
This is **not** a greenfield project. Physical QR codes are already installed on real doors.

Your job: **extend, stabilize, and evolve** the system **without breaking production**.

---

## 1) Non-Negotiable Truths

### 1.1 UID is sacred
A **UID represents a physical door opening**.

A QR code with that UID is physically attached to the door frame and encodes:

`https://r.castledoorict.com/r/<UID>`

**UID never changes.**  
UID outlives: businesses, tenants, repairs, ownership changes.  
UID only dies if the opening is physically removed (remodel).

**You may NOT:**
- Regenerate UIDs
- Require QR reprinting
- Embed business identity into the QR/UID
- Invalidate historical data

---

## 2) Physical → Digital Workflow (Real-World Constraints)

Real technician workflow:
1. Technician places QR code on the door.
2. Technician opens a FastField inspection form.
3. Technician scans QR (UID) into the form.
4. Technician completes inspection.
5. FastField POSTs to: `POST https://r.castledoorict.com/upload`

Within minutes, a customer scans the same QR and must see the report.

**Consequence:** Upload failures = customer failure.  
Upload must be **fast, idempotent, reliable**.  
No batch jobs. No async delays.

---

## 3) Live Production Architecture (Facts Only)

### 3.1 `report-worker.js` (live and active) - corresponds to 
One Worker currently handles:
- Upload ingestion
- UI rendering
- PDF serving
- Routing
- CTA requests
- Partial security logic

Assume: changing this Worker can break production.  
Refactors must be incremental.

### 3.2 `admin-worker.js` (deployed but secondary)
Exists and is bound to shared KV/R2. Intended for admin-only actions:
- Business config
- Security toggles
- Device/token management

Not the daily operational path yet.

---

## 4) Routing Contract (Exact)

### 4.1 Canonical entrypoint (immutable)
`/r/:uid`

This is what QR codes hit. This must always work.  
It may redirect internally, but must resolve correctly.

### 4.2 Navigational/UI routes
`/reports/:businessSlug/:buildingSlug/:doorSlugOrUid`

These are for browsing/organization. **Slugs are NOT identity** and may change.

Rule:  
**QR resolves UID → system determines context → UI renders dynamically.**

---

## 5) Upload Metadata Contract (Authoritative)

FastField sends a **pipe-delimited** string:

`Business | Status | Building | DoorLabel | UID | ConstructionCompany | Date | Time`

Example:

`gpt test|Pass|main|office 1|whereami|Other|01-19-2026|1:45 PM`

Rules:
- This format is live.
- You must support it.
- JSON export may be added later, but this **cannot break**.

---

## 6) Data Model (Conceptual — Do Not Guess)

### 6.1 UID (door opening)
- Immutable identifier
- Anchor for all history

### 6.2 Inspection events (history)
- Each inspection creates a new event
- Each event may have:
  - Customer PDF
  - Technician PDF (future)
  - Timestamp
  - Status
- Old events remain visible forever

### 6.3 Assignment (mutable)
A UID has a **current assignment**:
- Business (display name)
- Building (display name)

Assignment may change without touching UID or history.

Mental model: **“The door didn’t move. The business context did.”**

---

## 7) PDF Semantics

PDFs are **evidence**, not navigation.  
Customers are allowed to see notes (if present).

Business names should **NOT** be baked into PDFs permanently.  
Business identity should be rendered by the **webpage around the PDF**.

Design for two PDF types:
- Customer PDF (public)
- Technician PDF (internal)

Only one exists today. Build for two.

---

## 8) Security Model (Current + Intent)

Current:
- Businesses can be marked “secure”
- Secure doors should not expose info on scan
- Device enrollment + tokens exist (partially)
- CTA requests exist

Intended:
- Public door: anyone scanning QR sees report
- Secure door: unauthenticated users see “Need an account”; authorized users see full view

Authorization signals may include:
- Device token
- Enrollment token
- Email domain whitelist (e.g. `@nguyenele.com`)

Do **not** invent OAuth unless explicitly requested.

---

## 9) Admin Powers (Free-Will Adjustments)

Admin must be able to:
- Rename business display names (UI only)
- Move a door (UID) between businesses/buildings
- Fix upload mistakes
- Reassign reports without breaking QR
- Preserve all historical PDFs
- Toggle public/secure state

Mental model: **“Drag a file to another folder. The file itself doesn’t change.”**

---

## 10) CTA / Service Requests

Customers may request service on multiple doors.

Requests must be:
- Tied to UID
- Tied to business context
- Reviewable by admin

Email notifications may CC/BCC internal staff.

**Important note:** The code already has **CTA config fields** and **admin UI wiring** for those fields (use what exists; don’t redesign without need).

---

## 11) Development Rules (Critical)

Local dev reality: **Windows PowerShell**, two terminals:

- Terminal A: `wrangler dev` (interactive; stays open)
- Terminal B: commands (wrangler kv/r2, git, edits)

Common pitfalls:
- Writing to wrong KV namespace (preview vs prod)
- Running commands in wrong directory
- Blocking terminal with interactive wrangler
- Assuming “local” means isolated (it doesn’t)

---

## 12) Schema Changes (Strict Rule)

You may propose schema changes ONLY IF you:
- Explain the pitfall being avoided (plain language)
- Show how existing data keeps working

Acceptable example:
> “If we store business name directly on the UID record, then when a tenant changes, every old report looks wrong. Separating ‘assignment’ avoids rewriting history.”

Not acceptable:
> “Normalize into a relational structure.”

---

## 13) Anti-Patterns (Do Not Suggest)

- Reprinting QR codes
- Changing UID format
- Baking business identity into UID
- Deleting historical PDFs
- Big-bang rewrites
- “Just migrate everything”
- Abstracting before stabilizing

---

## 14) How You Should Interact With Cam

- Provide **exact code replacements**, not pseudo-code.
- Prefer **full file output** over diffs when asked.
- Keep explanations short and concrete.
- When blocked, ask at most **3** precise questions.
- Never assume something is unused just because it’s messy.
- Treat production with respect.

---

## 15) Open Problems (You May Work On These)

- Dual-PDF upload flow
- UID redirect/alias chains
- Admin reassignment UI
- Scaling beyond “doors” to generic assets
- Cleaner separation between viewer/admin/upload

---

## Final Rule

If a proposed change would cause a field technician to need to **reprint a QR code**, it is **wrong**.

---

# Addendum — Local vs Live Execution Model (Critical)

This system does **not** have a clean local/prod separation.

## A) Three modes exist (do not confuse them)

### 1) Live / Production
- Code deployed to Cloudflare
- Real users + real QR scans + real uploads
- Real KV + R2
- Domain: `r.castledoorict.com`
- Changes require `wrangler deploy`

### 2) Local code + remote resources (most common dev mode)
- Code runs locally via `wrangler dev`
- KV/R2 may point to remote namespaces/buckets
- Browser hits `http://127.0.0.1:8787`
- Actions may read/write real production data

Implications:
- “Local” does not mean safe
- Uploads can create real reports
- KV writes can mutate real state

### 3) Local code + local resources (rare/limited)
- Uses `wrangler dev --persist-to .wrangler`
- KV/R2 stored locally
- Not representative for upload testing

## B) Terminal rule (non-optional)
- Terminal A: runs `wrangler dev`
- Terminal B: wrangler kv/r2, git, edits, commands

## C) KV preview vs prod (common failure point)
If a KV binding has both `id` and `preview_id`, every write must be explicit:
- `--preview` writes preview namespace
- `--preview false` writes production namespace

## D) Development truth
When Cam says “It works locally” it often means:
- Local code talking to live Cloudflare KV/R2
- Verified via `/health`, `/__r2_test`, version stamps

Never assume:
- local == isolated
- prod == separate environment

## E) What must always be verified before changes
- Which worker: `reports-worker` vs `door-admin`
- Which directory is active
- Whether KV/R2 bindings are remote
- Whether writes affect preview or prod
- `/r/:uid` still resolves correctly

## F) Why this matters (plain language)
If you don’t respect this model, you can accidentally:
- overwrite live door assignments
- orphan PDFs
- break customer access

This system intentionally blurs local/live to support real workflows.

---

# Source of Truth Hierarchy (Critical)

1. **UID (physical opening)** — absolute anchor; never derived or rewritten  
2. **Inspection events (history)** — immutable once written; PDFs belong to events  
3. **Assignment context (mutable)** — business/building display context; may change freely  
4. **Slugs/URLs** — navigational only; may change; never identifiers  

If two sources disagree, the higher authority wins.

---

# Do Not Auto-Optimize

Do not attempt to:
- collapse UID + business into one identifier
- deduplicate PDFs by business
- replace KV with a relational model unless explicitly asked
- refactor for “clean architecture” at the expense of production safety
- remove legacy paths unless a compatibility shim is provided

Operational correctness > elegance.

---

# When To Stop And Ask Cam Questions

Stop and ask **before coding** if:
- A change might affect `/r/:uid` resolution
- A KV key naming change is proposed
- An R2 object key path is being altered
- Admin actions would mutate historical records
- A change could require QR reprinting (even indirectly)

Ask at most 3 questions. Proceed only after confirmation.

---

# Condensed Quick Reference (Minimal, Non-Confusing)

- **UID is the physical opening.** QR encodes `/r/<UID>`. **Never change UID. Never require reprint.**
- **QR route is immutable:** `/r/:uid` must always resolve (may redirect internally).
- **Slugs are navigational only:** `/reports/...` can change; UID cannot.
- **Workflow is real-time:** FastField uploads to `/upload`; customer must see results within minutes. **No batch/async delays.**
- **Upload metadata contract is fixed:** `Business|Status|Building|DoorLabel|UID|ConstructionCompany|Date|Time` (pipe-delimited).
- **History is permanent:** each inspection is a new event; old PDFs remain visible forever.
- **Assignment is mutable:** business/building display context can change without touching UID/history.
- **PDFs are evidence:** don’t bake permanent business identity into PDFs; render context in the webpage.
- **Security:** some businesses are “secure”; unauth users should not see details; auth via device/enroll tokens and optional email domain whitelist. Don’t invent OAuth.
- **Admin must be able to reassign/move doors and fix mistakes** without breaking QR or deleting history.
- **Dev reality:** Windows PowerShell, two terminals; “local” often hits live KV/R2; always verify preview vs prod writes.
- **CTA note:** CTA config fields + admin UI wiring already exist in code—extend, don’t redesign blindly.
- **Final rule:** if it implies QR reprinting (even indirectly), it’s wrong.