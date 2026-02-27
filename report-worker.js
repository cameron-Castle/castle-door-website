export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;

    // -------- Helper response builders --------
    const text = (s, status = 200, extra = {}) =>
      new Response(s, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8", ...extra },
      });

    const html = (s, status = 200, extra = {}) =>
      new Response(s, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", ...extra },
      });

    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), {
        status,
        headers: { "content-type": "application/json" },
      });

    const isoNow = () => new Date().toISOString();
    const esc = (s = "") =>
      s.replace(/[&<>"']/g, (ch) => (
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        }[ch]
      ));

    const byNewestNameDesc = (a, b) => b.key.localeCompare(a.key); // ISO timestamps sort correctly

    // your existing slug helper
    const parseCookies = (header) => {
      const out = {};
      if (!header) return out;
      header.split(";").forEach((part) => {
        const [k, v] = part.split("=").map((s) => s.trim());
        if (k && v) out[k] = v;
      });
      return out;
    };

    const slug = (s = "") =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unknown";

    // ---------- NEW HELPERS (for opaque codes) ----------

    // Normalize a string for stable lookup keys
    const normalize = (s = "") =>
      s.toLowerCase().trim().replace(/\s+/g, " ");

    // Generate or look up a stable opaque code for a business
    async function getOrCreateBusinessCode(kv, businessName) {
      const norm = normalize(businessName || "");
      const existing = await kv.get(`biz:${norm}`, "text");
      if (existing) return existing;

      const code = Math.random().toString(36).slice(2, 8); // 6-char base36
      await kv.put(`biz:${norm}`, code);
      return code;
    }

    // Generate or look up a stable opaque code for a building within a business
    async function getOrCreateBuildingCode(kv, businessCode, buildingName) {
      const norm = (buildingName || "").toString().trim().toLowerCase();
      const key = `bld:${businessCode}:${norm}`;

      const existing = await kv.get(key, "text");
      if (existing) return existing;

      const code = Math.random().toString(36).slice(2, 8);
      await kv.put(key, code);
      return code;
    }
    // -----------------------------------
    // ADMIN: create enrollment token
    // GET /admin/enroll-token/:biz?k=ADMIN_KEY
    // -----------------------------------
    if (
      req.method === "GET" &&
      pathname.startsWith("/admin/enroll-token/")
    ) {
      const parts = pathname.split("/").filter(Boolean); // ["admin", "enroll-token", ":biz"]
      if (parts.length !== 3) {
        return text("Bad request", 400);
      }

      const biz = parts[2];

      // Simple admin auth using ?k=... query
      const providedKey = url.searchParams.get("k");
      if (!providedKey || providedKey !== env.ADMIN_KEY) {
        return text("Forbidden", 403);
      }

      // Generate a random enrollment token
      const enrollToken = crypto.randomUUID().replace(/-/g, "");
      const enrollKey = `enroll:${enrollToken}`;

      const now = Date.now();
      const data = {
        biz,              // which business this token is for
        max_uses: 50,     // how many devices can enroll with this link
        uses: 0,
        expires_at: now + 7 * 24 * 60 * 60 * 1000, // 7 days
      };

      await env.ENROLL_TOKENS.put(enrollKey, JSON.stringify(data));

      const enrollUrl = `${url.origin}/enroll/${encodeURIComponent(
        biz
      )}?t=${encodeURIComponent(enrollToken)}`;

      return text(
        `Enrollment URL for biz=${biz}\n\n${enrollUrl}\n\nToken: ${enrollToken}`
      );
    }

    // -----------------------------------
    // ENROLLMENT: use token, set device cookie
    // GET /enroll/:biz?t=TOKEN
    // -----------------------------------
    if (req.method === "GET" && pathname.startsWith("/enroll/")) {
      const parts = pathname.split("/").filter(Boolean); // ["enroll", ":biz"]
      if (parts.length !== 2) {
        return text("Bad request", 400);
      }

      const biz = parts[1];
      const enrollToken = url.searchParams.get("t");
      if (!enrollToken) {
        return text("Missing enrollment token", 400);
      }

      const enrollKey = `enroll:${enrollToken}`;
      const raw = await env.ENROLL_TOKENS.get(enrollKey, "text");
      if (!raw) {
        return text("Invalid or expired enrollment token", 403);
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.log("Failed to parse enroll token JSON", e);
        return text("Enrollment token corrupted", 500);
      }

      const now = Date.now();

      // basic safety checks
      if (data.biz !== biz) {
        return text("Token not valid for this business", 403);
      }
      if (typeof data.expires_at === "number" && now > data.expires_at) {
        return text("Enrollment token expired", 403);
      }
      if (typeof data.max_uses === "number" && typeof data.uses === "number") {
        if (data.uses >= data.max_uses) {
          return text("Enrollment token used too many times", 403);
        }
      }

      // Create device token (per-device ID)
      const deviceTokenId = "dev_" + crypto.randomUUID().replace(/-/g, "");
      const deviceKey = `device:${deviceTokenId}`;

      const deviceRecord = {
        id: deviceTokenId,
        biz,
        created_at: now,
        revoked: false,
      };

      await env.DEVICE_TOKENS.put(deviceKey, JSON.stringify(deviceRecord));

      // Increment uses for enrollment token (non-critical if race)
      data.uses = (data.uses || 0) + 1;
      await env.ENROLL_TOKENS.put(enrollKey, JSON.stringify(data));

// Set cookie for 1 year, shared across *.castledoorict.com
const cookie = [
  `castle_access=${deviceTokenId}`,
  "Path=/",
  "Max-Age=31536000", // 1 year
  "Secure",
  "HttpOnly",
  "SameSite=Lax",
  "Domain=.castledoorict.com",
].join("; ");


      const htmlBody = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Device enrolled</title>
  </head>
  <body>
    <h1>Device enrolled for ${esc(biz)}</h1>
    <p>This device can now view reports for ${esc(
      biz
    )} using your normal door links.</p>
  </body>
</html>`;

      const resp = html(htmlBody); // uses your existing html() helper
      resp.headers.append("Set-Cookie", cookie);
      return resp;
    }

    // -------- Logo endpoint (placeholder for now) --------
    if (req.method === "GET" && pathname === "/brand/logo") {
      const obj = await env.REPORTS_BUCKET.get("logos/default.png");
      if (!obj || !obj.body) {
        return new Response("Logo not found", { status: 404 });
      }

      const headers = new Headers();
      headers.set(
        "Content-Type",
        (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png"
      );
      headers.set("Cache-Control", "public, max-age=3600");

      return new Response(obj.body, { headers });
    }

    // -------- Health --------
    if (req.method === "GET" && pathname === "/health") {
      return json({ ok: true, time: isoNow() });
    }
    function decodeMimeFilename(name) {
      if (!name) return name;
    
      const m = name.match(/^=\?utf-8\?B\?(.+)\?=$/i);
      if (!m) return name;
    
      try {
        return atob(m[1]);
      } catch (err) {
        console.warn("Failed to decode MIME filename", err);
        return name;
      }
    }
    
    // =====================================================================
    //  POST /upload  (FastField -> Worker)
    // =====================================================================
    if (req.method === "POST" && pathname === "/upload") {
      const apiKey = req.headers.get("x-api-key");
      if (!apiKey || apiKey !== env.API_KEY) return text("Unauthorized", 401);

      const ctype = req.headers.get("content-type") || "";
      if (!ctype.includes("multipart/form-data"))
        return text("Expected multipart/form-data", 400);

      const form = await req.formData();

      // Debug: list all keys FastField sent
      try {
        const keys = [];
        for (const [name, value] of form.entries()) {
          keys.push(`${name}${value instanceof File ? " (file)" : ""}`);
        }
        console.log("Form keys:", keys.join(", "));
      } catch (e) {
        console.log("Error listing form keys", e);
      }

      // 1) Pick the FIRST file in the form as the report PDF
      let file = null;
      for (const [, value] of form.entries()) {
        if (value instanceof File) {
          file = value;
          break;
        }
      }
      if (!file) return text("Missing file in upload (no file parts found)", 400);

      // 2) Parse metadata from the file name.
      const rawName = decodeMimeFilename(file.name || "");
      console.log("Raw file name:", rawName);

      const baseName = rawName.replace(/\.[^.]+$/, "").trim();

      let business = "";
      let triRaw = "";
      let building = "";
      let doorLabel = "";
      let barcodeUid = "";
      let submittedAt = "";
      let doorStatusRaw = ""; // Pass / Conditional Pass / Fail
      let constructionCompany = "";


      // --- First try pipe format (if FF ever uses | literally) ---
      let parts = baseName.split("|").map((p) => p.trim());
      console.log("Pipe-split parts:", parts);

      if (parts.length >= 8) {
        // Pipe format:
        // 0: business
        // 1: doorStatus
        // 2: building
        // 3: doorLabel
        // 4: UID
        // 5: constructionCompany
        // 6: date
        // 7+: time tokens
        business = parts[0];
        doorStatusRaw = parts[1];
        building = parts[2];
        doorLabel = parts[3];
        barcodeUid = parts[4];
        constructionCompany = parts[5];

        const datePart = parts[6];
        const timePart = parts.slice(7).join(" ");
        submittedAt = `${datePart} ${timePart}`.trim();
      } else {
        //       // --- Underscore format (current FF output, no UID toggle) ---
      const uParts = baseName.split("_").map((p) => p.trim());
      console.log("Underscore-split parts:", uParts);

      // Single underscore mask (no UID toggle):
      //
      //    0: business
      //    1: doorStatus
      //    2: building
      //    3: doorLabel
      //    4: UID
      //    5: constructionCompany
      //    6: date
      //    7+: time
      //
      // Building-missing and legacy patterns are kept for backward compatibility.

      if (uParts.length >= 8) {
        // Main pattern (building present)
        business = uParts[0];
        doorStatusRaw = uParts[1];
        building = uParts[2];
        doorLabel = uParts[3];
        barcodeUid = (uParts[4] || "").trim();
        constructionCompany = uParts[5];

        const datePart = uParts[6];
        const timePart = uParts.slice(7).join(" ");
        submittedAt = `${datePart} ${timePart}`.trim();

        // Optional: peel off a legacy trailing "true"/"false" accidentally
        // baked into the UID, e.g. "testuid1 true" -> "testuid1".
        if (barcodeUid) {
          const tokens = barcodeUid.split(" ").filter(Boolean);
          if (
            tokens.length > 1 &&
            /^(true|false)$/i.test(tokens[tokens.length - 1])
          ) {
            tokens.pop(); // drop the trailing true/false
            barcodeUid = tokens.join(" ");
          }
        }
      } else if (uParts.length === 7) {
        // Building missing — shift everything left (older exports)
        business = uParts[0];
        doorStatusRaw = uParts[1];
        building = ""; // explicitly blank building
        doorLabel = uParts[2];
        barcodeUid = (uParts[3] || "").trim();
        constructionCompany = uParts[4];

        const datePart = uParts[5];
        const timePart = uParts.slice(6).join(" ");
        submittedAt = `${datePart} ${timePart}`.trim();
      } else if (uParts.length >= 5) {
        // Legacy fallback (very old format)
        business = uParts[0];
        triRaw = uParts[1];
        building = uParts[2];
        doorLabel = uParts[3];
        barcodeUid = (uParts[4] || "").trim();

        if (uParts.length > 5) {
          submittedAt = uParts.slice(5).join(" ");
        }
      } else {
        console.log("Filename did not match expected formats, falling back", {
          baseName,
        });
        business = baseName;
        triRaw = "0";
        building = "";
        doorLabel = baseName;
        barcodeUid = baseName;
      }
    }

// -------- Status normalization (canonical) --------
let status = "";

if (doorStatusRaw) {
  const v = doorStatusRaw.trim().toLowerCase();

  if (v === "pass") {
    status = "Pass";
  } else if (v === "conditional pass") {
    status = "Conditional Pass";
  } else if (v === "fail" || v === "flagged") {
    status = "Fail";
  } else {
    // Unknown custom value, carry through
    status = doorStatusRaw.trim();
  }
} else if (triRaw === "1") {
  status = "Fail";
} else if (triRaw === "0") {
  status = "Pass";
}
      // --- FIX: Ensure building never breaks upload ---
      building = (building || "").toString().trim();

      // ==================================================================
      // Identity + slug logic
      // ==================================================================
      // 1) Decide if we have a real UID (not blank, not "true"/"false")
      const normalizedUid = (barcodeUid || "").trim();
      const normalizedUidLower = normalizedUid.toLowerCase();

      const hasRealUid =
        normalizedUid !== "" &&
        normalizedUidLower !== "true" &&
        normalizedUidLower !== "false";

      // 2) Door ID used for folder name + report routing
      // Prefer real UID; otherwise fall back to business/building/doorLabel;
      // last resort: baseName so upload never dies.
      const doorIdRaw =
        (hasRealUid ? normalizedUid : "") ||
        [business, building, doorLabel].filter(Boolean).join(" | ") ||
        baseName; // last resort

      if (!doorIdRaw) {
        return text(
          "Missing door identifier (could not derive from filename).",
          400
        );
      }

      const doorId = doorIdRaw.trim();

      // 3) Slug base for URLs:
      //    - If real UID: use the UID
      //    - Else if we have a door label: use that
      //    - Else: fall back to combo of business/building/doorId
      let slugBase = "";
      if (hasRealUid) {
        slugBase = normalizedUid;
      } else if (doorLabel && doorLabel.trim()) {
        slugBase = doorLabel.trim();
      } else {
        slugBase = [business, building, doorId].filter(Boolean).join(" ");
      }
      const doorSlug = slug(slugBase);

      // 4) Human-facing label for dashboards and reports
      const displayLabel =
        hasRealUid && doorLabel && doorLabel.trim()
          ? `${doorLabel.trim()} (${normalizedUid})`
          : (doorLabel || doorId);

      const ts = isoNow();
      const inspectedAt = submittedAt || ts; // use piped submission time if present
      const safeDoor = doorId.replace(/[^\w\-./]/g, "_");
      const fileName = `${ts}.pdf`;
      const objectKey = `${safeDoor}/${fileName}`;
// ===============================================
// AUTO-CREATE BUSINESS CONFIG + ENROLL TOKEN
// ===============================================

// create a stable slug from business name
const businessSlug = slug(business || "unknown");

// bizcfg key in KV
const bizCfgKey = `bizcfg:${businessSlug}`;

// check if business config exists
let bizCfgRaw = await env.ENROLL_TOKENS.get(bizCfgKey, "text");
let bizCfg;

if (!bizCfgRaw) {
  // NEW business detected → auto-create config
  const newToken = crypto.randomUUID().replace(/-/g, "");

  // unlimited enrollment token (no expiry, unlimited uses)
  const tokenKey = `enroll:${newToken}`;
  const tokenData = {
    biz: businessSlug,
    max_uses: null,        // unlimited
    uses: 0,
    expires_at: null       // no expiration
  };

  // store token
  await env.ENROLL_TOKENS.put(tokenKey, JSON.stringify(tokenData));

  // business config
  bizCfg = {
    slug: businessSlug,
    name: business || businessSlug,
    mode: "standard",        // all new businesses start unsecured
    device_limit: null,      // unlimited
    enrollment_token: newToken,
    enrollment_uses: 0
  };

  await env.ENROLL_TOKENS.put(bizCfgKey, JSON.stringify(bizCfg));
} else {
  // existing business → load config
  try {
    bizCfg = JSON.parse(bizCfgRaw);
  } catch (e) {
    bizCfg = {
      slug: businessSlug,
      name: business || businessSlug,
      mode: "standard",
      device_limit: null
    };
  }
}



      // 4) Ensure opaque business/building codes (stable per name)
      const businessCode = await getOrCreateBusinessCode(
        env.REPORTS_KV,
        business || "unknown"
      );
      const buildingForCode = building || "main";
      const buildingCode = await getOrCreateBuildingCode(
        env.REPORTS_KV,
        businessCode,
        buildingForCode
      );

      // 5) Store PDF in R2 (including codes in metadata)
      await env.REPORTS_BUCKET.put(objectKey, await file.arrayBuffer(), {
        httpMetadata: {
          contentType: "application/pdf",
          contentDisposition: `inline; filename="${rawName || fileName}"`,
        },
        customMetadata: {
          doorId,
          doorSlug,
          displayLabel,
          business,
          building,
          label: doorLabel, // keep raw label if you still want it
          status,
          doorStatusRaw,
          inspectedAt,
          uploadedAt: ts,
          flagged_raw: triRaw,
          sourceFileName: rawName,
          constructionCompany,
          businessCode,
          buildingCode,
        },
      });

      // 6) Index door in KV for future dashboards (opaque business/building codes)
      const doorKey = `door:${businessCode}:${buildingCode}:${doorSlug}`;

      const summary = {
        business,
        building,
        doorId,
        doorSlug,
        displayLabel,
        status,
        lastReportKey: objectKey,
        lastInspectedAt: inspectedAt,
        businessCode,
        buildingCode,
      };
// -------------------------------------------------
// UID-FIRST RECORD (canonical anchor)
// -------------------------------------------------
const uidKey = `door:${safeDoor}`;

const summaryWithUidFields = {
  uid: safeDoor,               // immutable physical opening
  doorId,                      // raw UID before sanitization
  displayLabel,

  // current assignment (mutable)
  business,
  building,
  businessCode,
  buildingCode,
  doorSlug,

  // status snapshot
  status,
  
  // report pointers
  lastReportKey: objectKey,
  lastInspectedAt: inspectedAt,

  // timestamps
  updatedAt: ts,
};

      // 6a) Alias from safeDoor (the thing you use in /r/:id) → codes + slug
      const aliasKey = `doorIndex:${safeDoor}`; // <-- THIS must match /r route

      // 6b) Ensure there is a bizcfg entry for this businessCode
      async function ensureBizConfig() {
        const cfgKey = `bizcfg:${businessCode}`;

        const existingRaw = await env.ENROLL_TOKENS.get(cfgKey, "text");
        let cfg;
        if (existingRaw) {
          try {
            cfg = JSON.parse(existingRaw);
          } catch {
            cfg = {};
          }
        } else {
          cfg = {};
        }

        // canonical slug is the businessCode used in /reports/:businessCode/...
        cfg.slug = businessCode;

        // prefer the human business name from the upload
        const trimmedName = (business || "").toString().trim();
        if (trimmedName) {
          if (!cfg.name || cfg.name === cfg.slug) {
            cfg.name = trimmedName;
          }
        } else if (!cfg.name) {
          cfg.name = cfg.slug;
        }

        // default mode if not set yet
        if (!cfg.mode) cfg.mode = "standard";

        await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));
      }

      ctx.waitUntil(
        Promise.all([
          // existing path-based index (unchanged)
          env.REPORTS_KV.put(doorKey, JSON.stringify(summary)),
      
          // NEW: UID-first canonical record
          env.REPORTS_KV.put(uidKey, JSON.stringify(summaryWithUidFields)),
      
          // QR pointer
          env.REPORTS_KV.put(
            aliasKey,
            JSON.stringify({ businessCode, buildingCode, doorSlug })
          ),
      
          ensureBizConfig(),
        ])
      );
      




      // 7) Response back to FastField
      return json(
        {
          ok: true,
          door_id: doorId,
          object_key: objectKey,
          // canonical slugged URL
          report_url: `/reports/${encodeURIComponent(
            businessCode
          )}/${encodeURIComponent(buildingCode)}/${encodeURIComponent(
            doorSlug
          )}`,
          // raw file URL still available if the app wants it
          file_url: `/file/${encodeURIComponent(
            safeDoor
          )}/${encodeURIComponent(fileName)}`,
          // (Optional) include a QR-friendly short URL if you want
          short_url: `/r/${encodeURIComponent(safeDoor)}`,
        },
        201
      );
    }

    // =====================================================================
    //  GET /file/:doorId/:fileName  (serve PDF from R2, cached)
    // =====================================================================
    if (req.method === "GET" && pathname.startsWith("/file/")) {
      const parts = pathname.split("/").filter(Boolean); // ["file", ":doorId", ":fileName"]
      if (parts.length !== 3) return text("Not Found", 404);

      const rawDoorId = parts[1];
      const rawFileName = parts[2];

      const doorId = decodeURIComponent(rawDoorId);
      const fileName = decodeURIComponent(rawFileName);
      const key = `${doorId}/${fileName}`;

      const cache = caches.default;
      const cacheKey = new Request(req.url, req);
      const hit = await cache.match(cacheKey);
      if (hit) return hit;

      const obj = await env.REPORTS_BUCKET.get(key);
      if (!obj) return text("File not found", 404);

      const resp = new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "application/pdf",
          "content-disposition":
            obj.httpMetadata?.contentDisposition ||
            `inline; filename="${fileName}"`,
          "cache-control": "public, max-age=86400",
        },
      });
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }

// =====================================================================
//  GET /pdfviewer/:doorId/:fileName  (simple HTML wrapper around PDF)
// =====================================================================
if (req.method === "GET" && pathname.startsWith("/pdfviewer/")) {
  const parts = pathname.split("/").filter(Boolean); // ["pdfviewer", ":doorId", ":fileName"]
  if (parts.length !== 3) return text("Not Found", 404);

  const safeDoor = decodeURIComponent(parts[1]);
  const fileName = decodeURIComponent(parts[2]);

  const filePath = `/file/${encodeURIComponent(
    safeDoor
  )}/${encodeURIComponent(fileName)}`;

  return html(`<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Door report</title>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      html, body {
        height: 100%;
        background: #2b2b2b;
        overflow: hidden;
      }
      #pdf-container {
        width: 100%;
        height: 100vh;
        overflow-y: auto;
        overflow-x: hidden;
        background: #2b2b2b;
      }
      .pdf-page-canvas {
        display: block;
        margin: 0 auto;
        background: #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
      #loading {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: #fff;
        font-family: system-ui, sans-serif;
        font-size: 1.2rem;
        text-align: center;
      }
      .spinner {
        width: 40px;
        height: 40px;
        border: 4px solid rgba(255,255,255,0.3);
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin: 0 auto 1rem;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      #error {
        display: none;
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: #fff;
        font-family: system-ui, sans-serif;
        text-align: center;
        padding: 2rem;
      }
      #error a {
        color: #60a5fa;
        font-size: 1.1rem;
        font-weight: 600;
        text-decoration: none;
        display: inline-block;
        margin-top: 1rem;
        padding: 0.75rem 1.5rem;
        background: #3b82f6;
        border-radius: 0.5rem;
      }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  </head>
  <body>
    <div id="loading">
      <div class="spinner"></div>
      <div>Loading PDF...</div>
    </div>
    <div id="error">
      <p>Unable to load PDF</p>
      <a href="${filePath}" download>Download PDF Report</a>
    </div>
    <div id="pdf-container"></div>
  
    <script>
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  
      const pdfUrl = '${filePath}';
      const container = document.getElementById('pdf-container');
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');
  
      async function renderPDF() {
        try {
          const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
          loading.style.display = 'none';
  
          // Get viewport width for responsive scaling
          const containerWidth = container.clientWidth;
  
          // Render all pages
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            
            // Calculate scale to fit container width
            const viewport = page.getViewport({ scale: 1 });
            const scale = containerWidth / viewport.width;
            
            // Use device pixel ratio for crisp rendering on high-DPI displays
            const pixelRatio = window.devicePixelRatio || 1;
            const outputScale = scale * pixelRatio;
            const scaledViewport = page.getViewport({ scale: outputScale });
  
            // Create canvas
            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-page-canvas';
            
            // Set internal canvas size (high resolution)
            canvas.width = scaledViewport.width;
            canvas.height = scaledViewport.height;
            
            // Set display size (CSS pixels)
            canvas.style.width = scaledViewport.width / pixelRatio + 'px';
            canvas.style.height = scaledViewport.height / pixelRatio + 'px';
            
            container.appendChild(canvas);
  
            // Render page at high resolution
            const context = canvas.getContext('2d');
            await page.render({
              canvasContext: context,
              viewport: scaledViewport
            }).promise;
          }
        } catch (err) {
          console.error('PDF rendering error:', err);
          loading.style.display = 'none';
          error.style.display = 'block';
        }
      }
  
      renderPDF();
    </script>
  </body>
  </html>`);
}


    // =====================================================================
    //  GET /r/:id  (short redirect → slugged /reports/:bizCode/:bldCode/:doorSlug)
    // =====================================================================
    if (req.method === "GET" && pathname.startsWith("/r/")) {
      const parts = pathname.split("/").filter(Boolean); // ["r", ":id"]
      if (parts.length === 2) {
        const token = decodeURIComponent(parts[1]); // usually the UID / safeDoor

        // Try new index first (note: keys are currently stored as index:..., so this is fallback-only)
        const indexKey = `doorIndex:${token}`;
        const mappingJson = await env.REPORTS_KV.get(indexKey, "text");

        let redirectUrl;

        if (mappingJson) {
          // New style – we know business/building/slug
          const mapping = JSON.parse(mappingJson);
          redirectUrl = `${url.origin}/reports/${encodeURIComponent(
            mapping.businessCode
          )}/${encodeURIComponent(mapping.buildingCode)}/${encodeURIComponent(
            mapping.doorSlug
          )}`;
        } else {
          // Legacy fallback – old behavior
          redirectUrl = `${url.origin}/reports/${encodeURIComponent(token)}`;
        }

        return Response.redirect(redirectUrl, 302);
      }
    }

    // =====================================================================
    //  GET /reports (public door page with building-wide door list)
    // =====================================================================   
    if (req.method === "GET" && pathname.startsWith("/reports/")) {
      const parts = pathname.split("/").filter(Boolean); // ["reports", ...]
      if (parts[0] !== "reports") return text("Not found", 404);

      const scope = url.searchParams.get("scope");
      const scopeAll = scope === "all";
    
      let doorId;
      let business = "";
      let building = "";
      let businessCode;
      let buildingCode;
      let doorSlug;
      let doorRec = null; // <-- ADD THIS

// Shape A: /reports/:businessCode/:buildingCode/:doorSlug
if (parts.length === 4) {
  businessCode = decodeURIComponent(parts[1]);
  buildingCode = decodeURIComponent(parts[2]);
  doorSlug = decodeURIComponent(parts[3]);

  const summaryJson = await env.REPORTS_KV.get(
    `door:${businessCode}:${buildingCode}:${doorSlug}`,
    "text"
  );
  if (!summaryJson) return text("Door not found", 404);

const summary = JSON.parse(summaryJson);
doorRec = summary; // keep full door record for overrides
doorRec = summary; // <-- ADD THIS
doorId = summary.doorId;
business = summary.business || "";
building = summary.building || "";

  // Canonical redirect via doorIndex:<UID>
  if (summary && summary.doorId) {
    const uid = String(summary.doorId).replace(/[^\w\-./]/g, "_");
    const map = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");

    if (map) {
      const canonical =
        `/reports/${map.businessCode}/${map.buildingCode}/${map.doorSlug}` +
        (url.search || "");

      if (url.pathname !== `/reports/${map.businessCode}/${map.buildingCode}/${map.doorSlug}`) {
        return Response.redirect(canonical, 302);
      }
    }
  }
}

// Shape B (legacy): /reports/:doorId
else if (parts.length === 2) {
  const token = decodeURIComponent(parts[1]);
  doorId = token;

  // Canonical redirect via doorIndex:<UID>
  const uid = String(doorId).replace(/[^\w\-./]/g, "_");
  const map = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");

  if (map) {
    const canonical =
      `/reports/${map.businessCode}/${map.buildingCode}/${map.doorSlug}` +
      (url.search || "");
    return Response.redirect(canonical, 302);
  }

  // If no mapping, continue legacy rendering (R2 metadata)
}

else {
  return text("Not found", 404);
}


      // Use sanitized doorId as folder prefix in R2
      const safeDoor = doorId.replace(/[^\w\-./]/g, "_");
      
      let uidHistory = null;
      // If we didn't get a door record from Shape A, try UID-first record.
// Upload path writes this as door:${safeDoor}.
if (!doorRec) {
  try {
    doorRec = await env.REPORTS_KV.get(`door:${safeDoor}`, "json");
  } catch {}
}
try {
  const raw = await env.REPORTS_KV.get(`uidEvents:${safeDoor}`, "json");
  if (Array.isArray(raw) && raw.length > 0) {
    uidHistory = raw;
  }
} catch {}

let objects = [];

if (uidHistory) {
  // UID-first history
  objects = uidHistory
    .slice()
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
} else {
  // Legacy fallback
  const list = await env.REPORTS_BUCKET.list({
    prefix: `${safeDoor}/`,
  });

  objects = list.objects
    .slice()
    .sort((a, b) => b.key.localeCompare(a.key));
}

    
      if (objects.length === 0) {
        return html(`<h1>No reports yet for ${esc(doorId)}</h1>`);
      }

      const latest = objects[0];
      const meta = latest.customMetadata || latest || {};
      // ---- normalize effective status for grouping ----
// ---- normalize effective status for grouping ----
const metaStatus = (meta.status || "").toString().trim();
const metaSeverityNum =
  meta.severity !== undefined && meta.severity !== null && meta.severity !== ""
    ? Number(meta.severity)
    : null;

// Pull admin overrides from the door KV record if present
// (Admin writes these on purpose; viewer should respect them.)
const adminStatusRaw = (doorRec && doorRec.status != null) ? String(doorRec.status).trim() : "";
const adminSeverityRaw = (doorRec && doorRec.severity != null) ? doorRec.severity : null;

// Convert adminSeverity to number if possible
const adminSeverityNum =
  adminSeverityRaw !== null && adminSeverityRaw !== undefined && adminSeverityRaw !== ""
    ? Number(adminSeverityRaw)
    : null;

// Display normalization: treat internal "Needs Repair" as customer-facing "Flagged"
const normalizeDisplayStatus = (s) => {
  const v = String(s || "").trim();
  if (!v) return "";
  if (v.toLowerCase() === "needs repair") return "Flagged";
  return v;
};

// Admin override wins (if present), otherwise metadata wins
let effectiveStatus = normalizeDisplayStatus(adminStatusRaw) || normalizeDisplayStatus(metaStatus);

// If still missing, derive from severity (admin first, then metadata)
// Canonical severity: 0=Pass, 1=Conditional Pass, 2=Flagged
if (!effectiveStatus) {
  const sev =
    (adminSeverityNum !== null && !Number.isNaN(adminSeverityNum)) ? adminSeverityNum :
    (metaSeverityNum !== null && !Number.isNaN(metaSeverityNum)) ? metaSeverityNum :
    null;

  if (sev !== null) {
    if (sev >= 2) effectiveStatus = "Flagged";
    else if (sev === 1) effectiveStatus = "Conditional Pass";
    else effectiveStatus = "Pass";
  }
}

      console.log("LATEST META", JSON.stringify(meta));

      

      // If business/building not filled yet (legacy path), use metadata
      if (!business) business = meta.business || "";
      if (!building) building = meta.building || "";

      const latestFile = latest.key
      ? latest.key.split("/").pop()
      : latest.objectKey.split("/").pop();
    
      const latestUrl = `/file/${encodeURIComponent(
        safeDoor
      )}/${encodeURIComponent(latestFile)}`;
      const viewerUrl = `/pdfviewer/${encodeURIComponent(
        safeDoor
      )}/${encodeURIComponent(latestFile)}`;

 // Build History list for the sidebar (newest → oldest)
 const historyItemsHtml = objects
 .map((o, idx) => {
   const m = o.customMetadata || o || {};
   const file = o.key
     ? o.key.split("/").pop()
     : o.objectKey.split("/").pop();
 

  const viewUrl = `/pdfviewer/${encodeURIComponent(safeDoor)}/${encodeURIComponent(file)}`;
  const dlUrl = `/file/${encodeURIComponent(safeDoor)}/${encodeURIComponent(file)}`;

  const when = m.inspectedAt || m.uploadedAt || file.replace(/\.pdf$/i, "");

  const doorLabel = (m.displayLabel || m.label || m.doorId || "").toString().trim();
  
  const statusTextRaw = (m.status || m.doorStatusRaw || "").toString().trim();
  const statusText = statusTextRaw ? statusTextRaw : "Unknown";
  
  // “actual condition” (best available from metadata)
  const conditionText =
    (typeof m.severity !== "undefined" && m.severity !== null && String(m.severity).trim() !== "")
      ? `Severity ${String(m.severity).trim()}`
      : "";
  
  const statusWithCondition = conditionText
    ? `${statusText} [${conditionText}]`
    : statusText;
  
  // optional: keep location line if you want it
  const where = [m.business, m.building].filter(Boolean).join(" • ");
  
  const loc = o.key; // “history location” in R2

  return `
  <li class="door-item history-item${idx === 0 ? " current" : ""}" data-viewer-url="${viewUrl}">
    <div class="door-label">${esc(doorLabel)} ${esc(when)} - ${esc(statusWithCondition)}</div>
    <div class="door-subline">${esc(where || "—")}</div>
    <div class="door-subline history-links">
      <a href="${viewUrl}">View</a> · <a href="${dlUrl}">Download</a>
    </div>
  </li>
`;

})
.join("");

const historySectionHtml =
  objects.length > 1
    ? `
  <div class="sidebar-section history-bottom collapsed" data-bucket="history">
    <div class="section-title">
      <span>History</span>
      <span class="section-count">${objects.length}</span>
    </div>
    <ul class="door-list">
      ${historyItemsHtml}
    </ul>
  </div>
`
    : ``;

   
            // Resolve business/building codes for KV lookup
            const businessName = business || meta.business || "";
            const buildingName = building || meta.building || "main";
      
            businessCode =
              businessCode ||
              (meta.businessCode && String(meta.businessCode)) ||
              slug(businessName);
      
            buildingCode =
              buildingCode ||
              (meta.buildingCode && String(meta.buildingCode)) ||
              slug(buildingName || "main");
      
            // -------------------------------------------------------------
            // SECURITY GATE: enforce secure mode per business
            // -------------------------------------------------------------
            let bizMode = "standard";
      
            if (businessCode) {
              const cfgRaw = await env.ENROLL_TOKENS.get(
                `bizcfg:${businessCode}`,
                "text"
              );
              if (cfgRaw) {
                try {
                  const cfg = JSON.parse(cfgRaw);
                  bizMode = cfg.mode || "standard";
                } catch (e) {
                  bizMode = "standard";
                }
              }
            }
      
            if (bizMode === "secure") {
              const cookies = parseCookies(req.headers.get("Cookie"));
              const tokenId = cookies["castle_access"];
      
              if (!tokenId) {
                return html(
                  "<h1>Access restricted</h1><p>This business requires an enrolled device. Ask your admin for an access link.</p>",
                  403
                );
              }
      
              const deviceRaw = await env.DEVICE_TOKENS.get(
                `device:${tokenId}`,
                "text"
              );
              if (!deviceRaw) {
                return html(
                  "<h1>Access restricted</h1><p>Invalid device token.</p>",
                  403
                );
              }
      
              try {
                const device = JSON.parse(deviceRaw);
                // device.biz is the slug we used in /enroll (businessCode)
                if (device.revoked || device.biz !== businessCode) {
                  return html(
                    "<h1>Access restricted</h1><p>Invalid device token.</p>",
                    403
                  );
                }
              } catch (e) {
                return html(
                  "<h1>Access restricted</h1><p>Invalid device token.</p>",
                  403
                );
              }
            }
      

        
      // ---------- Per-business secure mode gate + CTA config ----------
      // Worker B (admin) stores configs as: bizcfg:<businessCode> in ENROLL_TOKENS
      // with fields like { slug, mode, cta_enabled, cta_default_to, cta_always_cc }.
      let isSecureBiz = false;
      let bizCtaEnabled = false;
      let bizCtaDefaultTo = "";
      let bizCtaAlwaysCc = "";

      try {
        const cfgRaw = await env.ENROLL_TOKENS.get(
          `bizcfg:${businessCode}`,
          "text"
        );
        if (cfgRaw) {
          const cfg = JSON.parse(cfgRaw);
          if (cfg.mode === "secure") {
            isSecureBiz = true;
          }
          bizCtaEnabled = !!cfg.cta_enabled;
          bizCtaDefaultTo =
            typeof cfg.cta_default_to === "string" ? cfg.cta_default_to : "";
          bizCtaAlwaysCc =
            typeof cfg.cta_always_cc === "string" ? cfg.cta_always_cc : "";
        }
      } catch (e) {
        console.log("Error reading bizcfg for", businessCode, e);
      }

      if (isSecureBiz) {
        const cookies = parseCookies(req.headers.get("Cookie"));
        const deviceId = cookies["castle_access"];
        let allowed = false;

        if (deviceId) {
          const deviceKey = `device:${deviceId}`;
          const deviceJson = await env.DEVICE_TOKENS.get(deviceKey, "text");
          if (deviceJson) {
            try {
              const device = JSON.parse(deviceJson);
              // device.biz was set when this device enrolled via /enroll/:biz
              if (!device.revoked && device.biz === businessCode) {
                allowed = true;
              }
            } catch (e) {
              console.log("Error parsing device token JSON", e);
            }
          }
        }

        if (!allowed) {
          const restrictedHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Access restricted</title>
  </head>
  <body>
    <h1>Access restricted</h1>
    <p>This report is only available to authorized devices for ${esc(
      businessCode
    )}.</p>
    <p>If you should have access, please contact your administrator or maintenance manager.</p>
  </body>
</html>`;
          return html(restrictedHtml, 403);
        }
      }

      // Human-facing label + metadata line
      const displayLabel =
        meta.displayLabel || meta.label || meta.doorId || doorId;

      const title = displayLabel;

      const metaLine = [
        `Door: ${esc(displayLabel)}`,
        meta.doorId && `Door ID: ${esc(meta.doorId)}`,
        meta.business && `Business: ${esc(meta.business)}`,
        meta.building && `Building: ${esc(meta.building)}`,
        meta.status && `Status: ${esc(meta.status)}`,
      ]
        .filter(Boolean)
        .join(" • ");

// -------------------------------------------------------------
// Look up ALL doors for this business and group by building
// -------------------------------------------------------------

const allDoorPrefix = `door:${businessCode}:`;
const doorList = await env.REPORTS_KV.list({ prefix: allDoorPrefix });

// -------------------------------------------------------------
// Build Buildings sidebar using ADMIN building display names
//
// Source of truth:
//   buildingCode (stable identity)
//   bldcfg:<biz>:<buildingCode> → { name: "East Wing" }
//
// Default behavior:
//   Show uploaded building name unless admin overrides it
// -------------------------------------------------------------

const buildingsMap = new Map();
// buildingCode -> { code, name, doors: [] }

// Cache admin overrides so we don't KV-read repeatedly
const buildingNameCache = new Map();

async function getBuildingDisplayName(bizCode, bCode) {
  if (buildingNameCache.has(bCode)) {
    return buildingNameCache.get(bCode);
  }

  // Admin rename record
  const cfgKey = `bldcfg:${bizCode}:${bCode}`;
  const cfg = await env.REPORTS_KV.get(cfgKey, "json");

  let displayName = "";

  // Admin override wins if present
  if (cfg && typeof cfg.name === "string" && cfg.name.trim()) {
    displayName = cfg.name.trim();
  }

  // IMPORTANT:
  // If no admin rename exists, return blank.
  // The loop will fall back to uploaded building name.
  buildingNameCache.set(bCode, displayName);
  return displayName;
}

for (const item of doorList.keys || []) {
  try {
    const value = await env.REPORTS_KV.get(item.name, "text");
    if (!value) continue;

    const d = JSON.parse(value);

    // Stable building identity
    const bCode = d.buildingCode || "main";

    // 1) Admin override (if set)
    let bName = await getBuildingDisplayName(businessCode, bCode);

    // 2) Default fallback = uploaded building name
    if (!bName) {
      bName =
        (d.building && String(d.building).trim()) ||
        (bCode === "main" ? "Main" : "Unnamed building");
    }

    let bucket = buildingsMap.get(bCode);
    if (!bucket) {
      bucket = { code: bCode, name: bName, doors: [] };
      buildingsMap.set(bCode, bucket);
    }

    bucket.doors.push(d);
  } catch (e) {
    console.log("Error parsing door summary", item.name, e);
  }
}

const currentBuildingCode = buildingCode;
const currentBuilding =
  buildingsMap.get(currentBuildingCode) ||
  { code: currentBuildingCode, name: building || "Main", doors: [] };

// Flatten all doors once for "All buildings" mode
const allDoors = [];
for (const b of buildingsMap.values()) {
  allDoors.push(...b.doors);
}

// If scopeAll=true, use allDoors; otherwise, only this building's doors
const doors = scopeAll ? allDoors : currentBuilding.doors;

// -------------------------------------------------------------
// Compute per-building summaries for the Buildings selector
// -------------------------------------------------------------


const buildingSummaries = [];

// Global "All buildings" target door (prefer flagged > conditional > any)
let allTargetBuildingCode = null;
let allTargetSlug = null;
let allTargetPriority = 0; // 0=any, 1=conditional, 2=flagged

for (const [bCode, b] of buildingsMap.entries()) {
  const total = b.doors.length;

  let firstFlaggedSlug = null;
  let firstConditionalSlug = null;
  let firstAnySlug = null;

  for (const d of b.doors) {
  const statusNorm = (d.status || "").toString().trim().toLowerCase();

  const slugForDoor = d.doorSlug || slug(String(d.doorId || ""));

  if (!firstAnySlug) {
    firstAnySlug = slugForDoor;
  }

  // Severity is deprecated: use STATUS only
  const isFlagged =
    (statusNorm === "fail") || (statusNorm === "flagged");

  const isConditional =
    (statusNorm === "conditional pass") || (statusNorm === "conditional");

  if (isFlagged && !firstFlaggedSlug) {
    firstFlaggedSlug = slugForDoor;
  } else if (isConditional && !firstConditionalSlug) {
    firstConditionalSlug = slugForDoor;
  }

  // Global target for "All buildings"
  if (!allTargetSlug) {
    allTargetBuildingCode = bCode;
    allTargetSlug = slugForDoor;
    allTargetPriority = 0;
  }

  if (isFlagged && allTargetPriority < 2) {
    allTargetBuildingCode = bCode;
    allTargetSlug = slugForDoor;
    allTargetPriority = 2;
  } else if (isConditional && allTargetPriority < 1) {
    allTargetBuildingCode = bCode;
    allTargetSlug = slugForDoor;
    allTargetPriority = 1;
  }
}

  const targetSlug =
    firstFlaggedSlug || firstConditionalSlug || firstAnySlug || null;

  buildingSummaries.push({
    code: bCode,
    name: b.name || "Main",
    total,
    targetSlug,
    isCurrent: !scopeAll && bCode === currentBuildingCode,
  });
}

// sort buildings by name for nicer ordering
buildingSummaries.sort((a, b) =>
  (a.name || "").localeCompare(b.name || "")
);

const totalDoorsAll = allDoors.length;

function renderBuildingListHtml(buildings) {
  if (!buildings.length) {
    return '<li class="building-item empty">No buildings</li>';
  }

  return buildings
    .map((b) => {
      const nameEsc = esc(b.name || "Main");
      const count = b.total || 0;

      let href = "#";
      if (b.targetSlug) {
        // Always go to per-building view when clicking a building row.
        // Do NOT preserve ?scope=all here.
        href =
          "/reports/" +
          encodeURIComponent(businessCode) +
          "/" +
          encodeURIComponent(b.code) +
          "/" +
          encodeURIComponent(b.targetSlug);
      }

      const currentClass = b.isCurrent ? " current" : "";

      return (
        '<li class="building-item' +
        currentClass +
        '">' +
        '<a href="' +
        href +
        '">' +
        '<span class="building-name">' +
        nameEsc +
        "</span>" +
        '<span class="building-count">(' +
        String(count) +
        ")</span>" +
        "</a>" +
        "</li>"
      );
    })
    .join("");
}

const buildingsHtml = renderBuildingListHtml(buildingSummaries);

// -------------------------------------------------------------
// Group by status / severity for UI buckets
// -------------------------------------------------------------
const flaggedDoors = [];
const conditionalDoors = [];
const passedDoors = [];
const otherDoors = [];

const currentSlug = doorSlug || slug(String(doorId || ""));

let currentInFlagged = false;
let currentInConditional = false;
let currentInPassed = false;
let currentInOther = false;

for (const d of doors) {
  const label = d.displayLabel || d.label || d.doorId || "Unknown door";

  let status = (d.status || "").toString().trim();
  let severityNum = Number(d.severity);
  let sev = Number.isFinite(severityNum) ? severityNum : null;
  
  // Derive status from severity if status missing
  if (!status && sev !== null) {
    if (sev >= 2) status = "Fail";
    else if (sev === 1) status = "Conditional Pass";
    else status = "Pass";
  }
  
  const statusNorm = status.toLowerCase();
  

  const lastInspectedAt = d.lastInspectedAt || "";

  const thisBizCode = d.businessCode || businessCode;
  const thisBldCode = d.buildingCode || buildingCode;

  const targetSlug = d.doorSlug || slug(String(d.doorId || ""));
  const isCurrent =
    targetSlug === currentSlug ||
    String(d.doorId || "") === String(doorId);

  const url = `/reports/${encodeURIComponent(
    thisBizCode
  )}/${encodeURIComponent(thisBldCode)}/${encodeURIComponent(
    targetSlug
  )}${scopeAll ? "?scope=all" : ""}`;

  const doorKey =
    thisBizCode +
    ":" +
    thisBldCode +
    ":" +
    String(d.doorId || targetSlug || "");

  // compute direct PDF URL from lastReportKey
  let fileUrl = "";
  if (d.lastReportKey && typeof d.lastReportKey === "string") {
    const parts = d.lastReportKey.split("/");
    if (parts.length >= 2) {
      const folder = parts[0];
      const fname = parts.slice(1).join("/");
      fileUrl = `/file/${encodeURIComponent(
        folder
      )}/${encodeURIComponent(fname)}`;
    }
  }

  const entry = {
    label,
    status,       // keep original (trimmed)
    severity: sev, // normalized numeric severity
    lastInspectedAt,
    url,
    isCurrent,
    fileUrl,
    doorId: d.doorId || null,
    doorKey, // used by selection JS
  };

  if (sev === 2 || statusNorm === "fail" || statusNorm === "flagged") {
    if (isCurrent) currentInFlagged = true;
    flaggedDoors.push(entry);
  } else if (sev === 1 || statusNorm === "conditional pass") {
    if (isCurrent) currentInConditional = true;
    conditionalDoors.push(entry);
  } else if (sev === 0 && statusNorm === "pass") {
    if (isCurrent) currentInPassed = true;
    passedDoors.push(entry);
  } else {
    if (isCurrent) currentInOther = true;
    otherDoors.push(entry);
  }
}

const flaggedCount = flaggedDoors.length;
const conditionalCount = conditionalDoors.length;
const passedCount = passedDoors.length;
const otherCount = otherDoors.length;

function renderDoorList(list) {
  if (!list.length) {
    return '<li class="door-subline">None</li>';
  }

  return list
    .map((d) => {
      const labelEsc = esc(d.label || "");
      const statusEsc = esc(d.status || "");
      const timeEsc = d.lastInspectedAt ? " • " + esc(d.lastInspectedAt) : "";
      const currentClass = d.isCurrent ? " current" : "";

      const statusValue = (d.status || "").toString().trim().toLowerCase();

      const doorKeyValue = d.doorKey ? String(d.doorKey) : "";
      const doorKeyAttr = doorKeyValue
        ? ' data-door-key="' + esc(doorKeyValue) + '"'
        : "";

      const fileUrlAttr = d.fileUrl
        ? ' data-file-url="' + esc(d.fileUrl) + '"'
        : "";

      const doorIdValue = d.doorId ? String(d.doorId) : "";
      const doorIdAttr = doorIdValue
        ? ' data-door-id="' + esc(doorIdValue) + '"'
        : "";

      const statusAttr = statusValue
        ? ' data-status="' + esc(statusValue) + '"'
        : "";

      return (
        '<li class="door-item' +
        currentClass +
        '"' +
        fileUrlAttr +
        doorIdAttr +
        doorKeyAttr +
        statusAttr +
        ">" +
        '<div class="door-row">' +
        '<input type="checkbox" class="door-select" />' +
        '<div class="door-text">' +
        '<a href="' +
        d.url +
        '">' +
        '<div class="door-label">' +
        labelEsc +
        "</div>" +
        '<div class="door-subline">' +
        statusEsc +
        timeEsc +
        "</div>" +
        "</a>" +
        "</div>" +
        "</div>" +
        "</li>"
      );
    })
    .join("");
}
      return html(`<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>${esc(title)}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root {
            --bg: #f5f5f7;
            --panel: #ffffff;
            --border: #e5e7eb;
            --accent: #2563eb;
            --accent-soft: #dbeafe;
            --text-main: #111827;
            --text-muted: #6b7280;
          }
      
          * {
            box-sizing: border-box;
          }
      
          body {
            margin: 0;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
              sans-serif;
            background: var(--bg);
            color: var(--text-main);
          }
      
          a {
            color: var(--accent);
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
      
          .page {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
          }
      
          .page-header {
            padding: 0.75rem 1rem;
            border-bottom: 1px solid var(--border);
            background: var(--panel);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            position: sticky;
            top: 0;
            z-index: 20;
          }
      
          .header-main {
            display: flex;
            flex-direction: column;
            gap: 0.15rem;
            min-width: 0;
          }
      
          .page-title {
            font-size: 1rem;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
      
          .page-meta {
            font-size: 0.75rem;
            color: var(--text-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
      
          .header-actions {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex-shrink: 0;
          }
      
          .btn {
            border-radius: 999px;
            border: 1px solid var(--border);
            background: var(--panel);
            padding: 0.3rem 0.9rem;
            font-size: 0.8rem;
            line-height: 1.2;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.25rem;
            color: var(--text-main);
            text-decoration: none;
            white-space: nowrap;
          }
      
          .btn-primary {
            border-color: var(--accent);
            background: var(--accent);
            color: #fff;
          }
      
          .btn:hover {
            background: #f9fafb;
          }
          .btn-primary:hover {
            background: #1d4ed8;
          }
      
          .btn-small {
            padding: 0.25rem 0.7rem;
            font-size: 0.75rem;
          }
      
          .content {
            flex: 1;
            display: grid;
            grid-template-columns: 320px minmax(0, 1fr);
            min-height: 0;
          }
          .building-list {
            list-style: none;
            margin: 0 0 0.5rem;
            padding: 0;
            font-size: 0.8rem;
          }

          .building-item {
            margin-bottom: 0.15rem;
          }

          .building-item a {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.25rem 0.4rem;
            border-radius: 0.4rem;
            text-decoration: none;
            color: inherit;
          }

          .building-item a:hover {
            background: var(--accent-soft);
          }

          .building-item.current a {
            background: var(--accent-soft);
            border: 1px solid var(--accent);
          }

          .building-name {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .building-count {
            font-size: 0.75rem;
            color: var(--text-muted);
            margin-left: 0.25rem;
          }

          .sidebar {
            border-right: 1px solid var(--border);
            background: var(--panel);
            padding: 0.75rem;
            overflow-y: auto;
          
            display: flex;
            flex-direction: column;
          }
          
      
          .sidebar-section {
            margin-bottom: 0.75rem;
          }
          .sidebar-section.history-bottom {
            margin-top: auto;
          }
          
          .sidebar-selected {
            display: none; /* toggled by JS */
            justify-content: flex-end;
            align-items: center;
            margin-bottom: 0.5rem;
          }
      
          .section-title {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-muted);
            margin: 0 0 0.35rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
          }
      
          .section-title::before {
            content: "▾";
            font-size: 1.15rem;    /* bigger caret */
            padding-left: 0.35rem; /* pull it away from edge */
            padding-right: 0.55rem;
            line-height: 1;
            transition: transform 0.15s ease-out;
          }
      
          .sidebar-section.collapsed .section-title::before {
            transform: rotate(-90deg);
          }
      
          .sidebar-section.collapsed .door-list {
            display: none;
          }
      
          .section-count {
            font-weight: 500;
            color: var(--text-muted);
          }
      
          .door-list {
            list-style: none;
            margin: 0;
            padding: 0;
            font-size: 0.8rem;
          }
      
          .door-item {
            padding: 0.3rem 0.4rem;
            border-radius: 0.4rem;
            display: flex;
            flex-direction: column;
            gap: 0.1rem;
            cursor: pointer;
          }
      
          .door-item:hover {
            background: var(--accent-soft);
          }
      
          .door-item.current {
            background: var(--accent-soft);
            border: 1px solid var(--accent);
          }
      
          .door-label {
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
      
          .door-subline {
            font-size: 0.7rem;
            color: var(--text-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
      
          .viewer {
            padding: 0.75rem;
            min-width: 0;
            min-height: 0;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          
          .viewer-meta {
            font-size: 0.75rem;
            color: var(--text-muted);
          }
          
          .pdf-shell {
            border-radius: 0.75rem;
            border: 1px solid var(--border);
            background: #000;
            overflow: hidden;
            flex: 1;
            min-height: 0;
            display: flex;
          }
          
          .pdf-frame {
            border: none;
            width: 100%;
            height: 100%;
            display: block;
            background: #fff;
          }
          
          /* no separate viewer toolbar anymore */
          .viewer-toolbar {
            display: none;
          }

          /* shared helpers */
          .sidebar-controls {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 0.5rem;
          }
      
          .door-row {
            display: flex;
            align-items: flex-start;
            gap: 0.4rem;
          }
      
          .door-select {
            margin-top: 0.2rem;
            margin-left: 0.6rem;
            margin-right: 0.35rem;
            flex-shrink: 0;
            transform: scale(1.25); /* larger tap target */
          }
      
          .door-text {
            flex: 1;
            min-width: 0;
          }
      
          .door-text a {
            text-decoration: none;
            color: inherit;
            display: block;
          }
      
          .section-tools {
            display: inline-flex;
            align-items: center;
            gap: 0.3rem;
          }
      
          .icon-button {
            border: none;
            background: transparent;
            cursor: pointer;
            padding: 0.1rem 0.2rem;
            font-size: 0.9rem;
            line-height: 1;
            color: var(--text-muted);
          }
      
          .icon-button:hover {
            color: var(--accent);
          }
      
/* MOBILE: sidebar drawer + header hamburger */
@media (max-width: 880px) {
  .content {
    grid-template-columns: minmax(0, 1fr);
  }

  /* approximate header height: adjust if you want more/less space */
  .sidebar {
    position: fixed;
    top: 3.25rem;              /* start below the header bar */
    left: 0;
    bottom: 0;
    width: 80vw;
    max-width: 360px;
    border-right: 1px solid var(--border);
    border-top: none;
    background: var(--panel);
    z-index: 40;
    padding: 0.75rem;
    overflow-y: auto;
    transform: translateX(-100%);
    transition: transform 0.2s ease-out, box-shadow 0.2s ease-out;
  }

  body.sidebar-open .sidebar {
    transform: translateX(0);
    box-shadow: 4px 0 12px rgba(15, 23, 42, 0.3);
  }

  .viewer {
    order: 1;
  }

  .pdf-shell {
    /* knock a bit more off the height since the header + gap now consume
       some vertical space – you can tweak this number if the PDF feels too tall/short */
    height: calc(100vh - 140px);
  }

  .pdf-frame {
    height: 100%;
    max-height: none;
  }
}


  .page-header {
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .header-actions {
    margin-left: auto;
  }

  .viewer-nav-toggle {
    display: inline-flex;
  }
}

/* On larger screens, hide the hamburger (sidebar is always visible) */
@media (min-width: 881px) {
  .viewer-nav-toggle {
    display: none;
  }
}

      
            .page-header {
              padding: 0.6rem 0.75rem;
            }
      
            .page-title {
              font-size: 0.95rem;
            }
      
            .page-meta {
              font-size: 0.7rem;
            }
            .history-loc { word-break: break-all; }
            .history-links a { text-decoration: none; }
            .history-links a:hover { text-decoration: underline; }
            
            /* Mobile: floating Doors hamburger – TOP LEFT, always clickable */
            .viewer-toolbar {
              display: flex;
              justify-content: flex-start;
              position: fixed;
              top: 0.75rem;
              left: 0.75rem;
              z-index: 60;
              pointer-events: none;      /* wrapper doesn't block scroll */
            }
      
            .viewer-toolbar .btn {
              pointer-events: auto;      /* button *is* clickable */
            }
          }
        </style>
      </head>
      <body>
        <div class="page">
        <header class="page-header">
        <div class="header-main">
          <div class="page-title">${esc(title)}</div>
          <div class="page-meta">${esc(metaLine)}</div>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-small viewer-nav-toggle">
            ☰ Doors
          </button>
          ${
            bizCtaEnabled
              ? '<button type="button" class="btn btn-small cta-repair">Request repair</button>' +
                '<button type="button" class="btn btn-small cta-reinspect">Request reinspection</button>'
              : ""
          }
        </div>
      </header>    
          <main class="content">
          <aside class="sidebar">
          <!-- Hidden until something is selected -->
          <div class="sidebar-selected" id="sidebar-selected" style="display:none">
            <button
              type="button"
              class="btn btn-small"
              id="download-selected"
            >
              Download selected
            </button>
          </div>

          <!-- Buildings selector -->
          <div class="sidebar-section sidebar-buildings">
            <div class="section-title">
              <span>Buildings</span>
              <span class="section-count">${totalDoorsAll}</span>
            </div>
            <ul class="building-list">
            <!-- All buildings row (only show if 2+ buildings) -->
            ${buildingSummaries.length > 1 ? `
              <li class="building-item${scopeAll ? " current" : ""}">
  <a href="${
    allTargetSlug && allTargetBuildingCode
      ? `/reports/${encodeURIComponent(
          businessCode
        )}/${encodeURIComponent(
          allTargetBuildingCode
        )}/${encodeURIComponent(allTargetSlug)}?scope=all`
      : "#"
  }">
    <span class="building-name">All buildings</span>
    <span class="building-count">(${totalDoorsAll})</span>
  </a>
</li>
` : ``}
              ${buildingsHtml}
            </ul>
          </div>
          <!-- Flagged -->
          <div class="sidebar-section" data-bucket="flagged">

                <div class="section-title">
                  <span>Flagged</span>
                  <span class="section-tools">
                    <button
                      type="button"
                      class="icon-button download-bucket"
                      data-bucket="flagged"
                      title="Download all flagged"
                    >
                      ⬇
                    </button>
                    <span class="section-count">${flaggedCount}</span>
                  </span>
                </div>
                <ul class="door-list">
                  ${renderDoorList(flaggedDoors)}
                </ul>
              </div>
      
              <!-- Conditional Pass -->
              <div class="sidebar-section" data-bucket="conditional">
                <div class="section-title">
                  <span>Conditional Pass</span>
                  <span class="section-tools">
                    <button
                      type="button"
                      class="icon-button download-bucket"
                      data-bucket="conditional"
                      title="Download all conditional pass"
                    >
                      ⬇
                    </button>
                    <span class="section-count">${conditionalCount}</span>
                  </span>
                </div>
                <ul class="door-list">
                  ${renderDoorList(conditionalDoors)}
                </ul>
              </div>
      
              <!-- Passed -->
              <div class="sidebar-section${currentInPassed ? "" : " collapsed"}" data-bucket="passed">
                <div class="section-title">
                  <span>Passed</span>
                  <span class="section-tools">
                    <button
                      type="button"
                      class="icon-button download-bucket"
                      data-bucket="passed"
                      title="Download all passed"
                    >
                      ⬇
                    </button>
                    <span class="section-count">${passedCount}</span>
                  </span>
                </div>
                <ul class="door-list">
                  ${renderDoorList(passedDoors)}
                </ul>
              </div>
      
              <!-- Other / Unknown -->
              <div class="sidebar-section" data-bucket="other">
                <div class="section-title">
                  <span>Other / Unknown status</span>
                  <span class="section-tools">
                    <button
                      type="button"
                      class="icon-button download-bucket"
                      data-bucket="other"
                      title="Download all other / unknown"
                    >
                      ⬇
                    </button>
                    <span class="section-count">${otherCount}</span>
                  </span>
                </div>
                <ul class="door-list">
                  ${renderDoorList(otherDoors)}
                </ul>
              </div>
              ${historySectionHtml}
            </aside>
      
            <section class="viewer">
            <div class="viewer-meta">
              Viewing door: ${esc(title)}
            </div>
            <div class="pdf-shell">
            <iframe id="pdf-frame" src="${viewerUrl}" class="pdf-frame" title="Door report PDF"></iframe>
            </div>
          </section>          
          </main>
        </div>
      
        <script>
        window.__DOOR_CTX = ${JSON.stringify({
          // slugs / codes
          businessCode,
          buildingCode,
          doorId,
          doorSlug,

          // human labels
          businessLabel: business,
          buildingLabel: buildingCode,
          doorLabel: displayLabel,
          doorStatus: (meta && meta.status) || "",

          // CTA settings
          bizCtaEnabled,
          bizCtaDefaultTo,
          bizCtaAlwaysCc,
        })};
        document.addEventListener("DOMContentLoaded", function () {
          // Per-business+building key for section collapsed state
          var sectionStateKey =
            "doorSectionState:" +
            ${JSON.stringify(businessCode)} +
            ":" +
            ${JSON.stringify(buildingCode)};

          function loadSectionState() {
            try {
              var raw = localStorage.getItem(sectionStateKey);
              if (!raw) return {};
              var obj = JSON.parse(raw);
              return obj && typeof obj === "object" ? obj : {};
            } catch (e) {
              console.log("Error loading section state", e);
              return {};
            }
          }

          function saveSectionState(state) {
            try {
              localStorage.setItem(sectionStateKey, JSON.stringify(state));
            } catch (e) {
              console.log("Error saving section state", e);
            }
          }

          var sectionState = loadSectionState();

          // Apply saved section collapsed/expanded state on load
          document
            .querySelectorAll(".sidebar-section")
            .forEach(function (section) {
              var bucket = section.getAttribute("data-bucket");
              if (!bucket) return;

              if (sectionState[bucket] === true) {
                section.classList.add("collapsed");
              } else if (sectionState[bucket] === false) {
                section.classList.remove("collapsed");
              }
              // if undefined, keep whatever the server default was
            });
            var pdfFrame = document.getElementById("pdf-frame");
            if (pdfFrame) {
              document.querySelectorAll(".history-item").forEach(function (li) {
                li.addEventListener("click", function (e) {
                  if (e.target && e.target.closest("a")) return;
            
                  var url = li.getAttribute("data-viewer-url");
                  if (!url) return;
            
                  pdfFrame.src = url;
            
                  document.querySelectorAll(".history-item.current").forEach(function (x) {
                    x.classList.remove("current");
                  });
                  li.classList.add("current");
            
                  if (window.innerWidth <= 880) {
                    document.body.classList.remove("sidebar-open");
                  }
                });
              });
            }
            
          // Collapse / expand sections + persist state per bucket
          document
            .querySelectorAll(".sidebar-section .section-title")
            .forEach(function (titleEl) {
              titleEl.addEventListener("click", function (e) {
                // Don't collapse if they clicked a download icon
                if (e.target.closest(".download-bucket")) return;

                var section = titleEl.closest(".sidebar-section");
                if (!section) return;
                section.classList.toggle("collapsed");

                var bucket = section.getAttribute("data-bucket");
                if (!bucket) return;
                sectionState[bucket] = section.classList.contains("collapsed");
                saveSectionState(sectionState);
              });
            });

          // Per-business selection key (checkbox selection shared across buildings)
          var selectionKey =
            "doorSelection:" + ${JSON.stringify(businessCode)};


      
            // Remember sidebar (doors drawer) open/closed per building
            var sidebarStateKey =
              "doorSidebarOpen:" +
              ${JSON.stringify(businessCode)} +
              ":" +
              ${JSON.stringify(buildingCode)};
      
            function loadSidebarOpen() {
              try {
                return localStorage.getItem(sidebarStateKey) === "1";
              } catch (e) {
                console.log("Error loading sidebar state", e);
                return false;
              }
            }
      
            function saveSidebarOpen(isOpen) {
              try {
                localStorage.setItem(sidebarStateKey, isOpen ? "1" : "0");
              } catch (e) {
                console.log("Error saving sidebar state", e);
              }
            }
      
            function loadSelection() {
              try {
                var raw = localStorage.getItem(selectionKey);
                if (!raw) return new Set();
                var arr = JSON.parse(raw);
                if (!Array.isArray(arr)) return new Set();
                return new Set(arr);
              } catch (e) {
                console.log("Error loading selection", e);
                return new Set();
              }
            }
      
            function saveSelection(set) {
              try {
                var arr = Array.from(set);
                localStorage.setItem(selectionKey, JSON.stringify(arr));
              } catch (e) {
                console.log("Error saving selection", e);
              }
            }
      
            var selectedIds = loadSelection();
      
            // Restore sidebar state on load (mobile)
            var initialSidebarOpen = loadSidebarOpen();
            if (initialSidebarOpen && window.innerWidth <= 880) {
              document.body.classList.add("sidebar-open");
            }
      
            // Banner: Download selected (N)
            var bannerEl = document.getElementById("sidebar-selected");
            var bannerBtn = document.getElementById("download-selected");
      
            function updateSelectedBanner() {
              if (!bannerEl || !bannerBtn) return;
              var count = selectedIds.size;
              if (!count) {
                bannerEl.style.display = "none";
                return;
              }
              bannerEl.style.display = "flex";
              bannerBtn.textContent =
                count === 1 ? "Download selected" : "Download selected (" + count + ")";
            }
      
            // Apply selection to checkboxes and wire change events
document.querySelectorAll(".door-item").forEach(function (li) {
  var doorKey = li.getAttribute("data-door-key");
  if (!doorKey) return;
  var checkbox = li.querySelector(".door-select");
  if (!checkbox) return;

  if (selectedIds.has(doorKey)) {
    checkbox.checked = true;
  }

  checkbox.addEventListener("change", function () {
    if (checkbox.checked) {
      selectedIds.add(doorKey);
    } else {
      selectedIds.delete(doorKey);
    }
    saveSelection(selectedIds);
    updateSelectedBanner();
  });
});

      
            // Initial banner state after we've applied selections
            updateSelectedBanner();
      
            // Collect URLs for a specific bucket (flagged/conditional/passed/other)
            // Collect URLs for a specific bucket (flagged/conditional/passed/other)
function collectBucketUrls(bucket) {
  var urls = [];
  document.querySelectorAll(".door-item").forEach(function (li) {
    var fileUrl = li.getAttribute("data-file-url");
    if (!fileUrl) return;

    var status = (li.getAttribute("data-status") || "").toLowerCase();

    var isFlagged = status === "fail" || status === "flagged" || status === "needs repair";
    var isCond = status === "conditional pass";
    var isPass = status === "pass";
    var isOther = !isFlagged && !isCond && !isPass;

    if (bucket === "flagged" && !isFlagged) return;
    if (bucket === "conditional" && !isCond) return;
    if (bucket === "passed" && !isPass) return;
    if (bucket === "other" && !isOther) return;

    urls.push(fileUrl);
  });
  return urls;
}
      
            // Collect URLs for currently selected doors
            function collectSelectedUrls() {
              var urls = [];
              if (!selectedIds.size) return urls;
            
              document.querySelectorAll(".door-item").forEach(function (li) {
                var doorKey = li.getAttribute("data-door-key");
                if (!doorKey || !selectedIds.has(doorKey)) return;
                var fileUrl = li.getAttribute("data-file-url");
                if (!fileUrl) return;
                urls.push(fileUrl);
              });
              return urls;
            }
            
      
            function startDownloads(urls) {
              if (!urls.length) return;
      
              urls.forEach(function (url, idx) {
                setTimeout(function () {
                  var a = document.createElement("a");
                  a.href = url;
                  a.download = ""; // let browser use filename from URL
                  a.rel = "noopener";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                }, idx * 200); // stagger to avoid blocking
              });
            }
      
            // Wire up per-section download icons
            document.querySelectorAll(".download-bucket").forEach(function (btn) {
              btn.addEventListener("click", function (e) {
                e.stopPropagation();
                var bucket = btn.getAttribute("data-bucket");
                if (!bucket) return;
                var urls = collectBucketUrls(bucket);
                startDownloads(urls);
              });
            });
      
            // Wire up "Download selected" banner button
            if (bannerBtn) {
              bannerBtn.addEventListener("click", function () {
                var urls = collectSelectedUrls();
                startDownloads(urls);
              });
            }
            // CTA buttons in header (if CTA is enabled)
            document.querySelectorAll(".cta-repair").forEach(function (btn) {
              btn.addEventListener("click", function () {
                if (window.__startCtaRequest) {
                  window.__startCtaRequest("repair");
                }
              });
            });
            document.querySelectorAll(".cta-reinspect").forEach(function (btn) {
              btn.addEventListener("click", function () {
                if (window.__startCtaRequest) {
                  window.__startCtaRequest("reinspect");
                }
              });
            });

            // CTA request flow (repair / reinspect)
            function startCtaRequest(kind) {
              var ctx = window.__DOOR_CTX || {};
              if (!ctx.bizCtaEnabled) {
                alert("Requests are not enabled for this business.");
                return;
              }

              var actionLabel = kind === "repair" ? "repair" : "reinspection";

              var who =
                window.prompt("Who is requesting this " + actionLabel + "? (name)", "") || "";
              if (!who) {
                return;
              }

              var requesterEmail =
                window.prompt("Your email (optional):", "") || "";

              var sendToOverride =
                window.prompt(
                  "Email to send this request to (leave blank to use the business default):",
                  ""
                ) || "";

              var notes =
                window.prompt(
                  "Notes for this request (optional):",
                  ""
                ) || "";

                var payload = {
                  kind: kind,
  
                  // codes
                  businessCode: ctx.businessCode || "",
                  buildingCode: ctx.buildingCode || "",
                  doorId: ctx.doorId || "",
                  doorSlug: ctx.doorSlug || "",
  
                  // human labels
                  businessLabel: ctx.businessLabel || "",
                  buildingLabel: ctx.buildingLabel || "",
                  doorLabel: ctx.doorLabel || "",
                  doorStatus: ctx.doorStatus || "",
  
                  // requester info
                  requesterName: who,
                  requesterEmail: requesterEmail,
                  sendToOverride: sendToOverride,
                  notes: notes,
                };
  

              fetch("/api/cta-request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              })
                .then(function (res) {
                  if (!res.ok) throw new Error("HTTP " + res.status);
                  return res.json();
                })
                .then(function () {
                  alert("Request sent. We will review it soon.");
                })
                .catch(function (err) {
                  console.log("CTA request error", err);
                  alert(
                    "There was a problem sending the request. Please try again later."
                  );
                });
            }

            window.__startCtaRequest = startCtaRequest;

            // Mobile sidebar toggle (slide-in drawer)
            var navToggle = document.querySelector(".viewer-nav-toggle");
            if (navToggle) {

              navToggle.addEventListener("click", function (e) {
                e.stopPropagation();
                var willOpen = !document.body.classList.contains("sidebar-open");
                document.body.classList.toggle("sidebar-open");
                saveSidebarOpen(willOpen);
              });
            }
      
            // Click outside sidebar closes it on mobile
            document.addEventListener("click", function (e) {
              if (!document.body.classList.contains("sidebar-open")) return;
              var sidebarEl = document.querySelector(".sidebar");
              if (!sidebarEl) return;
              if (e.target.closest(".sidebar") || e.target.closest(".viewer-nav-toggle")) {
                return;
              }
              document.body.classList.remove("sidebar-open");
              saveSidebarOpen(false);
            });
          });
        </script>
      </body>
      </html>`);
      
    }
     // =====================================================================
    //  POST /api/cta-request  (store CTA + send email via Resend)
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/cta-request") {
      let body;
      try {
        body = await req.json();
      } catch (e) {
        return json({ error: "Bad JSON" }, 400);
      }

      const kind            = (body.kind || "").toString();
      const businessCode    = (body.businessCode || "").toString();
      const buildingCode    = (body.buildingCode || "").toString();
      const doorId          = (body.doorId || "").toString();
      const doorSlug        = (body.doorSlug || "").toString();
      const requesterName   = (body.requesterName || "").toString();
      const requesterEmail  = (body.requesterEmail || "").toString();
      const sendToOverride  = (body.sendToOverride || "").toString();
      const notes           = (body.notes || "").toString();

      const businessLabel   = (body.businessLabel || "").toString();
      const buildingLabel   = (body.buildingLabel || "").toString();
      const doorLabel       = (body.doorLabel || "").toString();
      const doorStatus      = (body.doorStatus || "").toString();

      if (!kind || !businessCode || (!doorId && !doorSlug)) {
        return json({ error: "Missing required fields" }, 400);
      }

      // Confirm business exists and CTA is enabled
      const cfgRaw = await env.ENROLL_TOKENS.get(
        `bizcfg:${businessCode}`,
        "text"
      );
      if (!cfgRaw) {
        return json({ error: "Unknown business" }, 400);
      }

      let cfg;
      try {
        cfg = JSON.parse(cfgRaw);
      } catch {
        cfg = {};
      }

      if (!cfg.cta_enabled) {
        return json({ error: "CTA disabled for this business" }, 403);
      }

      const now = Date.now();
      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      const key = `cta:${businessCode}:${id}`;

      // Store in KV for history
      const record = {
        id,
        kind,
        businessCode,
        buildingCode,
        doorId,
        doorSlug,
        businessLabel,
        buildingLabel,
        doorLabel,
        doorStatus,
        requesterName,
        requesterEmail,
        sendToOverride,
        notes,
        createdAt: now,
      };
      await env.REPORTS_KV.put(key, JSON.stringify(record));

      // Fire-and-forget email via Resend
      const sendEmail = async () => {
        try {
          const apiKey = env.RESEND_API_KEY;
          const from   = env.RESEND_FROM;
          if (!apiKey || !from) {
            console.log("Resend not configured (missing RESEND_API_KEY or RESEND_FROM)");
            return;
          }

          // Decide who to send to
          const primaryTo = (sendToOverride || cfg.cta_default_to || "").trim();
          const fallbackTo = (env.RESEND_FALLBACK_TO || "").trim();
          const to = [];
          if (primaryTo) {
            to.push(primaryTo);
          } else if (fallbackTo) {
            to.push(fallbackTo);
          }

          if (!to.length) {
            console.log("CTA request has no destination email; skipping send");
            return;
          }

          // CC list from biz config
          const cc = [];
          if (typeof cfg.cta_always_cc === "string" && cfg.cta_always_cc.trim()) {
            cfg.cta_always_cc.split(",").forEach((addr) => {
              const t = addr.trim();
              if (t) cc.push(t);
            });
          }

          const kindLabel =
            kind === "repair"
              ? "Repair"
              : kind === "reinspect"
              ? "Reinspection"
              : kind;

          const bizName =
            businessLabel || businessCode || "(unknown business)";
          const bldgName =
            buildingLabel || buildingCode || "(unknown building)";
          const doorName =
            doorLabel || doorId || doorSlug || "(unknown door)";
          const statusText = doorStatus || "";

          const subject =
            "[Door CTA] " +
            kindLabel +
            " – " +
            bizName +
            " – " +
            bldgName +
            " – " +
            doorName;

          const safeNotes = notes || "(none)";
          const safeRequester =
            requesterName && requesterName.trim()
              ? requesterName.trim()
              : "(unknown requester)";
          const safeRequesterEmail =
            requesterEmail && requesterEmail.trim()
              ? requesterEmail.trim()
              : "(no email provided)";

          // Link back to the door report (best-effort)
          const origin = new URL(req.url).origin;
          let doorPath = "";
          if (businessCode && (doorSlug || doorId)) {
            doorPath =
              "/reports/" +
              encodeURIComponent(businessCode) +
              "/" +
              encodeURIComponent(buildingCode || "main") +
              "/" +
              encodeURIComponent(doorSlug || "");
          }
          const doorUrl = doorPath ? origin + doorPath : "";

          const html = `
          <div style="font-family: system-ui, sans-serif; color: #222; line-height: 1.45;">
            
            <h2 style="margin-bottom: 0.3em;">
              ${kindLabel} Request – ${doorName}
            </h2>
            <div style="font-size: 14px; color: #555;">
              ${bizName} • ${bldgName}
            </div>

            <hr style="margin: 1em 0; border: none; border-top: 1px solid #ddd;" />

            <p>A ${kindLabel.toLowerCase()} request was submitted for the door below:</p>

            <ul>
              <li><strong>Business:</strong> ${bizName} ${businessCode ? `(${businessCode})` : ""}</li>
              <li><strong>Building:</strong> ${bldgName} ${buildingCode ? `(${buildingCode})` : ""}</li>
              <li><strong>Door:</strong> ${doorName} ${doorSlug ? `(${doorSlug})` : ""}</li>
              ${statusText ? `<li><strong>Status:</strong> ${statusText}</li>` : ""}
              <li><strong>Requester:</strong> ${safeRequester} &lt;${safeRequesterEmail}&gt;</li>
            </ul>

            <h3 style="margin-top: 1em;">Notes</h3>
            <pre style="
              background: #f8f8f8;
              padding: 10px;
              border-radius: 6px;
              white-space: pre-wrap;
              font-family: system-ui, sans-serif;
            ">${safeNotes}</pre>

            ${
              doorUrl
                ? `
                  <p style="margin-top: 1.5em;">
                    <a href="${doorUrl}"
                      style="
                        display: inline-block;
                        padding: 10px 14px;
                        background: #2b5cff;
                        color: #fff;
                        border-radius: 6px;
                        text-decoration: none;
                        font-weight: 600;
                      ">View Full Door Report</a>
                  </p>
                `
                : ""
            }

            <p style="margin-top: 1.5em; font-size: 12px; color: #999;">
              Request ID: ${id}
            </p>
          </div>
        `;


          const payload = { from, to, subject, html };
          if (cc.length) payload.cc = cc;

          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const bodyText = await res.text();
            console.log("Resend error", res.status, bodyText);
          }
        } catch (err) {
          console.log("Error sending CTA email via Resend:", err);
        }
      };

      ctx.waitUntil(sendEmail());

      return json({ ok: true, id });
    }
// =====================================================
// DEBUG: GET /__debug/door?uid=XXXX
// Shows doorIndex mapping + resolved door summary record
// =====================================================
if (req.method === "GET" && pathname === "/__debug/door") {
  const uidRaw = String(url.searchParams.get("uid") || "").trim();
  if (!uidRaw) return text("uid required", 400);

  const safeDoor = uidRaw.replace(/[^\w\-./]/g, "_");

  const mapping = await env.REPORTS_KV.get(`doorIndex:${safeDoor}`, "json");
  if (!mapping) {
    return json({ ok: false, uid: safeDoor, error: "doorIndex not found" }, 404);
  }

  const doorKey = `door:${mapping.businessCode}:${mapping.buildingCode}:${mapping.doorSlug}`;
  const rec = await env.REPORTS_KV.get(doorKey, "json");

  return json({
    ok: true,
    uid: safeDoor,
    doorIndexKey: `doorIndex:${safeDoor}`,
    mapping,
    doorKey,
    doorSummary: rec || null,
    summaryStatus: rec?.status ?? null,
    summarySeverity: rec?.severity ?? null,
  });
}
    // Fallback 404
    return text("Not found", 404);
  },
};
