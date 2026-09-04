export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ---------- helpers ----------
    const text = (s, status = 200, extraHeaders = {}) =>
      new Response(s, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8", ...extraHeaders },
      });

    const json = (o, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(o, null, 2), {
        status,
        headers: { "content-type": "application/json", ...extraHeaders },
      });

    const html = (s, status = 200, extraHeaders = {}) =>
      new Response(s, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
      });

    const slug = (s = "") =>
      String(s || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unknown";

    // Must match reports-worker UID sanitizer (doorIndex:<safeDoor>)
    const safeDoorId = (s = "") => String(s || "").replace(/[^\w\-./]/g, "_");

    const esc = (s = "") =>
      String(s || "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[ch]));

    const parseCookies = (header) => {
      const out = {};
      if (!header) return out;
      header.split(";").forEach((part) => {
        const idx = part.indexOf("=");
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (!k) return;
        out[k] = decodeURIComponent(v);
      });
      return out;
    };

    const requireAdmin = () => {
      const cookies = parseCookies(request.headers.get("Cookie"));
      if (cookies["admin_auth"] === "ok") return null;
      const loginUrl = new URL("/admin/login", url.origin);
      return Response.redirect(loginUrl.toString(), 302);
    };

    const setCookie = (name, value) => {
      // Cross-subdomain admin auth so admin->reports viewer flow keeps session.
      const configuredDomain = String(env.ADMIN_COOKIE_DOMAIN || "").trim();
      const host = String(url.hostname || "").toLowerCase();
      const inferredDomain = host.endsWith(".castledoorict.com") || host === "castledoorict.com"
        ? ".castledoorict.com"
        : "";
      const domain = configuredDomain || inferredDomain;
      const domainAttr = domain ? `; Domain=${domain}` : "";
      return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure${domainAttr}`;
    };

    const readJsonBody = async () => {
      const ct = request.headers.get("content-type") || "";
      if (!ct.includes("application/json")) return null;
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

    const isValidEmail = (value = "") =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

    // Constant-time compare so a wrong admin key doesn't leak match-length via response timing.
    const timingSafeEqual = (a = "", b = "") => {
      const sa = String(a);
      const sb = String(b);
      if (sa.length !== sb.length) return false;
      let diff = 0;
      for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
      return diff === 0;
    };

    const normalizePortalRole = (value = "") => {
      const role = String(value || "").trim().toLowerCase();
      return role === "manager" ? "manager" : "member";
    };

    const splitEmailList = (value = "") =>
      String(value || "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
        .filter((x, i, arr) => arr.indexOf(x) === i);

    const getPortalOrigin = () => {
      const explicit = String(env.PORTAL_ORIGIN || "").trim();
      const fallback = "https://castledoorict.com";
      const candidate = explicit
        ? (/^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`)
        : fallback;

      try {
        return new URL(candidate).origin;
      } catch {
        return fallback;
      }
    };

    const getPortalCanonicalHosts = () => {
      const origin = getPortalOrigin();
      let host = "castledoorict.com";
      try {
        host = new URL(origin).hostname.toLowerCase();
      } catch {
        host = "castledoorict.com";
      }
      return {
        exact: host,
        www: `www.${host}`,
      };
    };

    const getReportsOrigin = () => {
      const explicit = String(env.REPORTS_ORIGIN || "").trim();
      const fallback = "https://r.castledoorict.com";
      const candidate = explicit
        ? (/^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`)
        : fallback;

      try {
        return new URL(candidate).origin;
      } catch {
        return fallback;
      }
    };

    const sendPortalInviteEmail = async ({
      toEmail,
      biz,
      role,
      inviteUrl = "",
      directSignInUrl = "",
      inviter = "Castle Door",
    }) => {
      const to = String(toEmail || "").trim().toLowerCase();
      if (!to) {
        return { attempted: false, sent: false, reason: "no_recipient" };
      }
      if (!isValidEmail(to)) {
        return { attempted: false, sent: false, reason: "invalid_recipient" };
      }

      const apiKey = String(env.RESEND_API_KEY || "").trim();
      const from = String(env.RESEND_FROM || "").trim();
      if (!apiKey || !from) {
        return { attempted: false, sent: false, reason: "resend_not_configured" };
      }

      const roleLabel = String(role || "member").trim().toLowerCase() === "manager" ? "manager" : "member";
      const bizCode = String(biz || "").trim();

      const ctaUrl = String(directSignInUrl || inviteUrl || "").trim();
      const isDirect = !!String(directSignInUrl || "").trim();
      const payload = {
        from,
        to: [to],
        subject: isDirect
          ? `Castle Door sign-in link (${bizCode})`
          : `Castle Door portal invite link (${bizCode})`,
        html:
          `<p>You were ${isDirect ? "granted" : "invited to"} Castle Door customer portal access for <strong>${esc(bizCode)}</strong>.</p>` +
          `<p>Role: <strong>${esc(roleLabel)}</strong></p>` +
          `<p><a href="${esc(ctaUrl)}">${isDirect ? "Sign in to dashboard" : "Accept portal invite"}</a></p>` +
          `<p>No business code is required. Use the link from this email to sign in.</p>` +
          `<p>If your email has access to multiple businesses, you can switch businesses inside the portal.</p>` +
          `<p>This ${isDirect ? "sign-in" : "invite"} link may expire. If it does, request a new link.</p>` +
          `<p>Sent by ${esc(inviter)}.</p>`,
      };

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          return { attempted: true, sent: false, reason: "resend_rejected", status: res.status };
        }

        return { attempted: true, sent: true, status: res.status };
      } catch (e) {
        return { attempted: true, sent: false, reason: "send_error", message: String(e && e.message ? e.message : e) };
      }
    };

    const hasActivePortalManager = async (biz) => {
      const code = slug(biz || "");
      if (!code || code === "unknown") return false;

      let cursor;
      do {
        const listed = await env.ENROLL_TOKENS.list({
          prefix: `portalMember:${code}:`,
          cursor,
        });

        for (const k of listed.keys || []) {
          const row = await env.ENROLL_TOKENS.get(k.name, "json");
          if (!row || typeof row !== "object") continue;
          if (row.active === false) continue;
          if (normalizePortalRole(row.role || "member") === "manager") return true;
        }

        cursor = listed.cursor;
      } while (cursor);

      return false;
    };

    const mapWithConcurrency = async (items, worker, chunkSize = 25) => {
      const out = [];
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const rows = await Promise.all(chunk.map(worker));
        out.push(...rows);
      }
      return out;
    };

    const ADMIN_BIZ_SNAPSHOT_KEY = "adminSnapshot:businesses:v1";
    const isStatusDebug = String(env.DEBUG_STATUS || "") === "1";
    const statusDebug = (...args) => {
      if (isStatusDebug) console.log("[admin-status-debug]", ...args);
    };

    const normalizeBizRow = (name, cfg = {}) => {
      const s = cfg.slug || (name.startsWith("bizcfg:") ? name.slice("bizcfg:".length) : "");
      const rawMode = String(cfg.mode || "standard").toLowerCase();
      const mode =
        rawMode === "secure" || rawMode === "public" || rawMode === "standard"
          ? rawMode
          : "standard";
      return {
        slug: s,
        name: cfg.name || s,
        active: cfg.active !== false,
        merged_into: cfg.merged_into || "",
        mode,
        sandbox_demo: cfg.sandbox_demo === true,
        public_comment_auto_approve: cfg.public_comment_auto_approve === true,
      };
    };

    const BUSINESS_NAME_MIME_RE = /=\?[^?]+\?[bqBQ]\?[^?]+\?=/;
    const isMimeGarbageBusinessName = (value = "") => {
      const textValue = String(value || "").trim();
      if (!textValue) return false;
      if (BUSINESS_NAME_MIME_RE.test(textValue)) return true;

      const lowered = textValue.toLowerCase();
      return lowered.startsWith("=?utf-8?") || lowered.includes("?b?") || lowered.includes("?=");
    };
    const sanitizeBusinessNameForOutput = (name, fallbackSlug = "") => {
      const safeFallback = String(fallbackSlug || "").trim();
      const rawName = String(name || "").trim();
      return rawName && !isMimeGarbageBusinessName(rawName) ? rawName : safeFallback;
    };
    const sanitizeBusinessRowForOutput = (row = {}) => {
      const slugValue = String(row && row.slug ? row.slug : "").trim();
      return {
        ...row,
        name: sanitizeBusinessNameForOutput(row && row.name, slugValue),
      };
    };

    const buildBusinessesLive = async () => {
      const list = await env.ENROLL_TOKENS.list({ prefix: "bizcfg:" });
      const keys = list.keys.map((k) => k.name);

      const rows = await mapWithConcurrency(
        keys,
        async (name) => {
          const raw = await env.ENROLL_TOKENS.get(name, "text");
          if (!raw) return null;

          let cfg;
          try {
            cfg = JSON.parse(raw);
          } catch {
            cfg = {};
          }

          return normalizeBizRow(name, cfg);
        },
        40
      );

      const businesses = rows.filter(Boolean);

      // Fallback discovery: include business codes that exist in REPORTS_KV door indexes
      // even when bizcfg:<code> is missing. This keeps admin tools usable for newly
      // uploaded/reporting businesses that haven't been explicitly configured yet.
      const discoveredCodes = new Set();
      let cursor = undefined;
      let scanned = 0;
      const MAX_SCAN = 5000;

      do {
        const listed = await env.REPORTS_KV.list({ prefix: "door:", cursor, limit: 200 });
        for (const entry of listed.keys || []) {
          scanned++;
          if (scanned > MAX_SCAN) break;

          const name = String(entry.name || "");
          const segs = name.split(":");
          // door:<biz>:<building>:<slug>
          if (segs.length < 4) continue;
          const bizCode = String(segs[1] || "").trim();
          if (!bizCode) continue;
          discoveredCodes.add(bizCode);
        }
        if (scanned > MAX_SCAN) break;
        cursor = listed.cursor;
      } while (cursor);

      const existingSlugs = new Set(
        businesses
          .map((b) => String((b && b.slug) || "").trim())
          .filter(Boolean)
      );

      const missingCodes = Array.from(discoveredCodes).filter((code) => !existingSlugs.has(code));
      const discoveredRows = await mapWithConcurrency(
        missingCodes,
        async (code) => {
          let inferredName = code;
          try {
            const sample = await env.REPORTS_KV.list({ prefix: `door:${code}:`, limit: 1 });
            if (sample.keys && sample.keys.length) {
              const rec = await env.REPORTS_KV.get(sample.keys[0].name, "json");
              const candidate = String((rec && rec.business) || "").trim();
              if (candidate) inferredName = candidate;
            }
          } catch {}

          return {
            slug: code,
            name: inferredName,
            active: true,
            merged_into: "",
            mode: "standard",
            discoveredFromReports: true,
          };
        },
        20
      );

      businesses.push(...discoveredRows.filter(Boolean));

      businesses.sort((a, b) =>
        (a.name || a.slug || "").localeCompare(b.name || b.slug || "")
      );
      return businesses;
    };

    const writeBusinessesSnapshot = async (businesses) => {
      await env.ENROLL_TOKENS.put(
        ADMIN_BIZ_SNAPSHOT_KEY,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          businesses,
        })
      );
    };

    const refreshBusinessesSnapshot = async () => {
      const businesses = await buildBusinessesLive();
      await writeBusinessesSnapshot(businesses);
      return businesses;
    };

    const refreshBusinessesSnapshotInBackground = () => {
      const p = refreshBusinessesSnapshot().catch(() => null);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(p);
      }
      return p;
    };

    const MIME_WORD_RE = /=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g;

    const decodeMimeWord = (charsetRaw = "", encodingRaw = "", dataRaw = "") => {
      const charset = String(charsetRaw || "").trim().toLowerCase();
      const encoding = String(encodingRaw || "").trim().toUpperCase();
      const data = String(dataRaw || "");

      const decodeUtf8Bytes = (bytes) => {
        try {
          // Cloudflare/runtime compatibility: avoid TextDecoder options object.
          return new TextDecoder("utf-8").decode(bytes);
        } catch {
          // Fallback decoder path when TextDecoder is unavailable/restricted.
          try {
            let encoded = "";
            for (const b of bytes || []) {
              encoded += `%${b.toString(16).padStart(2, "0")}`;
            }
            return decodeURIComponent(encoded);
          } catch {
            return "";
          }
        }
      };

      try {
        if (encoding === "B") {
          const clean = data.replace(/\s+/g, "");
          const binary = atob(clean);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

          if (!charset || charset === "utf-8" || charset === "utf8") {
            return decodeUtf8Bytes(bytes);
          }

          // Minimal fallback for unknown charsets.
          return String.fromCharCode(...bytes);
        }

        if (encoding === "Q") {
          const q = data
            .replace(/_/g, " ")
            .replace(/=([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

          if (!charset || charset === "utf-8" || charset === "utf8") {
            const bytes = new Uint8Array(Array.from(q).map((ch) => ch.charCodeAt(0)));
            return decodeUtf8Bytes(bytes);
          }

          return q;
        }
      } catch {
        return "";
      }

      return "";
    };

    const extractMimeWords = (input = "") => {
      const textInput = String(input || "");
      const out = [];
      let match;
      while ((match = MIME_WORD_RE.exec(textInput)) !== null) {
        const raw = String(match[0] || "");
        const charset = String(match[1] || "");
        const encoding = String(match[2] || "");
        const payload = String(match[3] || "");
        const decoded = decodeMimeWord(charset, encoding, payload);
        out.push({ raw, charset, encoding: encoding.toUpperCase(), decoded });
      }
      MIME_WORD_RE.lastIndex = 0;
      return out;
    };

    // ---------- required bindings ----------
    // ENROLL_TOKENS is where bizcfg:* lives today
    // REPORTS_KV is where door:* and doorIndex:* live today
    if (!env.ENROLL_TOKENS) {
      return text("Missing ENROLL_TOKENS binding", 500);
    }
    if (!env.REPORTS_KV) {
      return text("Missing REPORTS_KV binding", 500);
    }

    // ===========================
    // GET /health
    // ===========================
    if (request.method === "GET" && pathname === "/health") {
      return json({ ok: true, worker: "door-admin-min", time: new Date().toISOString() });
    }

    // ===========================
    // GET /admin/diag/kv-mime-scan
    // Temporary diagnostics endpoint for suspicious MIME encoded-word content.
    // Query:
    // - ns=enroll|reports|both (default both)
    // - prefix=<kv prefix> (optional)
    // - q=<substring filter on key/value> (optional)
    // - match=mime|all (default mime)
    // - limit=<1..500> (default 100)
    // - cursor=<pagination cursor> (optional)
    // ===========================
    if (request.method === "GET" && pathname === "/admin/diag/kv-mime-scan") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const ns = String(url.searchParams.get("ns") || "both").trim().toLowerCase();
      const prefix = String(url.searchParams.get("prefix") || "");
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const matchMode = String(url.searchParams.get("match") || "mime").trim().toLowerCase();
      const rawLimit = Number(url.searchParams.get("limit") || "100");
      const cursor = String(url.searchParams.get("cursor") || "").trim() || undefined;
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(500, Math.trunc(rawLimit)))
        : 100;

      if (matchMode !== "mime" && matchMode !== "all") {
        return json({ ok: false, error: "match must be mime or all" }, 400);
      }

      const namespaces =
        ns === "enroll"
          ? ["enroll"]
          : ns === "reports"
            ? ["reports"]
            : ns === "both"
              ? ["enroll", "reports"]
              : null;

      if (!namespaces) {
        return json({ ok: false, error: "ns must be enroll, reports, or both" }, 400);
      }

      const getKv = (namespaceName) =>
        namespaceName === "enroll" ? env.ENROLL_TOKENS : env.REPORTS_KV;

      const scanSummaries = [];
      let totalScanned = 0;
      let totalHits = 0;

      // Keep work bounded when scanning both namespaces.
      const perNsLimit = namespaces.length > 1 ? Math.max(1, Math.floor(limit / namespaces.length)) : limit;

      for (const namespaceName of namespaces) {
        const kv = getKv(namespaceName);
        const listed = await kv.list({ prefix, cursor, limit: perNsLimit });
        const rows = [];

        for (const k of listed.keys || []) {
          totalScanned++;
          const keyName = String(k.name || "");
          const keyMatches = extractMimeWords(keyName).map((m) => ({ ...m, location: "key" }));

          let valueText = "";
          try {
            valueText = (await kv.get(keyName, "text")) || "";
          } catch {
            valueText = "";
          }

          const valueMatches = extractMimeWords(valueText).map((m) => ({ ...m, location: "value" }));
          const allMatches = [...keyMatches, ...valueMatches];

          if (q) {
            const hay = `${keyName}\n${String(valueText || "")}`.toLowerCase();
            if (!hay.includes(q)) continue;
          }

          if (matchMode === "mime" && !allMatches.length) continue;

          if (allMatches.length) totalHits++;
          rows.push({
            key: keyName,
            valuePreview: String(valueText || "").slice(0, 260),
            hasMimeMatch: allMatches.length > 0,
            matchCount: allMatches.length,
            matches: allMatches.slice(0, 12),
          });
        }

        scanSummaries.push({
          namespace: namespaceName,
          scanned: (listed.keys || []).length,
          hitCount: rows.length,
          cursor: listed.cursor || null,
          rows,
        });
      }

      return json({
        ok: true,
        ns,
        prefix,
        q,
        match: matchMode,
        limit,
        scannedTotal: totalScanned,
        hitTotal: totalHits,
        scans: scanSummaries,
      });
    }

    // ===========================
    // GET /admin/diag/business-code?code=<businessCode>
    // Quick visibility diagnostics across ENROLL_TOKENS + REPORTS_KV
    // ===========================
    if (request.method === "GET" && pathname === "/admin/diag/business-code") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const code = slug(url.searchParams.get("code") || "");
      if (!code || code === "unknown") {
        return json({ ok: false, error: "code query param required" }, 400);
      }

      const bizcfgKey = `bizcfg:${code}`;
      const bizcfg = await env.ENROLL_TOKENS.get(bizcfgKey, "json");

      const listedDoors = await env.REPORTS_KV.list({
        prefix: `door:${code}:`,
        limit: 100,
      });

      const sample = [];
      for (const k of (listedDoors.keys || []).slice(0, 25)) {
        const keyName = String(k.name || "");
        const rec = await env.REPORTS_KV.get(keyName, "json");
        if (!rec || typeof rec !== "object") continue;

        const uid = safeDoorId(rec.doorId || "");
        const idx = uid ? await env.REPORTS_KV.get(`doorIndex:${uid}`, "json") : null;
        const segs = keyName.split(":");
        const listedAt = {
          businessCode: segs[1] || "",
          buildingCode: segs[2] || "",
          doorSlug: segs.slice(3).join(":") || "",
        };
        const indexMatches = !!(
          idx &&
          String(idx.businessCode || "") === String(listedAt.businessCode || "") &&
          String(idx.buildingCode || "") === String(listedAt.buildingCode || "") &&
          String(idx.doorSlug || "") === String(listedAt.doorSlug || "")
        );

        sample.push({
          key: keyName,
          uid,
          label: rec.displayLabel || rec.doorLabel || rec.doorId || "",
          listedAt,
          doorIndex: idx || null,
          indexMatches,
        });
      }

      return json({
        ok: true,
        code,
        bizcfgKey,
        hasBizcfg: !!bizcfg,
        bizcfg: bizcfg || null,
        doorList: {
          scanned: (listedDoors.keys || []).length,
          hasMore: !!listedDoors.cursor,
        },
        sample,
      });
    }

    // ===========================
    // Portal-route safety redirects
    // If invite/magic links ever hit admin host, bounce to portal host.
    // ===========================
    const portalHosts = getPortalCanonicalHosts();
    const hostLower = String(url.hostname || "").toLowerCase();
    const isPortalPath =
      pathname === "/portal" ||
      pathname === "/portal/" ||
      pathname.startsWith("/portal/") ||
      pathname.startsWith("/api/portal/");
    const isCanonicalPortalHost = hostLower === portalHosts.exact || hostLower === portalHosts.www;

    if (isPortalPath && !isCanonicalPortalHost) {
      const portalOrigin = getPortalOrigin();
      let targetUrl = null;
      try {
        targetUrl = new URL(`${pathname}${url.search || ""}`, portalOrigin);
      } catch {
        targetUrl = null;
      }

      // Prevent redirect loops when admin worker is accidentally bound
      // on the same canonical portal host.
      if (targetUrl && targetUrl.origin !== url.origin) {
        return Response.redirect(targetUrl.toString(), 302);
      }
    }

    // ===========================
    // Reports-route safety redirects
    // If report/viewer URLs hit admin host, bounce to reports host.
    // ===========================
    const isReportsOwnedPath =
      pathname === "/reports" ||
      pathname.startsWith("/reports/") ||
      pathname.startsWith("/r/") ||
      pathname.startsWith("/file/") ||
      pathname.startsWith("/pdfviewer/") ||
      pathname.startsWith("/admin/reports/") ||
      pathname.startsWith("/admin/file/") ||
      pathname.startsWith("/admin/pdfviewer/") ||
      pathname.startsWith("/enroll/") ||
      pathname.startsWith("/admin/enroll-token/");

    if (isReportsOwnedPath) {
      const reportsOrigin = getReportsOrigin();
      let targetUrl = null;
      try {
        targetUrl = new URL(`${pathname}${url.search || ""}`, reportsOrigin);
      } catch {
        targetUrl = null;
      }

      // Avoid loop if admin and reports origin are accidentally the same.
      if (targetUrl && targetUrl.origin !== url.origin) {
        const authCookies = parseCookies(request.headers.get("Cookie"));
        console.log("[admin-reports-route-redirect]", {
          fromHost: String(url.hostname || "").toLowerCase(),
          path: pathname,
          query: url.search,
          toOrigin: targetUrl.origin,
          hasAdminCookie: authCookies["admin_auth"] === "ok",
          cookieKeys: Object.keys(authCookies || {}),
        });
        const redirectStatus = request.method === "GET" || request.method === "HEAD" ? 302 : 307;
        return Response.redirect(targetUrl.toString(), redirectStatus);
      }
    }

    // ===========================
    // GET /admin/login
    // ===========================
    if (request.method === "GET" && pathname === "/admin/login") {
      const page = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Door Admin Login</title>
  <style>
    body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:380px;background:#0f172a;border:1px solid #1f2937;border-radius:14px;padding:18px;box-shadow:0 24px 60px rgba(0,0,0,.4)}
    h1{font-size:16px;margin:0 0 10px 0}
    p{font-size:12px;opacity:.9;line-height:1.4;margin:0 0 12px 0}
    input{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:10px;font-size:14px}
    button{margin-top:12px;width:100%;padding:10px;border-radius:10px;border:1px solid #334155;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
    .small{font-size:12px;opacity:.8;margin-top:10px}
  </style>
</head>
<body>
  <div class="card">
    <h1>Admin login</h1>
    <p>Enter the admin key.</p>
    <input id="k" placeholder="Admin key" type="password" autocomplete="current-password"/>
    <button id="go">Login</button>
    <div class="small" id="msg"></div>
  </div>

<script>
(function(){
  const btn = document.getElementById("go");
  const input = document.getElementById("k");
  const msg = document.getElementById("msg");

  async function login(){
    msg.textContent = "";
    const k = (input.value || "").trim();
    if(!k){ msg.textContent = "Missing key."; return; }
    const res = await fetch("/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: k })
    });
    if(!res.ok){
      msg.textContent = "Login failed.";
      return;
    }
    window.location = "/admin";
  }

  btn.onclick = login;
  input.addEventListener("keydown", (e)=>{ if(e.key==="Enter") login(); });
})();
</script>
</body>
</html>`;
      return html(page);
    }

    // ===========================
    // POST /admin/login
    // Body: { key: "..." }
    // ===========================
    if (request.method === "POST" && pathname === "/admin/login") {
      const body = await readJsonBody();
      const key = body && typeof body.key === "string" ? body.key.trim() : "";
      if (!env.ADMIN_KEY) return text("ADMIN_KEY not configured", 500);
      if (!key || !timingSafeEqual(key, env.ADMIN_KEY)) return text("Unauthorized", 401);

      const headers = new Headers();
      headers.set("Set-Cookie", setCookie("admin_auth", "ok"));
      headers.set("Location", "/admin");
      return new Response(null, { status: 302, headers });
    }

    // ===========================
    // GET /admin (single-page UI)
    // ===========================
    if (request.method === "GET" && pathname === "/admin") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const page = `<!doctype html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>Door Admin</title>
        <style>
          body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:18px}
          .top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
          h1{font-size:16px;margin:0}
          .btn{border:1px solid #334155;background:#111827;color:#e5e7eb;border-radius:10px;padding:8px 10px;cursor:pointer}
          .btn.primary{background:#2563eb;border-color:#1d4ed8;color:#fff;font-weight:600}
          .panel{margin-top:14px;background:#0f172a;border:1px solid #1f2937;border-radius:14px;overflow:hidden}
          .tabs{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #1f2937;flex-wrap:wrap}
          .tabbtn{border:1px solid #334155;background:#111827;color:#e5e7eb;border-radius:999px;padding:6px 12px;cursor:pointer;font-size:12px}
          .tabbtn.active{background:#2563eb;border-color:#1d4ed8;color:#fff;font-weight:600}
          .tabpanel{display:none}
          .tabpanel.active{display:block}
          .bar{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid #1f2937;flex-wrap:wrap}
          input{background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;min-width:220px}
          table{width:100%;border-collapse:collapse}
          th,td{padding:10px;border-bottom:1px solid #1f2937;text-align:left;font-size:13px}
          th{font-size:12px;opacity:.9}
          .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px}
          .pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;border:1px solid #334155;font-size:12px}
          .pill.ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
          .pill.bad{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35)}
          .rowbtn{border:1px solid #334155;background:#111827;color:#e5e7eb;border-radius:10px;padding:6px 10px;cursor:pointer}
          .rowbtn.merge{background:#2563eb;border-color:#1d4ed8;color:#fff}
          .muted{opacity:.8;font-size:12px}
          .status{padding:10px 12px}
      
          .modalback{
            position:fixed;
            inset:0;
            background:rgba(0,0,0,.55);
            display:none;
            align-items:flex-start;
            justify-content:center;
            padding:24px;
            overflow:auto;
            z-index:50;
          }
          .modal{width:100%;max-width:520px;background:#0f172a;border:1px solid #1f2937;border-radius:14px;padding:14px;margin-top:48px;max-height:calc(100vh - 96px);overflow:auto}
          .modal h2{margin:0 0 8px 0;font-size:14px}
          .modal label{display:block;font-size:12px;opacity:.9;margin-top:10px}
          .modal select{width:100%;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:10px}
          .modal .actions{display:flex;gap:10px;justify-content:flex-end;margin-top:12px}
          .listbox{margin:10px 0;max-height:320px;overflow:auto;border:1px solid #1f2937;border-radius:10px}
          .doorRow{display:flex;gap:10px;align-items:flex-start;padding:10px;border-bottom:1px solid #1f2937}
          .doorRow:last-child{border-bottom:none}
          .doorMeta{display:flex;flex-direction:column;gap:2px}
          .doorLabel{font-size:13px}
          .doorUid{font-size:12px;opacity:.8}
          .toolsRow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
          .smallInput{min-width:0;width:100%}
          .portalSection{padding:12px;border-top:1px solid #1f2937}
          .portalSection:first-of-type{border-top:none}
          .portalHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}
          .portalTitle{font-size:13px;font-weight:700;letter-spacing:.2px}
          .portalHint{font-size:12px;opacity:.8}
          .portalRow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
          .portalMsg{padding:8px 10px;border-radius:10px;border:1px solid #334155;background:#0b1220;font-size:12px;min-height:18px}
          .portalMsg.info{border-color:#334155;color:#cbd5e1}
          .portalMsg.success{border-color:rgba(34,197,94,.55);background:rgba(34,197,94,.12);color:#bbf7d0}
          .portalMsg.error{border-color:rgba(239,68,68,.55);background:rgba(239,68,68,.12);color:#fecaca}
          .portalOut{width:100%;min-height:92px;resize:vertical;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px}
        </style>
      </head>
      <body>
        <div class="top">
          <h1>Door Admin</h1>
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="btn" id="refresh">Refresh</button>
          </div>
        </div>
      
        <div class="panel">
          <div class="tabs">
            <button class="tabbtn active" id="tabLookup" data-tab="lookup">Door Lookup</button>
            <button class="tabbtn" id="tabComments" data-tab="comments">Comments</button>
            <button class="tabbtn" id="tabBusiness" data-tab="business">Business</button>
            <button class="tabbtn" id="tabSecurity" data-tab="security">Security</button>
            <button class="tabbtn" id="tabPortal" data-tab="portal">Portal</button>
          </div>

          <div class="tabpanel active" id="panelLookup">
            <div class="bar" style="display:block;">
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <div class="muted">Find a door by UID / label / slug and inspect canonical KV mapping</div>
                <input id="uidSearch" placeholder="Enter UID, slug, or label…" style="min-width:260px"/>
                <button class="btn primary" id="uidGo">Find</button>
              </div>
              <div class="muted" id="uidResult" style="margin-top:10px;"></div>
            </div>
          </div>

          <div class="tabpanel" id="panelComments">
            <div class="bar">
              <div class="muted">Add Event / Override Status</div>
              <input id="eventUid" placeholder="UID…" style="min-width:120px"/>
              <select id="eventType" style="background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;">
                <option value="admin_note">Admin Note</option>
                <option value="admin_override">Status Override</option>
              </select>
              <select id="eventStatus" style="background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;">
                <option value="">No change</option>
                <option value="Pass">Pass</option>
                <option value="Conditional Pass">Conditional Pass</option>
                <option value="Fail">Flagged</option>
              </select>
              <input id="eventNotes" placeholder="Notes required for Admin Note" style="min-width:300px"/>
              <label class="muted" style="display:flex;align-items:center;gap:6px;">
                <input id="eventVisibleToCustomer" type="checkbox" />
                Visible to customer
              </label>
              <button class="btn primary" id="eventAdd">Add Event</button>
              <div class="muted" id="eventResult" style="margin-left:10px;"></div>
            </div>

            <div class="bar">
              <div class="muted">Business Comment Approval Mode</div>
              <select id="commentSettingsBiz" style="min-width:280px;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;"></select>
              <label class="muted" style="display:flex;align-items:center;gap:6px;">
                <input id="commentAutoApproveToggle" type="checkbox" />
                Allow comments without approval
              </label>
              <button class="btn primary" id="commentSettingsSave">Save</button>
              <div class="muted" id="commentSettingsMsg" style="margin-left:10px;"></div>
            </div>

            <div class="bar" style="display:block;">
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <div class="muted">Customer Comment Moderation</div>
                <input id="commentUidFilter" placeholder="Filter by UID (optional)" style="min-width:220px" />
                <select id="commentStatusFilter" style="background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;">
                  <option value="pending" selected>Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                  <option value="all">All</option>
                </select>
                <button class="btn primary" id="commentsLoad">Load comments</button>
                <div class="muted" id="commentsModerationResult"></div>
              </div>

              <div style="overflow:auto;margin-top:10px;">
                <table>
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>UID</th>
                      <th>Requester</th>
                      <th>Message</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody id="commentsModerationBody">
                    <tr><td colspan="6" class="muted">Load comments to moderate.</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="tabpanel" id="panelBusiness">
            <div class="bar">
              <div class="muted">Businesses (merge typo businesses into correct business)</div>
              <input id="q" placeholder="Search name or code"/>
            </div>

            <div class="status muted" id="status">Open Business tab to load…</div>

            <div style="overflow:auto;">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Code</th>
                    <th>Status</th>
                    <th>Merged into</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="tbody"></tbody>
              </table>
            </div>
          </div>

          <div class="tabpanel" id="panelSecurity">
            <div class="bar">
              <div class="muted">Business Security Mode</div>
              <select id="secBiz" style="min-width:260px;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;"></select>
              <select id="secMode" style="min-width:160px;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;">
                <option value="standard">Standard</option>
                <option value="secure">Secure</option>
                <option value="public">Public</option>
              </select>
              <label class="muted" style="display:flex;align-items:center;gap:6px;">
                <input id="secSandboxDemo" type="checkbox" />
                Demo sandbox (no permanent writes)
              </label>
              <button class="btn primary" id="secSave">Save mode</button>
              <button class="btn" id="secLink">Generate + Copy Access Link</button>
              <div class="muted" id="secMsg" style="margin-left:10px;"></div>
            </div>
            <div class="bar" style="border-top:1px solid #1f2937;">
              <div class="muted">Building Security Override</div>
              <select id="secBld" style="min-width:260px;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;"></select>
              <select id="secBldMode" style="min-width:180px;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;">
                <option value="inherit">Inherit business</option>
                <option value="secure">Secure</option>
                <option value="standard">Standard</option>
                <option value="public">Public</option>
              </select>
              <button class="btn" id="secBldSave">Save building mode</button>
              <div class="muted" id="secBldMsg" style="margin-left:10px;"></div>
            </div>
            <div class="bar" style="border-top:1px solid #1f2937;">
              <input id="secLinkOut" readonly placeholder="Enrollment link will appear here" style="min-width:420px;flex:1"/>
            </div>
          </div>

          <div class="tabpanel" id="panelPortal">
            <div class="portalSection">
              <div class="portalHead">
                <div>
                  <div class="portalTitle">Customer Portal Primary Manager Activation</div>
                  <div class="portalHint">Select business and manager email, then send one-click dashboard access. After activation, customer managers invite their own members.</div>
                </div>
                <div id="portalMsg" class="portalMsg info">Ready.</div>
              </div>
              <div class="portalRow">
                <select id="portalBiz" style="min-width:280px;background:#0b1220;color:#e5e7eb;border:1px solid #243043;border-radius:10px;padding:8px 10px;"></select>
                <input id="portalEmail" placeholder="user email" style="min-width:220px"/>
                <button class="btn primary" id="portalFirstMgr">Activate primary manager</button>
              </div>
            </div>

            <div class="portalSection">
              <div class="portalHead">
                <div>
                  <div class="portalTitle">Members</div>
                  <div class="portalHint">Load current members, then remove by email if needed.</div>
                </div>
              </div>
              <div class="portalRow">
                <button class="btn" id="portalMembersLoad">Load members</button>
                <input id="portalRemoveEmail" placeholder="email to remove" style="min-width:240px"/>
                <button class="btn" id="portalRemove">Remove member</button>
              </div>
              <div style="overflow:auto;margin-top:10px;">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Active</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody id="portalMembersBody">
                    <tr><td colspan="4" class="muted">Open Portal tab and load members.</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="portalSection">
              <div class="portalHead">
                <div>
                  <div class="portalTitle">Repair Email Routing</div>
                  <div class="portalHint">Set default destination and permanent CC recipients for CTA repair requests.</div>
                </div>
              </div>
              <div class="portalRow">
                <input id="portalDefaultTo" placeholder="default repair inbox (to)" style="min-width:260px;"/>
                <input id="portalAlwaysCc" placeholder="always cc list (comma-separated)" style="min-width:320px;flex:1;"/>
                <button class="btn" id="portalRepairLoad">Load routing</button>
                <button class="btn primary" id="portalRepairSave">Save routing</button>
              </div>
            </div>

            <div class="portalSection">
              <div class="portalHead">
                <div>
                  <div class="portalTitle">Action Output</div>
                  <div class="portalHint">Latest API response for transparency and troubleshooting.</div>
                </div>
              </div>
              <textarea id="portalOut" class="portalOut" readonly placeholder="Portal action output appears here"></textarea>
            </div>
          </div>
        </div>
      
        <!-- Merge modal -->
        <div class="modalback" id="modalback">
          <div class="modal">
            <h2 id="modalTitle">Merge business</h2>
            <div class="muted" id="modalHint"></div>
      
            <label>Merge into</label>
            <input id="targetFilter" class="smallInput" placeholder="Filter businesses…" />
            <select id="target"></select>
      
            <div class="actions">
              <button class="btn" id="cancel">Cancel</button>
              <button class="btn primary" id="confirm">Merge</button>
            </div>
            <div class="muted" id="modalMsg" style="margin-top:10px;"></div>
          </div>
        </div>
      
        <!-- Doors modal -->
        <div class="modalback" id="doorsBack">
          <div class="modal" style="max-width:720px">
            <h2 id="doorsTitle">Manage doors</h2>
            <div class="muted" id="doorsHint">Select doors to move. UID + PDFs unchanged. /r/:uid will resolve to new business.</div>
      
            <div class="toolsRow">
              <div style="flex:1;min-width:240px">
                <label style="margin-top:0">Move selected to</label>
                <input id="doorsTargetFilter" class="smallInput" placeholder="Filter businesses…" />
                <select id="doorsTarget"></select>
              </div>
              <div style="flex:1;min-width:240px">
                <label style="margin-top:0">Filter doors</label>
                <input id="doorsDoorFilter" class="smallInput" placeholder="Search label or UID…" />
              </div>
            </div>
      
            <div class="listbox" id="doorsList"></div>
      
            <div class="actions">
              <button class="btn" id="doorsCancel">Cancel</button>
              <button class="btn primary" id="doorsMove">Move selected</button>
            </div>
      
            <div class="muted" id="doorsMsg"></div>
          </div>
        </div>
      
        <!-- Buildings modal -->
        <div class="modalback" id="bldBack">
          <div class="modal" style="max-width:720px">
            <h2 id="bldTitle">Manage buildings</h2>
            <div class="muted" id="bldHint">Merge typo buildings manually. UID + PDFs unchanged. QR always works.</div>
      
            <div class="toolsRow">
              <div style="flex:1;min-width:240px">
              <label style="margin-top:0">Merge these buildings</label>
              <div id="bldFromList" class="listbox" style="max-height:220px"></div>
              
              </div>
      
              <div style="flex:1;min-width:240px">
                <label style="margin-top:0">Merge into</label>
                <select id="bldTo"></select>
              </div>
            </div>
      
            <div class="toolsRow" style="margin-top:12px">
              <div style="flex:1;min-width:240px">
                <label style="margin-top:0">Rename building (display only)</label>
                <select id="bldRenameWhich"></select>
              </div>
              <div style="flex:2;min-width:240px">
                <label style="margin-top:0">New name</label>
                <input id="bldRenameName" class="smallInput" placeholder="e.g., East Wing" />
              </div>
              <div style="align-self:flex-end">
                <button class="btn" id="bldRenameSave">Save name</button>
              </div>
            </div>

            <div class="actions">
              <button class="btn" id="bldCancel">Cancel</button>
              <button class="btn primary" id="bldMerge">Merge buildings</button>
            </div>
      
            <div class="muted" id="bldMsg"></div>
          </div>
        </div>
      
      <script>
      (function(){
        const DBG_ADMIN_UI = true;
        const REPORTS_ORIGIN = ${JSON.stringify(String(env.REPORTS_ORIGIN || "").trim())};
        const dbg = (...args) => {
          if (!DBG_ADMIN_UI) return;
          try { console.log("[door-admin-ui]", ...args); } catch {}
        };

        window.addEventListener("error", (ev) => {
          dbg("window.error", {
            message: ev && ev.message,
            filename: ev && ev.filename,
            lineno: ev && ev.lineno,
            colno: ev && ev.colno,
          });
        });
        window.addEventListener("unhandledrejection", (ev) => {
          dbg("unhandledrejection", ev && ev.reason ? String(ev.reason) : "(no reason)");
        });

        dbg("boot:start");
        const tbody = document.getElementById("tbody");
        const status = document.getElementById("status");
        const q = document.getElementById("q");
        const refresh = document.getElementById("refresh");

        const tabLookup = document.getElementById("tabLookup");
        const tabComments = document.getElementById("tabComments");
        const tabBusiness = document.getElementById("tabBusiness");
        const tabSecurity = document.getElementById("tabSecurity");
        const tabPortal = document.getElementById("tabPortal");
        const panelLookup = document.getElementById("panelLookup");
        const panelComments = document.getElementById("panelComments");
        const panelBusiness = document.getElementById("panelBusiness");
        const panelSecurity = document.getElementById("panelSecurity");
        const panelPortal = document.getElementById("panelPortal");
        dbg("boot:elements", {
          hasTabLookup: !!tabLookup,
          hasTabComments: !!tabComments,
          hasTabBusiness: !!tabBusiness,
          hasTabSecurity: !!tabSecurity,
          hasTabPortal: !!tabPortal,
          hasPanelLookup: !!panelLookup,
          hasPanelComments: !!panelComments,
          hasPanelBusiness: !!panelBusiness,
          hasPanelSecurity: !!panelSecurity,
          hasPanelPortal: !!panelPortal,
        });
        const secBiz = document.getElementById("secBiz");
        const secMode = document.getElementById("secMode");
        const secSandboxDemo = document.getElementById("secSandboxDemo");
        const secSave = document.getElementById("secSave");
        const secLink = document.getElementById("secLink");
        const secBld = document.getElementById("secBld");
        const secBldMode = document.getElementById("secBldMode");
        const secBldSave = document.getElementById("secBldSave");
        const secBldMsg = document.getElementById("secBldMsg");
        const secLinkOut = document.getElementById("secLinkOut");
        const secMsg = document.getElementById("secMsg");

        // Portal tab controls
        const portalBiz = document.getElementById("portalBiz");
        const portalEmail = document.getElementById("portalEmail");
        const portalFirstMgr = document.getElementById("portalFirstMgr");
        const portalMsg = document.getElementById("portalMsg");
        const portalMembersLoad = document.getElementById("portalMembersLoad");
        const portalRemoveEmail = document.getElementById("portalRemoveEmail");
        const portalRemove = document.getElementById("portalRemove");
        const portalMembersBody = document.getElementById("portalMembersBody");
        const portalDefaultTo = document.getElementById("portalDefaultTo");
        const portalAlwaysCc = document.getElementById("portalAlwaysCc");
        const portalRepairLoad = document.getElementById("portalRepairLoad");
        const portalRepairSave = document.getElementById("portalRepairSave");
        const portalOut = document.getElementById("portalOut");
      
        // Merge modal
        const modalback = document.getElementById("modalback");
        const modalTitle = document.getElementById("modalTitle");
        const modalHint = document.getElementById("modalHint");
        const target = document.getElementById("target");
        const cancel = document.getElementById("cancel");
        const confirmBtn = document.getElementById("confirm");
        const modalMsg = document.getElementById("modalMsg");
      
        // Doors modal
        const doorsBack = document.getElementById("doorsBack");
        const doorsTitle = document.getElementById("doorsTitle");
        const doorsTarget = document.getElementById("doorsTarget");
        const doorsTargetFilter = document.getElementById("doorsTargetFilter");
        const doorsDoorFilter = document.getElementById("doorsDoorFilter");
        const doorsList = document.getElementById("doorsList");
        const doorsCancel = document.getElementById("doorsCancel");
        const doorsMove = document.getElementById("doorsMove");
        const doorsMsg = document.getElementById("doorsMsg");
      
        // Buildings modal
        const bldBack = document.getElementById("bldBack");
        const bldTitle = document.getElementById("bldTitle");
        const bldFromList = document.getElementById("bldFromList");
        const bldTo = document.getElementById("bldTo");
        const bldCancel = document.getElementById("bldCancel");
        const bldMerge = document.getElementById("bldMerge");
        const bldMsg = document.getElementById("bldMsg");

        const bldRenameWhich = document.getElementById("bldRenameWhich");
        const bldRenameName = document.getElementById("bldRenameName");
        const bldRenameSave = document.getElementById("bldRenameSave");
      
        let all = [];
        let mergeFrom = null;
        let businessLoaded = false;
        let activeTab = "lookup";
        let securityLoaded = false;
        let portalLoaded = false;
        let commentSettingsLoaded = false;
        let securityBuildings = [];
      
        // Doors modal state
        let doorsFromBiz = null;
        let doorsAllForBiz = [];
      
        // Buildings modal state
        let bldBiz = null;
        let bldList = [];
      
        async function api(path, options){
          const res = await fetch(path, options);
          if(!res.ok){
            const t = await res.text();
            throw new Error(t || ("HTTP " + res.status));
          }
          const ct = res.headers.get("content-type") || "";
          if(ct.includes("application/json")) return res.json();
          return res.text();
        }
      
        function render(list){
          tbody.innerHTML = "";
          list.forEach(cfg => {
            const tr = document.createElement("tr");

            const nameTd = document.createElement("td");
            const fullName = sanitizeBizName(cfg);
            const shortName = fullName.length > 40 ? fullName.slice(0, 40) + "…" : fullName;
            nameTd.textContent = shortName;
            nameTd.title = fullName;
            nameTd.style.cursor = "pointer";
      
            let expanded = false;
            nameTd.onclick = () => {
              expanded = !expanded;
              nameTd.textContent = expanded ? fullName : shortName;
            };
            tr.appendChild(nameTd);
      
            const codeTd = document.createElement("td");
            codeTd.textContent = cfg.slug || "";
            codeTd.className = "mono";
            tr.appendChild(codeTd);
      
            const stTd = document.createElement("td");
            const pill = document.createElement("span");
            const isActive = cfg.active !== false;
            pill.className = "pill " + (isActive ? "ok" : "bad");
            pill.textContent = isActive ? "Active" : "Inactive";
            stTd.appendChild(pill);
            tr.appendChild(stTd);
      
            const mergedTd = document.createElement("td");
            mergedTd.textContent = cfg.merged_into || "";
            mergedTd.className = "mono";
            tr.appendChild(mergedTd);
      
            const actTd = document.createElement("td");
      
            const doorsBtn = document.createElement("button");
            doorsBtn.className = "rowbtn";
            doorsBtn.textContent = "Manage doors →";
            doorsBtn.disabled = !isActive;
            doorsBtn.onclick = () => openDoors(cfg);
            actTd.appendChild(doorsBtn);
      
            const bldBtn = document.createElement("button");
            bldBtn.className = "rowbtn";
            bldBtn.textContent = "Manage buildings →";
            bldBtn.disabled = !isActive;
            bldBtn.onclick = () => openBuildings(cfg);
            actTd.appendChild(bldBtn);
            // ---- Repair QR pointers button ----
            const repairBtn = document.createElement("button");
            repairBtn.className = "rowbtn";
            repairBtn.textContent = "Repair QR pointers";
            
            repairBtn.onclick = async () => {
              const ok = window.confirm("Repair missing QR pointers for this business?");
              if (!ok) return;
              
            
              repairBtn.disabled = true;
              repairBtn.textContent = "Repairing…";
            
              try {
                const res = await api("/admin/business-repair", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ biz: cfg.slug }),
                });
            
                alert("Done. Repaired: " + res.repairedDoorIndex);
              } catch (e) {
                alert("Error: " + e.message);
              } finally {
                repairBtn.disabled = false;
                repairBtn.textContent = "Repair QR pointers";
              }
            };
            
            actTd.appendChild(repairBtn);
                  
            const btn = document.createElement("button");
            btn.className = "rowbtn merge";
            btn.textContent = "Merge →";
            btn.disabled = !isActive;
            btn.onclick = () => openMerge(cfg);
            actTd.appendChild(btn);
      
            tr.appendChild(actTd);
            tbody.appendChild(tr);
          });
      
          status.textContent = list.length ? "" : "No businesses found.";
        }
      
        function applyFilter(){
          const s = (q.value || "").toLowerCase().trim();

          let visible = all.filter(cfg => {
            return (cfg.slug || "").length === 6;
          });

          if (s) {
            visible = visible.filter(cfg => {
              const n = sanitizeBizName(cfg).toLowerCase();
              const c = (cfg.slug || "").toLowerCase();
              return n.includes(s) || c.includes(s);
            });
          }
      
          render(visible);
        }
      
        async function load(){
          status.textContent = "Loading…";
          try {
            const bizs = await api("/admin/businesses");
            all = Array.isArray(bizs) ? bizs : [];
            applyFilter();
            businessLoaded = true;
          } catch(e) {
            status.textContent = "Error: " + (e.message || e);
          }
        }

        function applySecuritySelection(){
          const biz = (secBiz.value || "").trim();
          const row = all.find(x => x.slug === biz);
          const mode = row && row.mode ? String(row.mode) : "standard";
          secMode.value = mode;
          if (secSandboxDemo) {
            secSandboxDemo.checked = !!(row && row.sandbox_demo === true);
          }
        }

        async function loadSelectedBuildingSecurity(){
          const biz = (secBiz.value || "").trim();
          const buildingCode = (secBld.value || "").trim();
          if (!biz || !buildingCode) {
            secBldMode.value = "inherit";
            return;
          }

          try {
            const state = await api(
              "/admin/building-security?biz=" + encodeURIComponent(biz) +
              "&buildingCode=" + encodeURIComponent(buildingCode)
            );
            const m = String(state && state.mode ? state.mode : "inherit");
            secBldMode.value = m;
          } catch (e) {
            secBldMsg.textContent = "Error: " + (e.message || e);
          }
        }

        async function loadSecurityBuildings(){
          const biz = (secBiz.value || "").trim();
          secBldMsg.textContent = "";
          secBld.innerHTML = "";
          securityBuildings = [];

          if (!biz) {
            secBldSave.disabled = true;
            return;
          }

          try {
            const rows = await api("/admin/business/" + encodeURIComponent(biz) + "/buildings");
            securityBuildings = Array.isArray(rows) ? rows : [];

            if (!securityBuildings.length) {
              secBldSave.disabled = true;
              secBldMsg.textContent = "No buildings found for this business.";
              return;
            }

            securityBuildings.forEach((b) => {
              const code = String(b.buildingCode || "");
              const display = String(b.displayName || code || "").trim() || code;
              const opt = document.createElement("option");
              opt.value = code;
              opt.textContent = display + " — " + code;
              secBld.appendChild(opt);
            });

            secBldSave.disabled = false;
            await loadSelectedBuildingSecurity();
          } catch (e) {
            secBldSave.disabled = true;
            secBldMsg.textContent = "Error loading buildings: " + (e.message || e);
          }
        }

        function renderSecurityBusinesses(){
          const visible = all
            .filter(cfg => (cfg.slug || "").length === 6 && cfg.active !== false)
            .sort((a, b) => (a.name || a.slug || "").localeCompare(b.name || b.slug || ""));

          secBiz.innerHTML = "";
          visible.forEach((cfg) => {
            const opt = document.createElement("option");
            opt.value = cfg.slug;
            opt.textContent = (cfg.name || cfg.slug) + " — " + cfg.slug;
            secBiz.appendChild(opt);
          });

          if (!visible.length) {
            secMsg.textContent = "No active businesses found.";
            secSave.disabled = true;
            return;
          }

          secSave.disabled = false;
          applySecuritySelection();
        }

        async function loadSecurity(){
          secMsg.textContent = "Loading…";
          try {
            if (!all.length) {
              const bizs = await api("/admin/businesses");
              all = Array.isArray(bizs) ? bizs : [];
            }
            renderSecurityBusinesses();
            await loadSecurityBuildings();
            secMsg.textContent = "";
            securityLoaded = true;
          } catch (e) {
            secMsg.textContent = "Error: " + (e.message || e);
          }
        }

        function portalSelectedBiz(){
          return (portalBiz && portalBiz.value ? portalBiz.value : "").trim();
        }

        const MIME_BIZ_NAME_RE = /=\?[^?]+\?[bqBQ]\?[^?]+\?=/;
        function looksMimeGarbage(name){
          const raw = String(name || "").trim();
          if (!raw) return false;
          if (MIME_BIZ_NAME_RE.test(raw)) return true;
          const n = raw.toLowerCase();
          return n.startsWith("=?utf-8?") || n.includes("?b?") || n.includes("?=");
        }

        function sanitizeBizName(cfg){
          const code = String(cfg && cfg.slug ? cfg.slug : "").trim();
          const rawName = String(cfg && cfg.name ? cfg.name : "").trim();
          return rawName && !looksMimeGarbage(rawName) ? rawName : (code || "Unknown business");
        }

        function displayBizLabel(cfg){
          const code = String(cfg && cfg.slug ? cfg.slug : "").trim();
          const base = sanitizeBizName(cfg);
          return code ? (base + " — " + code) : base;
        }

        function setPortalMessage(message, tone){
          if (!portalMsg) return;
          portalMsg.textContent = String(message || "");
          portalMsg.className = "portalMsg " + (tone || "info");
        }

        function setPortalOutput(v){
          if (!portalOut) return;
          if (typeof v === "string") {
            portalOut.value = v;
            return;
          }
          try {
            portalOut.value = JSON.stringify(v, null, 2);
          } catch {
            portalOut.value = String(v || "");
          }
        }

        function renderPortalMembers(rows){
          portalMembersBody.innerHTML = "";
          if (!rows || !rows.length) {
            portalMembersBody.innerHTML = '<tr><td colspan="4" class="muted">No members found.</td></tr>';
            return;
          }

          rows.forEach((m) => {
            const tr = document.createElement("tr");
            const created = m && m.createdAt ? new Date(m.createdAt).toLocaleString() : "";
            tr.innerHTML =
              "<td>" + (m.email || "") + "</td>" +
              "<td>" + (m.role || "member") + "</td>" +
              "<td>" + (m.active === false ? "false" : "true") + "</td>" +
              "<td>" + created + "</td>";
            portalMembersBody.appendChild(tr);
          });
        }

        function renderPortalBusinesses(){
          const visible = all
            .filter(cfg => (cfg.slug || "").length === 6 && cfg.active !== false)
            .sort((a, b) => sanitizeBizName(a).localeCompare(sanitizeBizName(b)));

          portalBiz.innerHTML = "";
          visible.forEach((cfg) => {
            const opt = document.createElement("option");
            opt.value = cfg.slug;
            opt.textContent = displayBizLabel(cfg);
            portalBiz.appendChild(opt);
          });

          if (!visible.length) {
            setPortalMessage("No active businesses found.", "error");
          }
        }

        async function loadPortalMembers(){
          const biz = portalSelectedBiz();
          if (!biz) {
            setPortalMessage("Pick a business.", "error");
            renderPortalMembers([]);
            return null;
          }

          setPortalMessage("Loading members…", "info");
          const res = await api("/admin/portal/members?biz=" + encodeURIComponent(biz));
          const members = Array.isArray(res && res.members) ? res.members : [];
          renderPortalMembers(members);
          setPortalMessage("Loaded " + members.length + " member(s).", "success");
          setPortalOutput(res);
          return res;
        }

        async function loadPortalRepairSettings(){
          const biz = portalSelectedBiz();
          if (!biz) {
            setPortalMessage("Pick a business.", "error");
            return;
          }

          setPortalMessage("Loading routing…", "info");
          const res = await api("/admin/portal/repair-settings?biz=" + encodeURIComponent(biz));
          portalDefaultTo.value = res && res.defaultTo ? String(res.defaultTo) : "";
          portalAlwaysCc.value = res && res.alwaysCc ? String(res.alwaysCc) : "";
          setPortalMessage("Routing loaded.", "success");
          setPortalOutput(res);
          return res;
        }

        async function loadPortal(){
          setPortalMessage("Loading portal tools…", "info");
          try {
            if (!all.length) {
              const bizs = await api("/admin/businesses");
              all = Array.isArray(bizs) ? bizs : [];
            }
            renderPortalBusinesses();
            await loadPortalMembers();
            await loadPortalRepairSettings();
            setPortalMessage("Portal tools loaded.", "success");
            portalLoaded = true;
          } catch (e) {
            setPortalMessage("Error: " + (e.message || e), "error");
          }
        }

        async function setTab(next){
          dbg("setTab:start", next);
          activeTab = next;

          if (tabLookup) tabLookup.classList.toggle("active", next === "lookup");
          if (tabComments) tabComments.classList.toggle("active", next === "comments");
          if (tabBusiness) tabBusiness.classList.toggle("active", next === "business");
          if (tabSecurity) tabSecurity.classList.toggle("active", next === "security");
          if (tabPortal) tabPortal.classList.toggle("active", next === "portal");

          if (panelLookup) panelLookup.classList.toggle("active", next === "lookup");
          if (panelComments) panelComments.classList.toggle("active", next === "comments");
          if (panelBusiness) panelBusiness.classList.toggle("active", next === "business");
          if (panelSecurity) panelSecurity.classList.toggle("active", next === "security");
          if (panelPortal) panelPortal.classList.toggle("active", next === "portal");

          if (next === "business" && !businessLoaded) {
            await load();
          }
          if (next === "security" && !securityLoaded) {
            await loadSecurity();
          }
          if (next === "portal" && !portalLoaded) {
            await loadPortal();
          }
          if (next === "comments" && !commentSettingsLoaded) {
            await loadCommentSettings();
          }
          dbg("setTab:done", { next, businessLoaded, securityLoaded, portalLoaded });
        }
      
        // -------- Merge modal --------
        function openMerge(cfg){
          mergeFrom = cfg;
          modalTitle.textContent = "Merge: " + (cfg.name || cfg.slug);
          modalHint.textContent = "Moves ALL doors. UID + PDFs unchanged.";
          modalMsg.textContent = "";
      
          const targetFilter = document.getElementById("targetFilter");
          target.innerHTML = "";
          targetFilter.value = "";
      
          const opts = all
            .filter(b =>
              (b.slug || "").length === 6 &&
              b.slug !== cfg.slug &&
              b.active !== false
            )
            .sort((a, b) =>
              (a.name || a.slug || "").localeCompare(b.name || b.slug || "")
            );
      
          if (!opts.length) {
            modalMsg.textContent = "No active target businesses available.";
            modalback.style.display = "flex";
            return;
          }
      
          function renderTargets(list){
            target.innerHTML = "";
            list.forEach(b => {
              const o = document.createElement("option");
              o.value = b.slug;
              o.textContent = (b.name || b.slug) + " — " + b.slug;
              target.appendChild(o);
            });
          }
      
          renderTargets(opts);
      
          targetFilter.oninput = () => {
            const s = (targetFilter.value || "").toLowerCase().trim();
            if (!s) return renderTargets(opts);
      
            renderTargets(
              opts.filter(b =>
                (b.name || "").toLowerCase().includes(s) ||
                (b.slug || "").toLowerCase().includes(s)
              )
            );
          };
      
          modalback.style.display = "flex";
        }
      
        function closeMerge(){
          modalback.style.display = "none";
          mergeFrom = null;
        }
      
        cancel.onclick = closeMerge;
        modalback.addEventListener("click", (e) => {
          if(e.target === modalback) closeMerge();
        });
      
        confirmBtn.onclick = async () => {
          if(!mergeFrom) return;
          const toBiz = target.value;
          if(!toBiz) return;
      
          const msg = "Merge " + mergeFrom.slug + " into " + toBiz + "?\\n\\nThis moves ALL doors under that business. QR / UID stays the same.";
          if(!window.confirm(msg)) return;
      
          confirmBtn.disabled = true;
          modalMsg.textContent = "Merging…";
      
          try {
            await api("/admin/merge-business", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fromBiz: mergeFrom.slug, toBiz })
            });
            modalMsg.textContent = "Done.";
            closeMerge();
            await load();
          } catch(e) {
            modalMsg.textContent = "Error: " + (e.message || e);
          } finally {
            confirmBtn.disabled = false;
          }
        };
      
        // -------- Doors modal --------
        function renderDoorTargets(fromBiz){
          const opts = all
            .filter(b => (b.slug || "").length === 6 && b.slug !== fromBiz && b.active !== false)
            .sort((a,b) => (a.name || a.slug || "").localeCompare(b.name || b.slug || ""));
      
          function paint(list){
            doorsTarget.innerHTML = "";
            list.forEach(b => {
              const o = document.createElement("option");
              o.value = b.slug;
              o.textContent = (b.name || b.slug) + " — " + b.slug;
              doorsTarget.appendChild(o);
            });
          }
      
          paint(opts);
      
          doorsTargetFilter.value = "";
          doorsTargetFilter.oninput = () => {
            const s = (doorsTargetFilter.value || "").toLowerCase().trim();
            if(!s) return paint(opts);
            paint(opts.filter(b =>
              (b.name || "").toLowerCase().includes(s) ||
              (b.slug || "").toLowerCase().includes(s)
            ));
          };
        }
      
        function renderDoorsList(){
          const s = (doorsDoorFilter.value || "").toLowerCase().trim();
          const list = !s ? doorsAllForBiz : doorsAllForBiz.filter(d => {
            const label = String(d.label || "").toLowerCase();
            const uid = String(d.uid || "").toLowerCase();
            return label.includes(s) || uid.includes(s);
          });
      
          doorsList.innerHTML = "";
          if(!list.length){
            doorsList.innerHTML = '<div style="padding:10px" class="muted">No doors found.</div>';
            return;
          }
      
          list.forEach(d => {
            const row = document.createElement("div");
            row.className = "doorRow";
      
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = d.uid;
            cb.style.marginTop = "3px";
      
            const meta = document.createElement("div");
            meta.className = "doorMeta";
      
            const label = document.createElement("div");
            label.className = "doorLabel";
            label.textContent = d.label || d.doorId || d.uid;
      
            const uid = document.createElement("div");
            uid.className = "doorUid mono";
            uid.textContent = d.uid;
      
            meta.appendChild(label);
            meta.appendChild(uid);
      
            row.appendChild(cb);
            row.appendChild(meta);
      
            doorsList.appendChild(row);
          });
        }
      
        async function openDoors(cfg){
          doorsMsg.textContent = "";
          doorsFromBiz = cfg.slug;
          doorsTitle.textContent = "Manage doors: " + (cfg.name || cfg.slug) + " — " + cfg.slug;
      
          doorsMove.disabled = true;
          doorsCancel.disabled = true;
      
          try {
            renderDoorTargets(cfg.slug);
      
            doorsAllForBiz = await api("/admin/business/" + encodeURIComponent(cfg.slug) + "/doors");
            if(!Array.isArray(doorsAllForBiz)) doorsAllForBiz = [];
      
            doorsDoorFilter.value = "";
            doorsDoorFilter.oninput = renderDoorsList;
      
            renderDoorsList();
      
            doorsBack.style.display = "flex";
          } catch(e) {
            doorsMsg.textContent = "Error loading doors: " + (e.message || e);
          } finally {
            doorsMove.disabled = false;
            doorsCancel.disabled = false;
          }
        }
      
        function closeDoors(){
          doorsBack.style.display = "none";
          doorsFromBiz = null;
          doorsAllForBiz = [];
          doorsMsg.textContent = "";
          doorsList.innerHTML = "";
          doorsDoorFilter.value = "";
          doorsTargetFilter.value = "";
        }
      
        doorsCancel.onclick = closeDoors;
        doorsBack.addEventListener("click", (e) => {
          if(e.target === doorsBack) closeDoors();
        });
      
        doorsMove.onclick = async () => {
          doorsMsg.textContent = "";
          const toBiz = doorsTarget.value;
          if(!toBiz){
            doorsMsg.textContent = "Pick a destination business.";
            return;
          }
      
          const uids = Array.from(doorsList.querySelectorAll("input[type=checkbox]:checked")).map(x => x.value);
          if(!uids.length){
            doorsMsg.textContent = "Select at least one door.";
            return;
          }
      
          const msg = "Move " + uids.length + " door(s) from " + doorsFromBiz + " to " + toBiz + "?\\n\\nUID stays the same. /r/:uid continues working.";
          if(!window.confirm(msg)) return;
      
          doorsMove.disabled = true;
          doorsCancel.disabled = true;
          doorsMsg.textContent = "Moving…";
      
          try {
            const res = await api("/admin/reassign-uids", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ uids, toBiz })
            });
      
            doorsMsg.textContent = "Done. Moved: " + (res && res.moved != null ? res.moved : uids.length);
            closeDoors();
            await load();
          } catch(e) {
            doorsMsg.textContent = "Error: " + (e.message || e);
          } finally {
            doorsMove.disabled = false;
            doorsCancel.disabled = false;
          }
        };
      
        // -------- Buildings modal --------
        async function openBuildings(cfg){
          bldMsg.textContent = "";
          const bizSlug = String((cfg && cfg.slug) || "").trim();
          if (!bizSlug || bizSlug === "null" || bizSlug === "undefined") {
            bldMsg.textContent = "Unable to open buildings: missing business slug.";
            bldBack.style.display = "flex";
            return;
          }
          bldBiz = bizSlug;

          bldTitle.textContent = "Manage buildings: " + (cfg.name || bizSlug) + " — " + bizSlug;
      
          bldMerge.disabled = true;
          bldCancel.disabled = true;
      
          try {
            bldList = await api("/admin/business/" + encodeURIComponent(bizSlug) + "/buildings");
            if(!Array.isArray(bldList)) bldList = [];
      
            if(!bldList.length){
              bldMsg.textContent = "No buildings found.";
              bldBack.style.display = "flex";
              return;
            }
      
            bldFromList.innerHTML = "";
            bldTo.innerHTML = "";
            
            bldList.forEach(b => {
              const code = String(b.buildingCode || "");
              const cnt = Number(b.doorCount || 0);
            
              const label =
                (b.displayName && b.displayName !== code ? String(b.displayName) : code) +
                " (" + cnt + ")";
            
              // ---- Merge-FROM checkbox row ----
              const row = document.createElement("div");
              row.className = "doorRow";
            
              const cb = document.createElement("input");
              cb.type = "checkbox";
              cb.value = code;
            
              const meta = document.createElement("div");
              meta.className = "doorMeta";
            
              const line1 = document.createElement("div");
              line1.className = "doorLabel";
              line1.textContent = label;
            
              const line2 = document.createElement("div");
              line2.className = "doorUid mono";
              line2.textContent = code;
            
              meta.appendChild(line1);
              meta.appendChild(line2);
            
              row.appendChild(cb);
              row.appendChild(meta);
            
              bldFromList.appendChild(row);
            
              // ---- Merge-INTO dropdown option ----
              const opt = document.createElement("option");
              opt.value = code;
              opt.textContent = label;
              bldTo.appendChild(opt);
            });

            // ---- Rename dropdown mirrors building list ----
            bldRenameWhich.innerHTML = "";
            bldList.forEach(b => {
              const code = String(b.buildingCode || "");
              const cnt = Number(b.doorCount || 0);
              const label =
                (b.displayName && b.displayName !== code ? String(b.displayName) : code) +
                " (" + cnt + ")";
              const opt = document.createElement("option");
              opt.value = code;
              opt.textContent = label;
              bldRenameWhich.appendChild(opt);
            });

            bldRenameName.value = "";
            
            // Default: pick 2nd building as destination if possible
            if (bldList.length > 1) {
              bldTo.selectedIndex = 1;
            }
            
            bldBack.style.display = "flex";
            
            } catch(e) {
              bldMsg.textContent = "Error loading buildings: " + (e.message || e);
            } finally {
              bldMerge.disabled = false;
              bldCancel.disabled = false;
            }
            }
            
            function closeBuildings(){
              bldBack.style.display = "none";
              bldBiz = null;
              bldList = [];
              bldMsg.textContent = "";
              bldFromList.innerHTML = "";
              bldTo.innerHTML = "";
              bldRenameWhich.innerHTML = "";
              bldRenameName.value = "";
            }
            
            bldCancel.onclick = closeBuildings;
            bldBack.addEventListener("click", (e) => {
              if(e.target === bldBack) closeBuildings();
            });

            bldRenameSave.onclick = async () => {
              bldMsg.textContent = "";
              const bizForRename = String(bldBiz || "").trim();
              const buildingCode = (bldRenameWhich.value || "").trim();
              const name = (bldRenameName.value || "").trim();
              if (!bizForRename || bizForRename === "null" || bizForRename === "undefined") {
                bldMsg.textContent = "Business context missing. Close and reopen Manage buildings.";
                return;
              }
              if (!buildingCode) { bldMsg.textContent = "Pick a building to rename."; return; }
              if (!name) { bldMsg.textContent = "Enter a name."; return; }

              bldRenameSave.disabled = true;
              try {
                await api("/admin/building-name", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ biz: bizForRename, buildingCode, name })
                });
                bldMsg.textContent = "Saved.";
                // refresh buildings list so labels update
                bldList = await api("/admin/business/" + encodeURIComponent(bizForRename) + "/buildings");
                if(!Array.isArray(bldList)) bldList = [];
                // re-open in place (simple repaint)
                const reopenBiz = bizForRename;
                closeBuildings();
                if (reopenBiz && reopenBiz !== "null" && reopenBiz !== "undefined") {
                  await openBuildings({ slug: reopenBiz, name: reopenBiz, active: true });
                }
              } catch(e){
                bldMsg.textContent = "Error: " + (e.message || e);
              } finally {
                bldRenameSave.disabled = false;
              }
            };

            bldMerge.onclick = async () => {
              bldMsg.textContent = "";
            
              // MULTI selection (merge-from)
              const fromBuildings = Array.from(
                bldFromList.querySelectorAll("input[type=checkbox]:checked")
              ).map(x => x.value);
            
              const toBuilding = (bldTo.value || "").trim();
            
              if(!fromBuildings.length || !toBuilding){
                bldMsg.textContent = "Select at least one source building and a destination.";
                return;
              }
            
              if(fromBuildings.includes(toBuilding)){
                bldMsg.textContent = "Destination cannot be one of the selected source buildings.";
                return;
              }
            
              const msg =
                "Merge " + fromBuildings.length +
                " building(s) into '" + toBuilding +
                "'?\\n\\nUID stays sacred. QR always works.";
            
              if(!window.confirm(msg)) return;
            
              bldMerge.disabled = true;
              bldCancel.disabled = true;
              bldMsg.textContent = "Merging…";
            
              try {
                const res = await api("/admin/merge-building", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    biz: bldBiz,
                    fromBuildings,
                    toBuilding
                  })
                });
            
                bldMsg.textContent =
                  "Done. Moved " +
                  (res && res.movedCount != null ? res.movedCount : 0) +
                  " doors.";
            
                closeBuildings();
                await load();
            
              } catch(e){
                bldMsg.textContent = "Error: " + (e.message || e);
              } finally {
                bldMerge.disabled = false;
                bldCancel.disabled = false;
              }
            };
            
        if (q) q.addEventListener("input", applyFilter);
        if (refresh) refresh.onclick = async () => {
          if (activeTab === "business") {
            businessLoaded = false;
            await load();
            return;
          }
          if (activeTab === "security") {
            securityLoaded = false;
            await loadSecurity();
            return;
          }
          if (activeTab === "portal") {
            portalLoaded = false;
            await loadPortal();
            return;
          }
        };

        if (tabComments) tabComments.onclick = () => setTab("comments");
        if (tabLookup) tabLookup.onclick = () => setTab("lookup");
        if (tabBusiness) tabBusiness.onclick = () => setTab("business");
        if (tabSecurity) tabSecurity.onclick = () => setTab("security");
        if (tabPortal) tabPortal.onclick = () => setTab("portal");

        portalBiz.onchange = async () => {
          await loadPortalMembers();
          await loadPortalRepairSettings();
        };

        portalMembersLoad.onclick = async () => {
          try {
            await loadPortalMembers();
          } catch (e) {
            setPortalMessage("Error: " + (e.message || e), "error");
          }
        };

        portalFirstMgr.onclick = async () => {
          setPortalMessage("", "info");
          const biz = portalSelectedBiz();
          const email = (portalEmail.value || "").trim();
          if (!biz) {
            setPortalMessage("Pick a business.", "error");
            return;
          }

          portalFirstMgr.disabled = true;
          setPortalMessage("Activating primary manager…", "info");
          try {
            const payload = { biz };
            if (email) payload.email = email;
            const res = await api("/admin/portal/first-manager-invite", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            setPortalMessage("Primary manager activated and sign-in email sent.", "success");
            setPortalOutput(res);
          } catch (e) {
            setPortalMessage("Error: " + (e.message || e), "error");
          } finally {
            portalFirstMgr.disabled = false;
          }
        };

        portalRemove.onclick = async () => {
          setPortalMessage("", "info");
          const biz = portalSelectedBiz();
          const email = (portalRemoveEmail.value || "").trim();
          if (!biz) {
            setPortalMessage("Pick a business.", "error");
            return;
          }
          if (!email) {
            setPortalMessage("Enter an email to remove.", "error");
            return;
          }

          portalRemove.disabled = true;
          setPortalMessage("Removing member…", "info");
          try {
            const res = await api("/admin/portal/member-remove", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ biz, email }),
            });
            setPortalMessage("Member removed.", "success");
            setPortalOutput(res);
            await loadPortalMembers();
          } catch (e) {
            setPortalMessage("Error: " + (e.message || e), "error");
          } finally {
            portalRemove.disabled = false;
          }
        };

        portalRepairLoad.onclick = async () => {
          try {
            await loadPortalRepairSettings();
          } catch (e) {
            setPortalMessage("Error: " + (e.message || e), "error");
          }
        };

        portalRepairSave.onclick = async () => {
          setPortalMessage("", "info");
          const biz = portalSelectedBiz();
          if (!biz) {
            setPortalMessage("Pick a business.", "error");
            return;
          }

          portalRepairSave.disabled = true;
          setPortalMessage("Saving routing…", "info");
          try {
            const res = await api("/admin/portal/repair-settings", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                biz,
                defaultTo: (portalDefaultTo.value || "").trim(),
                alwaysCc: (portalAlwaysCc.value || "").trim(),
              }),
            });
            setPortalMessage("Routing saved.", "success");
            setPortalOutput(res);
          } catch (e) {
            setPortalMessage("Error: " + (e.message || e), "error");
          } finally {
            portalRepairSave.disabled = false;
          }
        };

        secBiz.onchange = applySecuritySelection;
        secBiz.onchange = async () => {
          applySecuritySelection();
          await loadSecurityBuildings();
        };
        secBld.onchange = () => {
          loadSelectedBuildingSecurity();
        };
        secSave.onclick = async () => {
          secMsg.textContent = "";
          const biz = (secBiz.value || "").trim();
          const mode = (secMode.value || "").trim();
          const sandboxDemo = !!(secSandboxDemo && secSandboxDemo.checked);
          if (!biz) {
            secMsg.textContent = "Pick a business.";
            return;
          }
          if (!mode) {
            secMsg.textContent = "Pick a mode.";
            return;
          }

          secSave.disabled = true;
          secMsg.textContent = "Saving…";

          try {
            await api("/admin/security-mode", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ biz, mode, sandboxDemo }),
            });

            const row = all.find(x => x.slug === biz);
            if (row) {
              row.mode = mode;
              row.sandbox_demo = sandboxDemo;
            }
            secMsg.textContent = "Saved.";
          } catch (e) {
            secMsg.textContent = "Error: " + (e.message || e);
          } finally {
            secSave.disabled = false;
          }
        };

        secBldSave.onclick = async () => {
          secBldMsg.textContent = "";
          const biz = (secBiz.value || "").trim();
          const buildingCode = (secBld.value || "").trim();
          const mode = (secBldMode.value || "").trim();

          if (!biz || !buildingCode) {
            secBldMsg.textContent = "Pick business + building first.";
            return;
          }

          secBldSave.disabled = true;
          secBldMsg.textContent = "Saving…";

          try {
            await api("/admin/building-security-mode", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ biz, buildingCode, mode }),
            });
            secBldMsg.textContent = "Saved.";
          } catch (e) {
            secBldMsg.textContent = "Error: " + (e.message || e);
          } finally {
            secBldSave.disabled = false;
          }
        };

        secLink.onclick = async () => {
          secMsg.textContent = "";
          const biz = (secBiz.value || "").trim();
          if (!biz) {
            secMsg.textContent = "Pick a business first.";
            return;
          }

          secLink.disabled = true;
          secMsg.textContent = "Generating…";

          try {
            const res = await api("/admin/enroll-link", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ biz }),
            });

            const enrollUrl = res && res.enrollUrl ? String(res.enrollUrl) : "";
            if (!enrollUrl) throw new Error("Missing enrollment URL");

            secLinkOut.value = enrollUrl;

            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(enrollUrl);
                secMsg.textContent = "Copied access link to clipboard.";
              } else {
                secMsg.textContent = "Access link generated.";
              }
            } catch {
              secMsg.textContent = "Access link generated (copy manually).";
            }
          } catch (e) {
            secMsg.textContent = "Error: " + (e.message || e);
          } finally {
            secLink.disabled = false;
          }
        };
        // ---------- UID / Door Search (partial + multi results) ----------
        const uidSearch = document.getElementById("uidSearch");
        const uidGo = document.getElementById("uidGo");
        const uidResult = document.getElementById("uidResult");
        
        if (uidGo && uidSearch && uidResult) uidGo.onclick = async () => {
          const startedAt = Date.now();
          uidResult.innerHTML = "Searching…";
          const q = (uidSearch.value || "").trim();
          dbg("search:start", { q, len: q.length });
          if (!q) {
            uidResult.textContent = "Enter at least 2 characters.";
            dbg("search:empty");
            return;
          }
        
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            const searchRes = await fetch(
              "/admin/search?q=" + encodeURIComponent(q) + "&maxScan=2500",
              { signal: controller.signal }
            );
            clearTimeout(timeoutId);
            if (!searchRes.ok) {
              const t = await searchRes.text();
              throw new Error(t || ("HTTP " + searchRes.status));
            }
            const res = await searchRes.json();
            dbg("search:response", {
              ok: !!(res && res.ok),
              matches: Array.isArray(res && res.matches) ? res.matches.length : 0,
              scan: res && res.scan ? res.scan : null,
              ms: Date.now() - startedAt,
            });
        
            const matches = (res && res.matches) ? res.matches : [];
            if (!matches.length) {
              const scan = res && res.scan ? res.scan : null;
              if (scan && scan.truncated) {
                uidResult.textContent = "No matches in first " + String(scan.scannedDoorRecords || 0) + " scanned records. Try a more specific query.";
              } else {
                uidResult.textContent = "No matches.";
              }
              return;
            }

            const clip = (v, max = 140) => {
              const s = String(v == null ? "" : v);
              return s.length > max ? (s.slice(0, max) + "…") : s;
            };

            const buildReportPath = (m) => {
              const base = String(REPORTS_ORIGIN || window.location.origin || "").trim() || window.location.origin;
              const biz = String(m && m.businessCode ? m.businessCode : "").trim();
              const bld = String(m && m.buildingCode ? m.buildingCode : "").trim();
              const slug = String(m && m.doorSlug ? m.doorSlug : "").trim();
              const uid = String(m && m.uid ? m.uid : "").trim();

              if (biz && bld && slug) {
                const reportPath = "/reports/"
                  + encodeURIComponent(biz)
                  + "/"
                  + encodeURIComponent(bld)
                  + "/"
                  + encodeURIComponent(slug);
                return {
                  base,
                  reportPath,
                  uid,
                };
              }

              return {
                base,
                reportPath: "",
                uid,
              };
            };

            const buildCustomerReportHref = (m) => {
              const parts = buildReportPath(m);
              if (parts.reportPath) {
                return new URL(parts.reportPath, parts.base).toString();
              }
              return new URL("/reports/" + encodeURIComponent(parts.uid), parts.base).toString();
            };

            const buildAdminReportHref = (m) => {
              const parts = buildReportPath(m);
              if (parts.reportPath) {
                return new URL(parts.reportPath + "?viewer=admin", parts.base).toString();
              }
              return new URL("/admin/reports/" + encodeURIComponent(parts.uid), parts.base).toString();
            };

            const renderMatches = matches.slice(0, 20);
        
            // Render result list with open-admin-report links + repair buttons when needed
            uidResult.innerHTML = "";
            const wrap = document.createElement("div");
            wrap.style.display = "grid";
            wrap.style.gap = "8px";
            wrap.style.marginTop = "6px";
        
            renderMatches.forEach(m => {
              const row = document.createElement("div");
              row.style.border = "1px solid #334155";
              row.style.borderRadius = "10px";
              row.style.padding = "8px";
              row.style.background = "#0b1220";
        
              const title = document.createElement("div");
              title.style.fontWeight = "600";
              title.textContent = clip(m.uid, 72) + (m.hasDoorIndex ? " (QR OK)" : " (QR BROKEN)");
              title.title = String(m.uid || "");
              row.appendChild(title);
        
              const meta = document.createElement("div");
              meta.className = "mono";
              meta.style.opacity = "0.85";
              meta.style.marginTop = "2px";
              meta.textContent = clip((m.businessCode || "?") + " / " + (m.buildingCode || "?") + " / " + (m.doorSlug || "?"), 160);
              row.appendChild(meta);

              const source = document.createElement("div");
              source.className = "mono";
              source.style.opacity = "0.8";
              source.style.marginTop = "2px";
              source.textContent = "Source: " + String(m.source || "unknown");
              row.appendChild(source);

              if (m.label) {
                const lab = document.createElement("div");
                lab.style.opacity = "0.85";
                lab.style.marginTop = "2px";
                lab.textContent = clip(m.label, 180);
                lab.title = String(m.label || "");
                row.appendChild(lab);
              }

              const kv = document.createElement("div");
              kv.className = "mono";
              kv.style.opacity = "0.9";
              kv.style.marginTop = "6px";
              kv.style.whiteSpace = "pre-wrap";
              kv.style.wordBreak = "break-all";
              kv.textContent =
                "doorIndexKey: " + clip(String(m.doorIndexKey || ""), 180) + "\\n" +
                "doorKey: " + clip(String(m.doorKey || ""), 180) + "\\n" +
                "uidEventsKey: " + clip(String(m.uidEventsKey || ""), 180) + "\\n" +
                "lastReportKey: " + clip(String(m.lastReportKey || "(none)"), 180) + "\\n" +
                "staleMismatch: " + String(!!m.isStaleMismatch);
              row.appendChild(kv);

              const actions = document.createElement("div");
              actions.style.display = "flex";
              actions.style.gap = "8px";
              actions.style.alignItems = "center";
              actions.style.flexWrap = "wrap";
              actions.style.marginTop = "6px";

              const openCustomer = document.createElement("a");
              openCustomer.className = "btn primary";
              openCustomer.style.display = "inline-block";
              openCustomer.style.textDecoration = "none";
              openCustomer.href = buildCustomerReportHref(m);
              openCustomer.target = "_blank";
              openCustomer.rel = "noopener noreferrer";
              openCustomer.textContent = "Open Customer Report";
              actions.appendChild(openCustomer);

              const openAdmin = document.createElement("a");
              openAdmin.className = "btn";
              openAdmin.style.display = "inline-block";
              openAdmin.style.textDecoration = "none";
              openAdmin.href = buildAdminReportHref(m);
              openAdmin.target = "_blank";
              openAdmin.rel = "noopener noreferrer";
              openAdmin.textContent = "Open Admin Report";
              actions.appendChild(openAdmin);

              const burnBtn = document.createElement("button");
              burnBtn.className = "rowbtn";
              burnBtn.style.background = "#7f1d1d";
              burnBtn.style.borderColor = "#dc2626";
              burnBtn.style.color = "#fff";
              burnBtn.textContent = "BURN UID";
              burnBtn.onclick = async () => {
                const uid = String(m && m.uid ? m.uid : "").trim();
                if (!uid) {
                  alert("Cannot burn: UID missing in result row.");
                  return;
                }

                const expected = "DELETE UID " + uid;
                const typed = window.prompt(
                  "Destructive hard delete.\\nThis will remove KV + R2 artifacts for this UID.\\nType exactly: " + expected,
                  ""
                );
                if (typed == null) return;

                burnBtn.disabled = true;
                const prevText = burnBtn.textContent;
                burnBtn.textContent = "Burning…";
                try {
                  const out = await api("/admin/hard-delete-uid", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      uid,
                      confirmText: typed,
                    }),
                  });

                  burnBtn.textContent = "Burned";
                  burnBtn.style.background = "#14532d";
                  burnBtn.style.borderColor = "#22c55e";
                  alert(
                    "UID burn complete.\\nKV deleted: " + String(out && out.kvDeletedCount != null ? out.kvDeletedCount : 0) +
                    "\\nR2 deleted: " + String(out && out.r2DeletedCount != null ? out.r2DeletedCount : 0)
                  );
                } catch (e) {
                  burnBtn.textContent = prevText;
                  alert("UID burn failed: " + (e && e.message ? e.message : e));
                } finally {
                  burnBtn.disabled = false;
                }
              };
              actions.appendChild(burnBtn);

              row.appendChild(actions);

              if (!m.hasDoorIndex) {
                const btn = document.createElement("button");
                btn.className = "btn primary";
                btn.style.marginTop = "6px";
                btn.textContent = "Repair QR pointer";
                btn.onclick = async () => {
                  btn.disabled = true;
                  btn.textContent = "Repairing…";
                  try {
                    await api("/admin/repair-doorindex", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ uid: m.uid }),
                    });
                    btn.textContent = "Repaired";
                  } catch (e) {
                    btn.textContent = "Failed";
                    alert("Repair failed: " + e.message);
                  } finally {
                    btn.disabled = false;
                  }
                };
                row.appendChild(btn);
              }

              if (m.isStaleMismatch) {
                const warn = document.createElement("div");
                warn.style.marginTop = "8px";
                warn.style.fontSize = "12px";
                warn.style.color = "#fca5a5";
                warn.textContent = "Listing mismatch detected: doorIndex points to a different canonical location.";
                row.appendChild(warn);
              }

              wrap.appendChild(row);
            });

            if (matches.length > renderMatches.length) {
              const more = document.createElement("div");
              more.className = "muted";
              more.style.marginTop = "6px";
              more.textContent = "Showing first " + String(renderMatches.length) + " of " + String(matches.length) + " matches.";
              wrap.appendChild(more);
            }
        
            uidResult.appendChild(wrap);
            dbg("search:rendered", {
              rendered: renderMatches.length,
              total: matches.length,
              ms: Date.now() - startedAt,
            });
          } catch (e) {
            uidResult.textContent = "Error: " + e.message;
            dbg("search:error", { message: String(e && e.message ? e.message : e), ms: Date.now() - startedAt });
          }
        };

        // ---------- Add Event ----------
        const eventUid = document.getElementById("eventUid");
        const eventType = document.getElementById("eventType");
        const eventStatus = document.getElementById("eventStatus");
        const eventNotes = document.getElementById("eventNotes");
        const eventVisibleToCustomer = document.getElementById("eventVisibleToCustomer");
        const eventAdd = document.getElementById("eventAdd");
        const eventResult = document.getElementById("eventResult");

        const commentSettingsBiz = document.getElementById("commentSettingsBiz");
        const commentAutoApproveToggle = document.getElementById("commentAutoApproveToggle");
        const commentSettingsSave = document.getElementById("commentSettingsSave");
        const commentSettingsMsg = document.getElementById("commentSettingsMsg");

        const commentUidFilter = document.getElementById("commentUidFilter");
        const commentStatusFilter = document.getElementById("commentStatusFilter");
        const commentsLoad = document.getElementById("commentsLoad");
        const commentsModerationBody = document.getElementById("commentsModerationBody");
        const commentsModerationResult = document.getElementById("commentsModerationResult");

        function renderCommentSettingsBusinesses() {
          if (!commentSettingsBiz) return;
          const visible = all
            .filter(cfg => (cfg.slug || "").length === 6 && cfg.active !== false)
            .sort((a, b) => sanitizeBizName(a).localeCompare(sanitizeBizName(b)));

          commentSettingsBiz.innerHTML = "";
          visible.forEach((cfg) => {
            const opt = document.createElement("option");
            opt.value = cfg.slug;
            opt.textContent = displayBizLabel(cfg);
            commentSettingsBiz.appendChild(opt);
          });

          const hasAny = visible.length > 0;
          commentSettingsBiz.disabled = !hasAny;
          commentAutoApproveToggle.disabled = !hasAny;
          commentSettingsSave.disabled = !hasAny;

          if (!hasAny) {
            commentSettingsMsg.textContent = "No active businesses found.";
          }
        }

        async function loadSelectedCommentSetting() {
          const biz = (commentSettingsBiz && commentSettingsBiz.value ? commentSettingsBiz.value : "").trim();
          if (!biz) {
            commentSettingsMsg.textContent = "Pick a business.";
            if (commentAutoApproveToggle) commentAutoApproveToggle.checked = false;
            return;
          }

          commentSettingsMsg.textContent = "Loading…";
          try {
            const res = await api("/admin/comment-settings?biz=" + encodeURIComponent(biz));
            if (commentAutoApproveToggle) {
              commentAutoApproveToggle.checked = !!(res && res.publicCommentAutoApprove === true);
            }
            commentSettingsMsg.textContent = "";
          } catch (e) {
            commentSettingsMsg.textContent = "Error: " + (e.message || e);
          }
        }

        async function loadCommentSettings() {
          commentSettingsMsg.textContent = "Loading…";
          try {
            if (!all.length) {
              const bizs = await api("/admin/businesses");
              all = Array.isArray(bizs) ? bizs : [];
            }
            renderCommentSettingsBusinesses();
            await loadSelectedCommentSetting();
            commentSettingsLoaded = true;
          } catch (e) {
            commentSettingsMsg.textContent = "Error: " + (e.message || e);
          }
        }

        function renderModerationRows(comments) {
          commentsModerationBody.innerHTML = "";

          if (!comments || !comments.length) {
            commentsModerationBody.innerHTML = '<tr><td colspan="6" class="muted">No matching comments.</td></tr>';
            return;
          }

          comments.forEach((comment) => {
            const tr = document.createElement("tr");

            const tdCreated = document.createElement("td");
            tdCreated.textContent = String(comment.createdAt || "");

            const tdUid = document.createElement("td");
            tdUid.className = "mono";
            tdUid.textContent = String(comment.uid || "");

            const tdRequester = document.createElement("td");
            const name = String(comment.requesterName || "").trim();
            const email = String(comment.requesterEmail || "").trim();
            tdRequester.textContent = [name || "(anonymous)", email].filter(Boolean).join(" • ");

            const tdMessage = document.createElement("td");
            tdMessage.style.whiteSpace = "pre-wrap";
            tdMessage.style.wordBreak = "break-word";
            tdMessage.textContent = String(comment.message || "");

            const tdStatus = document.createElement("td");
            tdStatus.textContent = String(comment.status || "pending");

            const tdActions = document.createElement("td");
            tdActions.style.whiteSpace = "nowrap";

            const approveBtn = document.createElement("button");
            approveBtn.className = "rowbtn";
            approveBtn.textContent = "Approve";
            approveBtn.disabled = String(comment.status || "").toLowerCase() === "approved";
            approveBtn.onclick = () => moderateComment(comment.commentKey, "approve");

            const rejectBtn = document.createElement("button");
            rejectBtn.className = "rowbtn";
            rejectBtn.style.marginLeft = "6px";
            rejectBtn.textContent = "Reject";
            rejectBtn.disabled = String(comment.status || "").toLowerCase() === "rejected";
            rejectBtn.onclick = async () => {
              const reason = window.prompt("Optional rejection reason:", "") || "";
              await moderateComment(comment.commentKey, "reject", reason);
            };

            tdActions.appendChild(approveBtn);
            tdActions.appendChild(rejectBtn);

            tr.appendChild(tdCreated);
            tr.appendChild(tdUid);
            tr.appendChild(tdRequester);
            tr.appendChild(tdMessage);
            tr.appendChild(tdStatus);
            tr.appendChild(tdActions);
            commentsModerationBody.appendChild(tr);
          });
        }

        async function loadCommentsForModeration() {
          commentsModerationResult.textContent = "Loading…";
          const uid = (commentUidFilter.value || "").trim();
          const status = (commentStatusFilter.value || "pending").trim() || "pending";

          try {
            const params = new URLSearchParams();
            params.set("status", status);
            if (uid) params.set("uid", uid);
            params.set("limit", "200");

            const res = await api("/admin/comments?" + params.toString());
            const comments = Array.isArray(res && res.comments) ? res.comments : [];
            renderModerationRows(comments);
            commentsModerationResult.textContent = "Loaded " + comments.length + " comment(s).";
          } catch (e) {
            commentsModerationResult.textContent = "Error: " + (e.message || e);
          }
        }

        async function moderateComment(commentKey, action, moderationReason) {
          commentsModerationResult.textContent = (action === "approve" ? "Approving" : "Rejecting") + "…";
          try {
            await api("/admin/comments/moderate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                commentKey,
                action,
                moderationReason: moderationReason || "",
              }),
            });

            commentsModerationResult.textContent = "Updated.";
            await loadCommentsForModeration();
          } catch (e) {
            commentsModerationResult.textContent = "Error: " + (e.message || e);
          }
        }

        function syncEventVisibilityUi() {
          if (!eventVisibleToCustomer) return;
          const type = eventType.value;
          const isAdminNote = type === "admin_note";

          // Strict mode UX:
          // - Status is only actionable for Status Override
          // - Notes copy reflects current mode
          eventStatus.disabled = isAdminNote;
          eventStatus.title = isAdminNote
            ? "Status is only available for Status Override"
            : "Choose the new door status";

          eventNotes.placeholder = isAdminNote
            ? "Notes required for Admin Note"
            : "Optional notes for Status Override";

          eventVisibleToCustomer.disabled = !isAdminNote;
          if (!isAdminNote) eventVisibleToCustomer.checked = false;
        }

        eventType.addEventListener("change", () => {
          // Always clear status when switching modes so admins
          // never assume a previous selection still applies.
          eventStatus.value = "";
          syncEventVisibilityUi();
        });
        syncEventVisibilityUi();

        commentsLoad.onclick = loadCommentsForModeration;

        if (commentSettingsBiz) {
          commentSettingsBiz.onchange = () => {
            loadSelectedCommentSetting();
          };
        }

        if (commentSettingsSave) {
          commentSettingsSave.onclick = async () => {
            commentSettingsMsg.textContent = "";
            const biz = (commentSettingsBiz && commentSettingsBiz.value ? commentSettingsBiz.value : "").trim();
            if (!biz) {
              commentSettingsMsg.textContent = "Pick a business.";
              return;
            }

            commentSettingsSave.disabled = true;
            commentSettingsMsg.textContent = "Saving…";
            try {
              await api("/admin/comment-settings", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  biz,
                  publicCommentAutoApprove: !!(commentAutoApproveToggle && commentAutoApproveToggle.checked),
                }),
              });
              commentSettingsMsg.textContent = "Saved.";
            } catch (e) {
              commentSettingsMsg.textContent = "Error: " + (e.message || e);
            } finally {
              commentSettingsSave.disabled = false;
            }
          };
        }
        
        eventAdd.onclick = async () => {
          eventResult.textContent = "";
        
          const uid = (eventUid.value || "").trim();
          const notes = (eventNotes.value || "").trim();
          const status = eventStatus.value || null;
          const type = eventType.value;
        
          if (!uid) {
            eventResult.textContent = "UID required";
            return;
          }
        
          // Enforce intent:
          // - Admin Note → notes required, no status
          // - Status Update → status required
          if (type === "admin_note") {
            if (!notes) {
              eventResult.textContent = "Notes are required for an admin note";
              return;
            }
          } else {
            if (!status) {
              eventResult.textContent = "Status required for status update";
              return;
            }
          }
        
          eventAdd.disabled = true;
          eventResult.textContent = "Adding…";
        
          try {
            const body = {
              uid,
              eventType: type,
              notes,
              visibleToCustomer: !!(eventVisibleToCustomer && eventVisibleToCustomer.checked),
            };
        
            if (type !== "admin_note" && status) {
              body.status = status;
            }
        
            const res = await fetch("/admin/add-event", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });

            if (!res.ok) {
              eventResult.textContent = "Failed to add";
              return;
            }

            eventResult.textContent = "Event added ✓";
            eventNotes.value = "";
            eventStatus.value = "";
            if (eventVisibleToCustomer) eventVisibleToCustomer.checked = false;
          } catch (e) {
            eventResult.textContent = "Error: " + e.message;
          } finally {
            eventAdd.disabled = false;
          }
        };
        
        
        const tabParam = new URLSearchParams(window.location.search).get("tab");
        const initialTab = (tabParam === "lookup" || tabParam === "business" || tabParam === "security" || tabParam === "portal" || tabParam === "comments")
          ? tabParam
          : "lookup";
        dbg("boot:initialTab", { tabParam, initialTab });
        setTab(initialTab);
        dbg("boot:end");
      })();
      </script>
      </body>
      </html>`;
      
      return html(page);
    }

    // ===========================
    // GET /admin/businesses
    // Returns bizcfg:* from ENROLL_TOKENS
    // ===========================
    if (request.method === "GET" && pathname === "/admin/businesses") {
      const authErr = requireAdmin();
      if (authErr) return authErr;
      // Always serve a live rebuilt list to avoid stale admin visibility.
      // This route is admin-only and called interactively, so correctness wins.
      const rebuilt = await refreshBusinessesSnapshot();
      return json(rebuilt.map((row) => sanitizeBusinessRowForOutput(row)));
    }

    // ===========================
    // POST /admin/security-mode
    // Body: { biz, mode, sandboxDemo? }
    // ===========================
    if (request.method === "POST" && pathname === "/admin/security-mode") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || "");
      const rawMode = String(body.mode || "").toLowerCase().trim();
      const mode = rawMode === "secure" || rawMode === "public" || rawMode === "standard"
        ? rawMode
        : "";
      const sandboxDemo = body.sandboxDemo === true;

      if (!biz || !mode) {
        return text("biz and valid mode required", 400);
      }

      const key = `bizcfg:${biz}`;
      const raw = await env.ENROLL_TOKENS.get(key, "text");

      let cfg;
      try {
        cfg = raw ? JSON.parse(raw) : {};
      } catch {
        cfg = {};
      }

      cfg.slug = cfg.slug || biz;
      cfg.name = cfg.name || biz;
      cfg.active = cfg.active !== false;
      cfg.mode = mode;
      cfg.sandbox_demo = sandboxDemo;

      await env.ENROLL_TOKENS.put(key, JSON.stringify(cfg));
      refreshBusinessesSnapshotInBackground();

      return json({ ok: true, biz, mode, sandboxDemo: cfg.sandbox_demo === true });
    }

    // ===========================
    // GET /admin/comment-settings?biz=...
    // ===========================
    if (request.method === "GET" && pathname === "/admin/comment-settings") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const biz = slug(url.searchParams.get("biz") || "");
      if (!biz || biz === "unknown") return text("biz required", 400);

      const cfg = (await env.ENROLL_TOKENS.get(`bizcfg:${biz}`, "json")) || {};
      return json({
        ok: true,
        biz,
        publicCommentAutoApprove: cfg.public_comment_auto_approve === true,
      });
    }

    // ===========================
    // POST /admin/comment-settings
    // Body: { biz, publicCommentAutoApprove }
    // ===========================
    if (request.method === "POST" && pathname === "/admin/comment-settings") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || body.businessCode || "");
      if (!biz || biz === "unknown") return text("biz required", 400);

      const cfgKey = `bizcfg:${biz}`;
      const cfg = (await env.ENROLL_TOKENS.get(cfgKey, "json")) || {};
      cfg.slug = cfg.slug || biz;
      cfg.name = cfg.name || biz;
      cfg.active = cfg.active !== false;
      if (!cfg.mode) cfg.mode = "standard";
      cfg.public_comment_auto_approve = body.publicCommentAutoApprove === true;

      await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));
      refreshBusinessesSnapshotInBackground();

      return json({
        ok: true,
        biz,
        publicCommentAutoApprove: cfg.public_comment_auto_approve === true,
      });
    }

    // ===========================
    // POST /admin/enroll-link
    // Body: { biz }
    // Creates one-click business-scoped enrollment link
    // ===========================
    if (request.method === "POST" && pathname === "/admin/enroll-link") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || "");
      if (!biz || biz === "unknown") {
        return text("biz required", 400);
      }

      const enrollToken = crypto.randomUUID().replace(/-/g, "");
      const enrollKey = `enroll:${enrollToken}`;

      const data = {
        biz,
        scope: "business",
        created_at: Date.now(),
        uses: 0,
      };

      await env.ENROLL_TOKENS.put(enrollKey, JSON.stringify(data));

      const reportsOrigin = String(env.REPORTS_ORIGIN || "https://r.castledoorict.com").trim();
      const enrollUrl = `${reportsOrigin}/enroll/${encodeURIComponent(biz)}?t=${encodeURIComponent(enrollToken)}`;

      return json({ ok: true, biz, enrollUrl, token: enrollToken });
    }

    // ===========================
    // POST /admin/portal/first-manager-invite
    // Body: { biz, email }
    // Immediate manager activation + one-click dashboard sign-in
    // ===========================
    if (request.method === "POST" && pathname === "/admin/portal/first-manager-invite") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || body.businessCode || "");
      const email = String(body.email || "").trim().toLowerCase();
      if (!biz || biz === "unknown") return text("biz required", 400);
      if (!email || !isValidEmail(email)) return text("valid email required", 400);

      const alreadyHasManager = await hasActivePortalManager(biz);
      if (alreadyHasManager) {
        return json({
          ok: false,
          error: "Primary manager already exists for this business",
          biz,
        }, 409);
      }

      const cfgKey = `bizcfg:${biz}`;
      const cfgRaw = await env.ENROLL_TOKENS.get(cfgKey, "text");
      let cfg;
      try {
        cfg = cfgRaw ? JSON.parse(cfgRaw) : {};
      } catch {
        cfg = {};
      }

      cfg.slug = cfg.slug || biz;
      cfg.name = cfg.name || biz;
      cfg.active = cfg.active !== false;
      if (!cfg.mode) cfg.mode = "standard";
      if (typeof cfg.cta_enabled !== "boolean") cfg.cta_enabled = true;
      if (typeof cfg.cta_default_to !== "string") cfg.cta_default_to = "";
      if (typeof cfg.cta_always_cc !== "string") cfg.cta_always_cc = "";

      const dispatch = String(env.CASTLE_DISPATCH_EMAIL || "").trim().toLowerCase();
      if (dispatch) {
        const cc = cfg.cta_always_cc
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean);
        if (!cc.includes(dispatch)) cc.push(dispatch);
        cfg.cta_always_cc = cc.join(",");
      }

      await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));

      await env.ENROLL_TOKENS.put(
        `portalMember:${biz}:${email}`,
        JSON.stringify({
          businessCode: biz,
          email,
          role: "manager",
          canComment: true,
          active: true,
          createdAt: Date.now(),
          createdBy: "admin",
        })
      );

      const magicToken = crypto.randomUUID().replace(/-/g, "");
      await env.ENROLL_TOKENS.put(`portalMagic:${magicToken}`, JSON.stringify({
        token: magicToken,
        businessCode: biz,
        email,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 30,
      }));

      const portalOrigin = getPortalOrigin();
      const portalMagicUrl = `${portalOrigin}/portal/magic?t=${encodeURIComponent(magicToken)}`;
      const emailDispatch = await sendPortalInviteEmail({
        toEmail: email,
        biz,
        role: "manager",
        directSignInUrl: portalMagicUrl,
        inviter: "Castle Door Admin",
      });

      return json({
        ok: true,
        biz,
        role: "manager",
        email,
        portalMagicUrl,
        magicToken,
        emailDispatch,
        note: "Primary manager is active immediately. Email link signs in directly to dashboard.",
      });
    }

    // ===========================
    // GET /admin/portal-tools
    // Admin UI for customer portal management
    // ===========================
    if (request.method === "GET" && pathname === "/admin/portal-tools") {
      const authErr = requireAdmin();
      if (authErr) return authErr;
      return Response.redirect(`${url.origin}/admin?tab=portal`, 302);
    }

    // ===========================
    // GET /admin/portal/members?biz=...
    // ===========================
    if (request.method === "GET" && pathname === "/admin/portal/members") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const biz = slug(url.searchParams.get("biz") || "");
      if (!biz || biz === "unknown") return text("biz required", 400);

      const members = [];
      let cursor;
      do {
        const listed = await env.ENROLL_TOKENS.list({
          prefix: `portalMember:${biz}:`,
          cursor,
        });

        for (const k of listed.keys || []) {
          const row = await env.ENROLL_TOKENS.get(k.name, "json");
          if (row && typeof row === "object") members.push(row);
        }
        cursor = listed.cursor;
      } while (cursor);

      members.sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));
      return json({ ok: true, biz, members });
    }

    // ===========================
    // POST /admin/portal/invite
    // Body: { biz, email, role? }
    // Backward-compatible alias for primary manager onboarding only
    // ===========================
    if (request.method === "POST" && pathname === "/admin/portal/invite") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || body.businessCode || "");
      const email = String(body.email || "").trim().toLowerCase();
      if (!biz || biz === "unknown") return text("biz required", 400);
      if (!email || !isValidEmail(email)) return text("valid email required", 400);

      const alreadyHasManager = await hasActivePortalManager(biz);
      if (alreadyHasManager) {
        return json({
          ok: false,
          error: "Primary manager already exists for this business",
          biz,
        }, 409);
      }

      const token = crypto.randomUUID().replace(/-/g, "");
      const invite = {
        token,
        businessCode: biz,
        role: "manager",
        canComment: true,
        email,
        createdAt: Date.now(),
        createdBy: "admin",
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 14,
      };

      await env.ENROLL_TOKENS.put(`portalInvite:${token}`, JSON.stringify(invite));
      const portalOrigin = getPortalOrigin();
      const inviteUrl = `${portalOrigin}/portal/invite?t=${encodeURIComponent(token)}`;
      const emailDispatch = await sendPortalInviteEmail({
        toEmail: email,
        biz,
        role: "manager",
        inviteUrl,
        inviter: "Castle Door Admin",
      });
      return json({
        ok: true,
        biz,
        email,
        role: "manager",
        canComment: true,
        token,
        inviteUrl,
        emailDispatch,
        note: "Admin portal invite endpoint is manager-only for primary customer onboarding",
      });
    }

    // ===========================
    // POST /admin/portal/member-remove
    // Body: { biz, email }
    // ===========================
    if (request.method === "POST" && pathname === "/admin/portal/member-remove") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || body.businessCode || "");
      const email = String(body.email || "").trim().toLowerCase();
      if (!biz || biz === "unknown") return text("biz required", 400);
      if (!email || !isValidEmail(email)) return text("valid email required", 400);

      await env.ENROLL_TOKENS.delete(`portalMember:${biz}:${email}`);
      return json({ ok: true, biz, email });
    }

    // ===========================
    // GET /admin/portal/repair-settings?biz=...
    // ===========================
    if (request.method === "GET" && pathname === "/admin/portal/repair-settings") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const biz = slug(url.searchParams.get("biz") || "");
      if (!biz || biz === "unknown") return text("biz required", 400);

      const cfg = (await env.ENROLL_TOKENS.get(`bizcfg:${biz}`, "json")) || {};
      return json({
        ok: true,
        biz,
        defaultTo: typeof cfg.cta_default_to === "string" ? cfg.cta_default_to : "",
        alwaysCc: typeof cfg.cta_always_cc === "string" ? cfg.cta_always_cc : "",
        ctaEnabled: cfg.cta_enabled !== false,
      });
    }

    // ===========================
    // POST /admin/portal/repair-settings
    // Body: { biz, defaultTo, alwaysCc }
    // ===========================
    if (request.method === "POST" && pathname === "/admin/portal/repair-settings") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || body.businessCode || "");
      const defaultTo = String(body.defaultTo || "").trim().toLowerCase();
      const alwaysCcRaw = String(body.alwaysCc || "").trim();
      if (!biz || biz === "unknown") return text("biz required", 400);
      if (defaultTo && !isValidEmail(defaultTo)) return text("defaultTo must be valid email", 400);

      const cfgKey = `bizcfg:${biz}`;
      const cfg = (await env.ENROLL_TOKENS.get(cfgKey, "json")) || {};
      cfg.slug = cfg.slug || biz;
      cfg.name = cfg.name || biz;
      cfg.active = cfg.active !== false;
      if (!cfg.mode) cfg.mode = "standard";
      cfg.cta_enabled = true;
      cfg.cta_default_to = defaultTo;

      const cc = splitEmailList(alwaysCcRaw).filter((x) => isValidEmail(x));
      const dispatch = String(env.CASTLE_DISPATCH_EMAIL || "").trim().toLowerCase();
      if (dispatch && isValidEmail(dispatch) && !cc.includes(dispatch)) cc.push(dispatch);
      cfg.cta_always_cc = cc.join(",");

      await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));
      refreshBusinessesSnapshotInBackground();

      return json({
        ok: true,
        biz,
        defaultTo: cfg.cta_default_to,
        alwaysCc: cfg.cta_always_cc,
        ctaEnabled: cfg.cta_enabled,
      });
    }

    // ===========================
    // GET /admin/building-security?biz=...&buildingCode=...
    // ===========================
    if (request.method === "GET" && pathname === "/admin/building-security") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const biz = slug(url.searchParams.get("biz") || "");
      const buildingCode = String(url.searchParams.get("buildingCode") || "").trim();
      if (!biz || !buildingCode) return text("biz and buildingCode required", 400);

      const raw = await env.ENROLL_TOKENS.get(`bldsec:${biz}:${buildingCode}`, "json");
      const rawMode = String(raw && raw.mode ? raw.mode : "inherit").toLowerCase();
      const mode =
        rawMode === "inherit" || rawMode === "secure" || rawMode === "standard" || rawMode === "public"
          ? rawMode
          : "inherit";

      return json({ ok: true, biz, buildingCode, mode });
    }

    // ===========================
    // POST /admin/building-security-mode
    // Body: { biz, buildingCode, mode }
    // ===========================
    if (request.method === "POST" && pathname === "/admin/building-security-mode") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || "");
      const buildingCode = String(body.buildingCode || "").trim();
      const rawMode = String(body.mode || "inherit").toLowerCase().trim();
      const mode =
        rawMode === "inherit" || rawMode === "secure" || rawMode === "standard" || rawMode === "public"
          ? rawMode
          : "";

      if (!biz || !buildingCode || !mode) {
        return text("biz, buildingCode, and valid mode required", 400);
      }

      const key = `bldsec:${biz}:${buildingCode}`;
      const raw = await env.ENROLL_TOKENS.get(key, "text");

      let cfg;
      try {
        cfg = raw ? JSON.parse(raw) : {};
      } catch {
        cfg = {};
      }

      cfg.mode = mode;

      await env.ENROLL_TOKENS.put(key, JSON.stringify(cfg));

      return json({ ok: true, biz, buildingCode, mode });
    }

    // ===========================
    // POST /admin/merge-business
    // ===========================
    if (request.method === "POST" && pathname === "/admin/merge-business") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const fromBiz = slug(body.fromBiz || body.fromBusiness || "");
      const toBiz = slug(body.toBiz || body.toBusiness || "");

      if (!fromBiz || !toBiz || fromBiz === "unknown" || toBiz === "unknown") {
        return text("fromBiz and toBiz required", 400);
      }
      if (fromBiz === toBiz) return text("fromBiz and toBiz must differ", 400);

      const toCfgKey = `bizcfg:${toBiz}`;
      const toCfgRaw = await env.ENROLL_TOKENS.get(toCfgKey, "text");
      if (!toCfgRaw) {
        const seed = { slug: toBiz, name: toBiz, active: true };
        await env.ENROLL_TOKENS.put(toCfgKey, JSON.stringify(seed));
      }

      let movedCount = 0;
      let cursor = undefined;

      do {
        const listed = await env.REPORTS_KV.list({
          prefix: `door:${fromBiz}:`,
          cursor,
        });

        for (const { name } of listed.keys) {
          const doorRec = await env.REPORTS_KV.get(name, { type: "json" });
          if (!doorRec || !doorRec.doorId) continue;

          const parts = name.split(":");
          const buildingFromKey = parts.length >= 4 ? parts[2] : "";
          const slugFromKey = parts.length >= 4 ? parts.slice(3).join(":") : "";

          const doorId = String(doorRec.doorId);
          const uid = safeDoorId(doorId);

          const buildingCode =
            (doorRec.buildingCode && String(doorRec.buildingCode)) ||
            buildingFromKey ||
            slug(doorRec.building || "main");

          const doorSlug =
            (doorRec.doorSlug && String(doorRec.doorSlug)) ||
            slugFromKey ||
            slug(doorRec.displayLabel || doorRec.doorLabel || "door");

          const newDoorKey = `door:${toBiz}:${buildingCode}:${doorSlug}`;

          const nextRec = {
            ...doorRec,
            businessCode: toBiz,
            buildingCode,
            doorSlug,
          };
          await env.REPORTS_KV.put(newDoorKey, JSON.stringify(nextRec));

          await env.REPORTS_KV.put(
            `doorIndex:${uid}`,
            JSON.stringify({ businessCode: toBiz, buildingCode, doorSlug })
          );

          await env.REPORTS_KV.delete(name);

          movedCount++;
        }

        cursor = listed.cursor;
      } while (cursor);

      const fromCfgKey = `bizcfg:${fromBiz}`;
      const fromCfgRaw = await env.ENROLL_TOKENS.get(fromCfgKey, "text");
      let fromCfg;
      try {
        fromCfg = fromCfgRaw ? JSON.parse(fromCfgRaw) : {};
      } catch {
        fromCfg = {};
      }
      fromCfg.slug = fromBiz;
      fromCfg.name = fromCfg.name || fromBiz;
      fromCfg.active = false;
      fromCfg.merged_into = toBiz;
      await env.ENROLL_TOKENS.put(fromCfgKey, JSON.stringify(fromCfg));

      refreshBusinessesSnapshotInBackground();
      return json({ ok: true, fromBiz, toBiz, movedCount });
    }

    // =====================================================
    // GET /admin/business/:biz/doors
    // Returns doors for a business
    // =====================================================
    if (
      request.method === "GET" &&
      pathname.startsWith("/admin/business/") &&
      pathname.endsWith("/doors")
    ) {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const parts = pathname.split("/").filter(Boolean);
      const biz = parts[2];

      const out = [];
      let cursor;

      do {
        const list = await env.REPORTS_KV.list({
          prefix: `door:${biz}:`,
          cursor,
        });

        for (const { name } of list.keys) {
          const rec = await env.REPORTS_KV.get(name, "json");
          if (!rec || !rec.doorId) continue;

          out.push({
            uid: safeDoorId(rec.doorId),
            doorId: rec.doorId,
            doorSlug: rec.doorSlug || "",
            label: rec.displayLabel || rec.doorLabel || rec.doorId,
            buildingCode: rec.buildingCode || "main",
          });
        }

        cursor = list.cursor;
      } while (cursor);

      return json(out);
    }

// =====================================================
// GET /admin/business/:biz/buildings
// Returns distinct building codes + door counts + displayName
// =====================================================
if (
  request.method === "GET" &&
  pathname.startsWith("/admin/business/") &&
  pathname.endsWith("/buildings")
) {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const parts = pathname.split("/").filter(Boolean);
  const biz = parts[2];

  const counts = {};
  let cursor;

  do {
    const list = await env.REPORTS_KV.list({
      prefix: `door:${biz}:`,
      cursor,
    });

    for (const { name } of list.keys) {
      // door:<biz>:<building>:<doorSlug>
      const segs = name.split(":");
      if (segs.length < 4) continue;

      const buildingCode = segs[2];
      counts[buildingCode] = (counts[buildingCode] || 0) + 1;
    }

    cursor = list.cursor;
  } while (cursor);

  const out = [];

  // Attach friendly names if present; otherwise fall back to uploaded building name
  for (const [buildingCode, doorCount] of Object.entries(counts)) {
    if (!doorCount) continue;
  
    // Stored as: bldcfg:<biz>:<buildingCode> → { name: "East Wing" }
    const cfgKey = `bldcfg:${biz}:${buildingCode}`;
    const cfg = await env.REPORTS_KV.get(cfgKey, "json");

    let displayName = cfg?.name ? String(cfg.name).trim() : "";

    // Fallback: use uploaded building name from any door record
    if (!displayName) {
      const sample = await env.REPORTS_KV.list({
        prefix: `door:${biz}:${buildingCode}:`,
        limit: 1,
      });

      if (sample.keys && sample.keys.length) {
        const rec = await env.REPORTS_KV.get(sample.keys[0].name, "json");

        const candidate =
        rec?.building ||
        rec?.buildingLabel ||
        rec?.customMetadata?.building ||
        "";
      
      if (candidate && String(candidate).trim()) {
        displayName = String(candidate).trim();

        // Seed so admin stays consistent going forward
        await env.REPORTS_KV.put(
          cfgKey,
          JSON.stringify({ name: displayName })
        );
        }
      }
    }
// Final fallback: unnamed buildings become "Main"
if (!displayName) {
  displayName = "Main";
}

out.push({
  buildingCode,
  doorCount,
  displayName,
});
  }

  // Keep list stable + readable
  out.sort((a, b) =>
    String(a.displayName || a.buildingCode).localeCompare(
      String(b.displayName || b.buildingCode)
    )
  );

  return json(out);
}

    // =====================================================
    // POST /admin/merge-building
    // Body: { biz, fromBuildings[], toBuilding }
    // =====================================================
    if (request.method === "POST" && pathname === "/admin/merge-building") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON body", 400);

      const biz = slug(body.biz || "");

      const fromBuildings = Array.isArray(body.fromBuildings)
        ? body.fromBuildings.map(x => String(x || "").trim()).filter(Boolean)
        : [];

      const toBuilding = String(body.toBuilding || "").trim();

      if (!biz || !fromBuildings.length || !toBuilding) {
        return text("biz, fromBuildings[], toBuilding required", 400);
      }

      const bad = (s) => s.includes(":") || s.length > 80;
      if (fromBuildings.some(bad) || bad(toBuilding)) {
        return text("Invalid building code", 400);
      }

      if (fromBuildings.includes(toBuilding)) {
        return text("Destination cannot be included in fromBuildings", 400);
      }

      let movedCount = 0;

      for (const fromBuilding of fromBuildings) {
        let cursor;

        do {
          const list = await env.REPORTS_KV.list({
            prefix: `door:${biz}:${fromBuilding}:`,
            cursor,
          });

          for (const { name } of list.keys) {
            const rec = await env.REPORTS_KV.get(name, "json");
            if (!rec || !rec.doorId) continue;

            const segs = name.split(":");
            const doorSlug = segs.slice(3).join(":"); // preserve exactly

            const uid = safeDoorId(rec.doorId);

            const newKey = `door:${biz}:${toBuilding}:${doorSlug}`;

            const nextRec = {
              ...rec,

              // Assignment change ONLY
              buildingCode: toBuilding,

              // IMPORTANT: do NOT overwrite human building display name here.
              // Display names are stored separately in bldcfg:<biz>:<buildingCode>.
            };

            await env.REPORTS_KV.put(newKey, JSON.stringify(nextRec));

            await env.REPORTS_KV.put(
              `doorIndex:${uid}`,
              JSON.stringify({
                businessCode: biz,
                buildingCode: toBuilding,
                doorSlug,
              })
            );

            await env.REPORTS_KV.delete(name);

            movedCount++;
          }

          cursor = list.cursor;
        } while (cursor);
      }

      refreshBusinessesSnapshotInBackground();
      return json({
        ok: true,
        biz,
        fromBuildings,
        toBuilding,
        movedCount,
      });
    }

    // =====================================================
    // POST /admin/building-name
    // Body: { biz, buildingCode, name }
    // =====================================================
    if (request.method === "POST" && pathname === "/admin/building-name") {
      const authErr = requireAdmin();
      if (authErr) return authErr;

      const body = await readJsonBody();
      if (!body) return text("Expected JSON", 400);

      const biz = slug(body.biz || "");
      const buildingCode = String(body.buildingCode || "").trim();
      const name = String(body.name || "").trim();

      if (!biz || !buildingCode || !name) {
        return text("biz, buildingCode, name required", 400);
      }

      await env.REPORTS_KV.put(
        `bldcfg:${biz}:${buildingCode}`,
        JSON.stringify({ name })
      );

      refreshBusinessesSnapshotInBackground();
      return json({ ok: true });
    }

// =====================================================
// POST /admin/reassign-uids
// Body: { uids[], toBiz }
// =====================================================
if (request.method === "POST" && pathname === "/admin/reassign-uids") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const body = await readJsonBody();
  if (!body || !Array.isArray(body.uids) || !body.toBiz) {
    return text("Bad request", 400);
  }

  const toBiz = slug(body.toBiz);

  // Ensure destination business config exists
  async function ensureBizConfig(bizCode) {
    const cfgKey = `bizcfg:${bizCode}`;
    const raw = await env.ENROLL_TOKENS.get(cfgKey, "text");
    if (raw) return;

    const cfg = {
      slug: bizCode,
      name: bizCode,
      mode: "standard",
    };

    await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));
  }

  await ensureBizConfig(toBiz);

  let moved = 0;

  for (const uid of body.uids) {
    const map = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");
    if (!map) continue;

    const { businessCode, buildingCode, doorSlug } = map;
    const oldKey = `door:${businessCode}:${buildingCode}:${doorSlug}`;
    const rec = await env.REPORTS_KV.get(oldKey, "json");
    if (!rec) continue;

    const newKey = `door:${toBiz}:${buildingCode}:${doorSlug}`;

    const nextRec = {
      ...rec,

      // explicitly preserve viewer-critical fields
      status: rec.status,
      inspectedAt: rec.inspectedAt,
      lastInspectedAt: rec.lastInspectedAt,

      // assignment change ONLY
      businessCode: toBiz,
    };

    await env.REPORTS_KV.put(newKey, JSON.stringify(nextRec));

    await env.REPORTS_KV.put(
      `doorIndex:${uid}`,
      JSON.stringify({ businessCode: toBiz, buildingCode, doorSlug })
    );

    await env.REPORTS_KV.delete(oldKey);
    moved++;
  }

  refreshBusinessesSnapshotInBackground();
  return json({ ok: true, moved });
}

// =====================================================
// GET /admin/search?q=XXXX
// Partial search across UID + label + door slug
// Returns multiple matches
// =====================================================
if (request.method === "GET" && pathname === "/admin/search") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const q = String(url.searchParams.get("q") || "").trim();
  const maxScanRaw = Number(url.searchParams.get("maxScan") || "600");
  const maxMsRaw = Number(url.searchParams.get("maxMs") || "4500");
  const maxScan = Number.isFinite(maxScanRaw)
    ? Math.max(100, Math.min(5000, Math.trunc(maxScanRaw)))
    : 600;
  const maxMs = Number.isFinite(maxMsRaw)
    ? Math.max(500, Math.min(15000, Math.trunc(maxMsRaw)))
    : 4500;
  if (!q) return json({ ok: true, q: "", matches: [] });

  const qNorm = safeDoorId(q).toLowerCase();
  const qText = q.toLowerCase();

  // Keep it sane: 1-2 char searches would force scanning everything
  if (qNorm.length < 2) {
    return json({ ok: false, error: "Search must be at least 2 characters." }, 400);
  }

  const matches = [];
  const seenUid = new Set();

  const pushDoorIndexMatch = async (uid, source = "doorIndex") => {
    const uidNorm = String(uid || "").toLowerCase();
    if (!uid || seenUid.has(uidNorm) || matches.length >= 50) return;

    const doorIndexKey = `doorIndex:${uid}`;
    const uidEventsKey = `uidEvents:${uid}`;
    const map = await env.REPORTS_KV.get(doorIndexKey, "json");
    let label = "";
    let doorSlug = map?.doorSlug || "";
    let doorKey = "";
    let lastReportKey = "";
    let isStaleMismatch = false;

    if (map?.businessCode && map?.buildingCode && map?.doorSlug) {
      doorKey = `door:${map.businessCode}:${map.buildingCode}:${map.doorSlug}`;
      const rec = await env.REPORTS_KV.get(doorKey, "json");
      if (rec) {
        label = rec.displayLabel || rec.doorLabel || "";
        if (!doorSlug && rec.doorSlug) doorSlug = String(rec.doorSlug);
        lastReportKey = String(rec.lastReportKey || "");
      }
    }

    matches.push({
      uid,
      source,
      businessCode: map?.businessCode || "",
      buildingCode: map?.buildingCode || "",
      doorSlug,
      label,
      doorIndexKey,
      doorKey,
      uidEventsKey,
      lastReportKey,
      isStaleMismatch,
      hasDoorIndex: true,
    });
    seenUid.add(uidNorm);
  };

  // ---------- 0) Exact UID lookup first ----------
  await pushDoorIndexMatch(qNorm, "doorIndex_exact");

  // ---------- 1) Prefix search on doorIndex:<uid> (fast path) ----------
  let cursor;
  do {
    const list = await env.REPORTS_KV.list({
      prefix: `doorIndex:${qNorm}`,
      cursor,
      limit: 100,
    });

    for (const { name } of list.keys) {
      const uid = name.slice("doorIndex:".length);
      await pushDoorIndexMatch(uid, "doorIndex_prefix");
      if (matches.length >= 50) break;
    }

    cursor = list.cursor;
  } while (cursor && matches.length < 50);

  // ---------- 2) Deep scan for UID + label + door slug matches ----------
  // Needed to support door-label / slug search and to catch missing doorIndex pointers.
  cursor = undefined;
  let scannedDoorRecords = 0;
  let scanTruncated = false;
  const startedAt = Date.now();
  let truncatedReason = "";
  do {
    if (Date.now() - startedAt > maxMs) {
      scanTruncated = true;
      truncatedReason = "time_budget";
      break;
    }

    const list = await env.REPORTS_KV.list({ prefix: "door:", cursor, limit: 200 });
    for (const { name } of list.keys) {
      if (Date.now() - startedAt > maxMs) {
        scanTruncated = true;
        truncatedReason = "time_budget";
        break;
      }

      scannedDoorRecords++;
      if (scannedDoorRecords > maxScan) {
        scanTruncated = true;
        truncatedReason = "scan_budget";
        break;
      }

      const rec = await env.REPORTS_KV.get(name, "json");
      if (!rec?.doorId) continue;

      const uid = safeDoorId(rec.doorId);
      const uidNorm = uid.toLowerCase();

      const parts = name.split(":");
      const businessCode = parts[1] || "";
      const buildingCode = parts[2] || "";
      const keyDoorSlug = parts.slice(3).join(":") || "";
      const recDoorSlug = String(rec.doorSlug || "");
      const doorSlug = recDoorSlug || keyDoorSlug;
      const doorKey = `door:${businessCode}:${buildingCode}:${doorSlug}`;
      const doorIndexKey = `doorIndex:${uid}`;
      const uidEventsKey = `uidEvents:${uid}`;
      const lastReportKey = String(rec.lastReportKey || "");

      const labelRaw = String(rec.displayLabel || rec.doorLabel || uid);
      const label = labelRaw.toLowerCase();
      const slugSearch = String(doorSlug || "").toLowerCase();

      const isMatch =
        uidNorm.includes(qNorm) ||
        label.includes(qText) ||
        slugSearch.includes(qText);

      if (!isMatch) continue;

      const uidSeen = seenUid.has(uidNorm);
      if (uidSeen) continue;

      const doorIndex = await env.REPORTS_KV.get(doorIndexKey, "json");
      const isStaleMismatch = !!(
        doorIndex &&
        (
          String(doorIndex.businessCode || "") !== String(businessCode || "") ||
          String(doorIndex.buildingCode || "") !== String(buildingCode || "") ||
          String(doorIndex.doorSlug || "") !== String(doorSlug || "")
        )
      );

      matches.push({
        uid,
        source: "door_deep",
        businessCode,
        buildingCode,
        doorSlug,
        label: labelRaw,
        doorIndexKey,
        doorKey,
        uidEventsKey,
        lastReportKey,
        isStaleMismatch,
        hasDoorIndex: !!doorIndex,
      });
      seenUid.add(uidNorm);

      if (matches.length >= 50) break;
    }
    if (scanTruncated || matches.length >= 50) break;
    cursor = list.cursor;
  } while (cursor && matches.length < 50);

  return json({
    ok: true,
    q,
    matches,
    scan: {
      scannedDoorRecords,
      maxScan,
      maxMs,
      truncated: scanTruncated,
      truncatedReason: truncatedReason || null,
      hasMore: !!cursor,
    },
  });
}
// =====================================================
// GET /admin/stale-doors
// Lists doors that exist in a business listing but whose
// UID resolves elsewhere via doorIndex
// =====================================================
if (request.method === "GET" && pathname === "/admin/stale-doors") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const stale = [];
  let cursor;

  do {
    const list = await env.REPORTS_KV.list({
      prefix: "door:",
      cursor,
    });

    for (const { name } of list.keys) {
      const rec = await env.REPORTS_KV.get(name, "json");
      if (!rec?.doorId) continue;

      const uid = safeDoorId(rec.doorId);
      const idx = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");
      if (!idx) continue;

      // Parse this door's claimed location
      const parts = name.split(":");
      const biz = parts[1];
      const bld = parts[2];
      const slug = parts.slice(3).join(":");

      const mismatch =
        idx.businessCode !== biz ||
        idx.buildingCode !== bld ||
        idx.doorSlug !== slug;

      if (!mismatch) continue;

      stale.push({
        uid,
        listedAt: {
          businessCode: biz,
          buildingCode: bld,
          doorSlug: slug,
        },
        canonical: idx,
        label: rec.displayLabel || rec.doorLabel || uid,
      });
    }

    cursor = list.cursor;
  } while (cursor);

  return json({
    ok: true,
    count: stale.length,
    stale,
  });
}
// =====================================================
// POST /admin/purge-stale-doors
// Deletes stale door listings that contradict doorIndex
// =====================================================
if (request.method === "POST" && pathname === "/admin/purge-stale-doors") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const removed = [];
  let cursor;

  do {
    const list = await env.REPORTS_KV.list({
      prefix: "door:",
      cursor,
    });

    for (const { name } of list.keys) {
      const rec = await env.REPORTS_KV.get(name, "json");
      if (!rec?.doorId) continue;

      const uid = safeDoorId(rec.doorId);
      const canonical = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");
      if (!canonical) continue;

      // Parse this door's current listing location
      const parts = name.split(":");
      if (parts.length < 4) continue;

      const listedBiz = parts[1];
      const listedBld = parts[2];
      const listedSlug = parts.slice(3).join(":");

      const isStale =
        canonical.businessCode !== listedBiz ||
        canonical.buildingCode !== listedBld ||
        canonical.doorSlug !== listedSlug;

      if (!isStale) continue;

      // Delete ONLY the stale listing
      await env.REPORTS_KV.delete(name);

      removed.push({
        uid,
        removedFrom: {
          businessCode: listedBiz,
          buildingCode: listedBld,
          doorSlug: listedSlug,
        },
        canonical,
        label: rec.displayLabel || rec.doorLabel || uid,
      });
    }

    cursor = list.cursor;
  } while (cursor);

  return json({
    ok: true,
    removedCount: removed.length,
    removed,
  });
}

// =====================================================
// POST /admin/repair-doorindex
// Body: { uid }
// Restores QR pointer if missing
// =====================================================
if (request.method === "POST" && pathname === "/admin/repair-doorindex") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const body = await readJsonBody();
  if (!body || !body.uid) return text("uid required", 400);

  const uid = safeDoorId(body.uid);

  let cursor;
  let repaired = false;

  do {
    const list = await env.REPORTS_KV.list({
      prefix: "door:",
      cursor,
    });

    for (const { name } of list.keys) {
      const rec = await env.REPORTS_KV.get(name, "json");
      if (!rec || !rec.doorId) continue;

      if (safeDoorId(rec.doorId) !== uid) continue;

      // Parse key
      const parts = name.split(":");
      const businessCode = parts[1];
      const buildingCode = parts[2];
      const doorSlug = parts.slice(3).join(":");

      // Rewrite doorIndex pointer
      await env.REPORTS_KV.put(
        `doorIndex:${uid}`,
        JSON.stringify({ businessCode, buildingCode, doorSlug })
      );

      repaired = true;
      break;
    }

    cursor = list.cursor;
  } while (cursor && !repaired);

  return json({ ok: repaired, uid });
}

// =====================================================
// POST /admin/hard-delete-uid
// Body: { uid, confirmText }
// Destructive delete: removes KV + R2 artifacts for UID.
// =====================================================
if (request.method === "POST" && pathname === "/admin/hard-delete-uid") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  if (!env.REPORTS_BUCKET) {
    return text("Missing REPORTS_BUCKET binding", 500);
  }

  const body = await readJsonBody();
  if (!body || !body.uid) return text("uid required", 400);

  const uid = safeDoorId(String(body.uid || "").trim());
  if (!uid) return text("uid required", 400);

  const confirmText = String(body.confirmText || "").trim();
  const expected = `DELETE UID ${uid}`;
  if (confirmText !== expected) {
    return json({
      ok: false,
      error: "Typed confirmation mismatch",
      expected,
    }, 400);
  }

  const kvKeysToDelete = new Set([
    `doorIndex:${uid}`,
    `door:${uid}`,
    `uidEvents:${uid}`,
  ]);
  const r2KeysToDelete = new Set();

  // Gather canonical mapped door key from pointer (if present)
  const pointer = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");
  if (pointer && pointer.businessCode && pointer.buildingCode && pointer.doorSlug) {
    kvKeysToDelete.add(`door:${pointer.businessCode}:${pointer.buildingCode}:${pointer.doorSlug}`);
  }

  // Gather any stale/duplicate door listings that still reference this UID.
  let cursor;
  do {
    const listed = await env.REPORTS_KV.list({ prefix: "door:", cursor, limit: 200 });
    for (const k of listed.keys || []) {
      const keyName = String(k.name || "");
      const segs = keyName.split(":");
      if (segs.length < 4) continue;

      const rec = await env.REPORTS_KV.get(keyName, "json");
      if (!rec || typeof rec !== "object") continue;
      const recUid = safeDoorId(rec.doorId || rec.uid || "");
      if (!recUid || recUid !== uid) continue;
      kvKeysToDelete.add(keyName);
    }
    cursor = listed.cursor;
  } while (cursor);

  // Gather comments for UID.
  cursor = undefined;
  do {
    const listed = await env.REPORTS_KV.list({ prefix: `comment:${uid}:`, cursor, limit: 200 });
    for (const k of listed.keys || []) {
      kvKeysToDelete.add(String(k.name || ""));
    }
    cursor = listed.cursor;
  } while (cursor);

  // Gather R2 object keys from uidEvents history (customer/admin PDFs), then from prefix scan.
  const uidEvents = await env.REPORTS_KV.get(`uidEvents:${uid}`, "json");
  if (Array.isArray(uidEvents)) {
    for (const ev of uidEvents) {
      if (!ev || typeof ev !== "object") continue;
      const customerKey = String(ev?.pdfs?.customer?.objectKey || "").trim();
      const adminKey = String(ev?.pdfs?.admin?.objectKey || "").trim();
      const legacyKey = String(ev?.objectKey || ev?.key || "").trim();
      if (customerKey) r2KeysToDelete.add(customerKey);
      if (adminKey) r2KeysToDelete.add(adminKey);
      if (legacyKey) r2KeysToDelete.add(legacyKey);
    }
  }

  cursor = undefined;
  do {
    const listed = await env.REPORTS_BUCKET.list({ prefix: `${uid}/`, cursor, limit: 200 });
    for (const obj of listed.objects || []) {
      const key = String(obj && obj.key ? obj.key : "").trim();
      if (key) r2KeysToDelete.add(key);
    }
    cursor = listed.cursor;
  } while (cursor);

  // Execute KV deletes.
  let kvDeletedCount = 0;
  for (const key of kvKeysToDelete) {
    if (!key) continue;
    await env.REPORTS_KV.delete(key);
    kvDeletedCount++;
  }

  // Execute R2 deletes.
  let r2DeletedCount = 0;
  for (const key of r2KeysToDelete) {
    if (!key) continue;
    await env.REPORTS_BUCKET.delete(key);
    r2DeletedCount++;
  }

  refreshBusinessesSnapshotInBackground();

  return json({
    ok: true,
    uid,
    kvDeletedCount,
    r2DeletedCount,
    deletedKvKeysPreview: Array.from(kvKeysToDelete).slice(0, 40),
    deletedR2KeysPreview: Array.from(r2KeysToDelete).slice(0, 40),
  });
}
// =====================================================
// POST /admin/business-repair
// Body: { biz }
// Repairs old doors inside ONE business:
// - Ensures doorIndex:<uid> exists
// - Ensures buildingCode + doorSlug fields exist
// Safe: does NOT move PDFs or delete history
// =====================================================
if (request.method === "POST" && pathname === "/admin/business-repair") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const body = await readJsonBody();
  if (!body || !body.biz) return text("biz required", 400);

  const biz = String(body.biz).trim();

  let repaired = 0;
  let cursor;

  do {
    const list = await env.REPORTS_KV.list({
      prefix: `door:${biz}:`,
      cursor,
    });

    for (const { name } of list.keys) {
      const rec = await env.REPORTS_KV.get(name, "json");
      if (!rec || !rec.doorId) continue;

      const uid = safeDoorId(rec.doorId);

      // Parse key: door:<biz>:<building>:<doorSlug>
      const parts = name.split(":");
      const buildingCode = parts[2] || "main";
      const doorSlug = parts.slice(3).join(":") || slug(rec.displayLabel || uid);

      // Patch missing fields in record
      let changed = false;

      if (!rec.businessCode) {
        rec.businessCode = biz;
        changed = true;
      }
      if (!rec.buildingCode) {
        rec.buildingCode = buildingCode;
        changed = true;
      }
      if (!rec.doorSlug) {
        rec.doorSlug = doorSlug;
        changed = true;
      }

      if (changed) {
        await env.REPORTS_KV.put(name, JSON.stringify(rec));
      }

      // Ensure doorIndex pointer exists
      const idxKey = `doorIndex:${uid}`;
      const existing = await env.REPORTS_KV.get(idxKey, "json");

      if (!existing) {
        await env.REPORTS_KV.put(
          idxKey,
          JSON.stringify({
            businessCode: biz,
            buildingCode,
            doorSlug,
          })
        );
        repaired++;
      }
    }

    cursor = list.cursor;
  } while (cursor);

  return json({
    ok: true,
    biz,
    repairedDoorIndex: repaired,
  });
}

// =====================================================
// POST /admin/add-event
// Body: { uid, eventType?, status?, notes }
// Adds admin event (note or status change) to event history
// =====================================================
if (request.method === "POST" && pathname === "/admin/add-event") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const body = await readJsonBody();
  if (!body || !body.uid) {
    return text("uid required", 400);
  }

  const uid = safeDoorId(body.uid);
  const eventType = body.eventType || "admin_event";
  const rawStatus = body.status ? String(body.status).trim() : null;
  const notes = body.notes ? String(body.notes).trim() : "";
  const visibleToCustomer = body.visibleToCustomer === true;

  statusDebug("/admin/add-event request", {
    uid,
    eventType,
    rawStatus,
    hasNotes: !!notes,
    visibleToCustomer,
  });

  // Canonical internal statuses only
  const ALLOWED_STATUSES = new Set([
    "Pass",
    "Conditional Pass",
    "Needs Repair",
    "Fail", // accepted input, normalized below
  ]);

  if (rawStatus && !ALLOWED_STATUSES.has(rawStatus)) {
    return text("Invalid status", 400);
  }

  if (!notes && !rawStatus) {
    return text("Must provide notes or status", 400);
  }

  // Normalize admin input → canonical internal status
  let normalizedStatus = rawStatus;
  if (normalizedStatus === "Fail") {
    normalizedStatus = "Needs Repair";
  }

  // Look up door via doorIndex
  let pointer = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");

  // Fallback: search for door if doorIndex missing
  if (!pointer) {
    let cursor;
    let found = false;

    do {
      const list = await env.REPORTS_KV.list({
        prefix: "door:",
        cursor,
      });

      for (const { name } of list.keys) {
        const rec = await env.REPORTS_KV.get(name, "json");
        if (!rec || !rec.doorId) continue;

        if (safeDoorId(rec.doorId) === uid) {
          const parts = name.split(":");
          pointer = {
            businessCode: parts[1],
            buildingCode: parts[2],
            doorSlug: parts.slice(3).join(":"),
          };

          await env.REPORTS_KV.put(
            `doorIndex:${uid}`,
            JSON.stringify(pointer)
          );

          found = true;
          break;
        }
      }

      if (found) break;
      cursor = list.cursor;
    } while (cursor);

    if (!pointer) {
      return text("Door not found. UID: " + uid, 404);
    }
  }

  const { businessCode, buildingCode, doorSlug } = pointer;
  const doorKey = `door:${businessCode}:${buildingCode}:${doorSlug}`;
  const uidKey = `door:${uid}`;

  statusDebug("/admin/add-event pointer", {
    uid,
    pointer,
    doorKey,
  });

  const [doorRecByPath, doorRecByUid] = await Promise.all([
    env.REPORTS_KV.get(doorKey, "json"),
    env.REPORTS_KV.get(uidKey, "json"),
  ]);

  const doorRec =
    (doorRecByPath && typeof doorRecByPath === "object")
      ? doorRecByPath
      : ((doorRecByUid && typeof doorRecByUid === "object") ? doorRecByUid : null);

  if (!doorRec) {
    statusDebug("/admin/add-event missing-door-record", {
      uid,
      doorKey,
      uidKey,
    });
    return text("Door record not found at: " + doorKey, 404);
  }

  // Create admin event
  const now = new Date();
  const timestamp = now.toISOString();

  const newEvent = {
    source: "admin",
    type: eventType,
    timestamp,
    notes,
    visibleToCustomer: visibleToCustomer,
  };

  if (normalizedStatus) {
    newEvent.status = normalizedStatus;
  }

  // Status updates should affect current door status immediately,
  // while admin notes remain history-only.
  const shouldMutateTopLevelStatus =
    Boolean(normalizedStatus) && eventType !== "admin_note";

  statusDebug("/admin/add-event mutation-decision", {
    uid,
    eventType,
    rawStatus,
    normalizedStatus,
    shouldMutateTopLevelStatus,
    previousStatus: doorRec.status ?? null,
    previousSeverity: doorRec.severity ?? null,
  });

  if (shouldMutateTopLevelStatus) {
    doorRec.status = normalizedStatus;
  }

  if (!Array.isArray(doorRec.eventHistory)) {
    doorRec.eventHistory = [];
  }

  doorRec.eventHistory.unshift(newEvent);

  // Save updated door record to both canonical views:
  // - assignment path record used by sidebar queries
  // - UID-first canonical record used for stable UID-centric state
  const nextPathRec = {
    ...doorRec,
    businessCode,
    buildingCode,
    doorSlug,
  };

  const nextUidRec = {
    ...(doorRecByUid && typeof doorRecByUid === "object" ? doorRecByUid : {}),
    ...doorRec,
    uid,
    businessCode,
    buildingCode,
    doorSlug,
  };

  await Promise.all([
    env.REPORTS_KV.put(doorKey, JSON.stringify(nextPathRec)),
    env.REPORTS_KV.put(uidKey, JSON.stringify(nextUidRec)),
  ]);

  statusDebug("/admin/add-event write-complete", {
    uid,
    doorKey,
    writtenStatus: doorRec.status ?? null,
    writtenSeverity: doorRec.severity ?? null,
    historyCount: Array.isArray(doorRec.eventHistory) ? doorRec.eventHistory.length : 0,
  });

  return json({
    ok: true,
    uid,
    event: newEvent,
  });
}

// =====================================================
// GET /admin/comments?status=pending|approved|rejected|all&uid=...&limit=200
// Lists customer comments for moderation
// =====================================================
if (request.method === "GET" && pathname === "/admin/comments") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const rawStatus = String(url.searchParams.get("status") || "pending").trim().toLowerCase();
  const statusFilter =
    rawStatus === "approved" || rawStatus === "rejected" || rawStatus === "pending" || rawStatus === "all"
      ? rawStatus
      : "pending";

  const uidFilterRaw = String(url.searchParams.get("uid") || "").trim();
  const uidFilter = uidFilterRaw ? safeDoorId(uidFilterRaw) : "";

  const limitRaw = Number(url.searchParams.get("limit") || "200");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.trunc(limitRaw), 500)) : 200;

  const prefix = uidFilter ? `comment:${uidFilter}:` : "comment:";

  const comments = [];
  let cursor;

  do {
    const listed = await env.REPORTS_KV.list({ prefix, cursor });

    for (const { name } of listed.keys || []) {
      const rec = await env.REPORTS_KV.get(name, "json");
      if (!rec || typeof rec !== "object") continue;

      const status = String(rec.status || "pending").trim().toLowerCase();
      if (statusFilter !== "all" && status !== statusFilter) continue;

      comments.push({
        commentKey: name,
        commentId: rec.commentId || null,
        uid: rec.uid || "",
        message: rec.message || "",
        requesterName: rec.requesterName || null,
        requesterEmail: rec.requesterEmail || null,
        status,
        createdAt: rec.createdAt || null,
        moderatedAt: rec.moderatedAt || null,
        moderationReason: rec.moderationReason || null,
        businessCode: rec.businessCode || null,
        buildingCode: rec.buildingCode || null,
        doorSlug: rec.doorSlug || null,
      });

      if (comments.length >= limit) break;
    }

    cursor = listed.cursor;
  } while (cursor && comments.length < limit);

  comments.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  return json({
    ok: true,
    count: comments.length,
    status: statusFilter,
    uid: uidFilter || null,
    comments,
  });
}

// =====================================================
// POST /admin/comments/moderate
// Body: { commentKey, action: approve|reject, moderationReason? }
// =====================================================
if (request.method === "POST" && pathname === "/admin/comments/moderate") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const body = await readJsonBody();
  if (!body) return text("Expected JSON body", 400);

  const commentKey = String(body.commentKey || "").trim();
  const action = String(body.action || "").trim().toLowerCase();
  const moderationReason = String(body.moderationReason || "").trim().slice(0, 500);

  if (!commentKey || !commentKey.startsWith("comment:")) {
    return text("commentKey is required", 400);
  }

  if (action !== "approve" && action !== "reject") {
    return text("action must be approve or reject", 400);
  }

  const rec = await env.REPORTS_KV.get(commentKey, "json");
  if (!rec || typeof rec !== "object") {
    return text("Comment not found", 404);
  }

  rec.status = action === "approve" ? "approved" : "rejected";
  rec.moderatedAt = new Date().toISOString();
  rec.moderationReason = moderationReason || null;

  await env.REPORTS_KV.put(commentKey, JSON.stringify(rec));

  return json({
    ok: true,
    commentKey,
    status: rec.status,
    moderatedAt: rec.moderatedAt,
  });
}

// =====================================================
// POST /admin/set-status
// Body: { uid, status? , severity? }
// Directly mutates door record fields (NO event created)
// Canonical write field is status. severity is accepted as legacy input
// and mirrored for backward compatibility.
// =====================================================
if (request.method === "POST" && pathname === "/admin/set-status") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const body = await readJsonBody();
  if (!body || !body.uid) return text("uid required", 400);

  const uid = safeDoorId(body.uid);

  const pointer = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");
  if (!pointer) return text("Door not found", 404);

  const { businessCode, buildingCode, doorSlug } = pointer;
  const doorKey = `door:${businessCode}:${buildingCode}:${doorSlug}`;
  const uidKey = `door:${uid}`;

  const [recByPath, recByUid] = await Promise.all([
    env.REPORTS_KV.get(doorKey, "json"),
    env.REPORTS_KV.get(uidKey, "json"),
  ]);

  const rec =
    (recByPath && typeof recByPath === "object")
      ? recByPath
      : ((recByUid && typeof recByUid === "object") ? recByUid : null);
  if (!rec) return text("Door record missing", 404);

  const rawStatus = body.status != null ? String(body.status).trim() : "";
  const rawSeverity = body.severity != null ? String(body.severity).trim() : "";
  const nextStatus = rawStatus || rawSeverity;
  if (!nextStatus) return text("status required", 400);

  statusDebug("/admin/set-status request", {
    uid,
    doorKey,
    rawStatus,
    rawSeverity,
    previousStatus: rec.status ?? null,
    previousSeverity: rec.severity ?? null,
  });

  // Canonical status write.
  rec.status = nextStatus;
  // Legacy mirror for compatibility with older readers that still inspect severity.
  rec.severity = nextStatus;

  const nextPathRec = {
    ...rec,
    businessCode,
    buildingCode,
    doorSlug,
  };

  const nextUidRec = {
    ...(recByUid && typeof recByUid === "object" ? recByUid : {}),
    ...rec,
    uid,
    businessCode,
    buildingCode,
    doorSlug,
  };

  await Promise.all([
    env.REPORTS_KV.put(doorKey, JSON.stringify(nextPathRec)),
    env.REPORTS_KV.put(uidKey, JSON.stringify(nextUidRec)),
  ]);

  statusDebug("/admin/set-status write-complete", {
    uid,
    doorKey,
    writtenStatus: rec.status ?? null,
    writtenSeverity: rec.severity ?? null,
  });

  return json({
    ok: true,
    uid,
    updated: {
      status: rec.status ?? null,
      severity: rec.severity ?? null,
    },
    doorKey,
  });
}

    return text("Not found", 404);
  },
};
