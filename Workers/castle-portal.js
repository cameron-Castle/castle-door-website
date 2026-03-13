import {
  slug,
  normalizeEmail,
  isValidEmail,
  normalizePortalRole,
  splitEmailList,
  getCookieValues,
  setCookie,
  readJsonBody,
} from "./shared/helpers.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname, hostname } = url;
    const portalOrigin = String(env.PORTAL_ORIGIN || "https://castledoorict.com")
      .trim()
      .replace(/\/+$/, "");

    const buildPortalUrl = (path, query = null) => {
      const target = new URL(path, `${portalOrigin}/`);
      if (query && typeof query === "object") {
        for (const [k, v] of Object.entries(query)) {
          if (v == null || v === "") continue;
          target.searchParams.set(k, String(v));
        }
      }
      return target.toString();
    };

    let portalCanonicalHost = "castledoorict.com";
    try {
      portalCanonicalHost = new URL(portalOrigin).hostname.toLowerCase();
    } catch {
      portalCanonicalHost = "castledoorict.com";
    }

    const isPortalPath =
      pathname === "/portal" ||
      pathname.startsWith("/portal/") ||
      pathname.startsWith("/api/portal/");
    const isPortalCanonicalHost =
      hostname === portalCanonicalHost || hostname === `www.${portalCanonicalHost}`;

    if (isPortalPath && !isPortalCanonicalHost) {
      const redirectStatus = req.method === "GET" || req.method === "HEAD" ? 302 : 307;
      return Response.redirect(buildPortalUrl(pathname + url.search), redirectStatus);
    }

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

    const normalizeCommentPermission = (value, defaultValue = true) => {
      if (typeof value === "boolean") return value;
      if (value == null) return !!defaultValue;
      const t = String(value).trim().toLowerCase();
      if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
      if (t === "false" || t === "0" || t === "no" || t === "off") return false;
      return !!defaultValue;
    };

    const redirectWithCookie = (location, cookieValue, cookieOptions, status = 302) => {
      const headers = new Headers({ Location: location });
      headers.append("Set-Cookie", cookieValue);
      return new Response(null, { status, headers });
    };

    const cookieSecure = url.protocol === "https:";
    const cookieDomain =
      hostname === "castledoorict.com" || hostname === "www.castledoorict.com"
        ? ".castledoorict.com"
        : "";

    const portalSessionSetCookies = (sid, maxAgeSeconds) => {
      const cookies = [
        // Host-scoped cookie for current host.
        setCookie("castle_portal", sid, {
          maxAge: maxAgeSeconds,
          path: "/",
          secure: cookieSecure,
          httpOnly: true,
          sameSite: "Lax",
        }),
      ];
      // Domain-scoped cookie only for production portal hostnames.
      if (cookieDomain) {
        cookies.push(
          setCookie("castle_portal", sid, {
            maxAge: maxAgeSeconds,
            path: "/",
            secure: cookieSecure,
            httpOnly: true,
            sameSite: "Lax",
            domain: cookieDomain,
          })
        );
      }
      return cookies;
    };

    const portalSessionClearCookies = () => {
      const cookies = [
        setCookie("castle_portal", "", {
          maxAge: 0,
          path: "/",
          secure: cookieSecure,
          httpOnly: true,
          sameSite: "Lax",
        }),
      ];
      if (cookieDomain) {
        cookies.push(
          setCookie("castle_portal", "", {
            maxAge: 0,
            path: "/",
            secure: cookieSecure,
            httpOnly: true,
            sameSite: "Lax",
            domain: cookieDomain,
          })
        );
      }
      return cookies;
    };

    const redirectWithCookies = (location, cookieValues = [], status = 302) => {
      const headers = new Headers({ Location: location });
      for (const c of cookieValues || []) {
        if (c) headers.append("Set-Cookie", c);
      }
      return new Response(null, { status, headers });
    };

    async function getPortalSession(request) {
      const cookieHeader = request.headers.get("Cookie") || "";
      const sids = getCookieValues(cookieHeader, "castle_portal")
        .map((v) => String(v || "").trim())
        .filter(Boolean);
      console.log("[portal-session] cookie-read", {
        path: (() => {
          try {
            return new URL(request.url).pathname;
          } catch {
            return "";
          }
        })(),
        sidCount: sids.length,
        sidPrefixes: sids.slice(0, 3).map((s) => s.slice(0, 8)),
      });
      if (!sids.length) return { ok: false, reason: "missing_session" };

      let sawExpired = false;
      let sawInvalidPayload = false;
      let sawInactiveMember = false;

      // Try all possible cookie values to tolerate duplicate cookie-name cases
      // (host-scoped + domain-scoped) during migration.
      for (const sid of sids) {
        const session = await env.ENROLL_TOKENS.get(`portalSession:${sid}`, "json");
        if (!session || typeof session !== "object") continue;

        if (typeof session.expiresAt === "number" && Date.now() > session.expiresAt) {
          sawExpired = true;
          continue;
        }

        const businessCode = slug(session.businessCode || "");
        const email = normalizeEmail(session.email || "");
        if (!businessCode || !email) {
          sawInvalidPayload = true;
          continue;
        }

        const member = await env.ENROLL_TOKENS.get(`portalMember:${businessCode}:${email}`, "json");
        if (!member || member.active === false) {
          sawInactiveMember = true;
          continue;
        }

        return {
          ok: true,
          role: normalizePortalRole(member.role || "member"),
          email,
          businessCode,
          canComment: normalizeCommentPermission(member.canComment, true),
        };
      }

      if (sawInactiveMember) return { ok: false, reason: "inactive_member" };
      if (sawInvalidPayload) return { ok: false, reason: "invalid_session_payload" };
      if (sawExpired) return { ok: false, reason: "expired_session" };
      console.log("[portal-session] lookup-failed", {
        path: (() => {
          try {
            return new URL(request.url).pathname;
          } catch {
            return "";
          }
        })(),
        sidCount: sids.length,
        sawExpired,
        sawInvalidPayload,
        sawInactiveMember,
      });
      return { ok: false, reason: "invalid_session" };
    }

    async function requirePortalAccess(request, businessCode = "", requireManager = false) {
      const sess = await getPortalSession(request);
      if (!sess.ok) {
        return {
          ok: false,
          reason: sess.reason || "unauthorized",
          response: json({ error: "Portal authentication required", reason: sess.reason || "unauthorized" }, 401),
        };
      }

      const targetBiz = slug(businessCode || "");
      if (targetBiz && sess.businessCode !== targetBiz) {
        return { ok: false, response: json({ error: "Forbidden business scope" }, 403) };
      }

      if (requireManager && sess.role !== "manager") {
        return { ok: false, response: json({ error: "Manager role required" }, 403) };
      }

      return { ok: true, session: sess };
    }

    async function bootstrapPortalSessionFromMagicToken(token, preferredSid = "") {
      const magicToken = String(token || "").trim();
      if (!magicToken) return { ok: false, reason: "missing_token" };

      const rec = await env.ENROLL_TOKENS.get(`portalMagic:${magicToken}`, "json");
      if (!rec || typeof rec !== "object") return { ok: false, reason: "invalid_magic" };
      if (typeof rec.expiresAt === "number" && Date.now() > rec.expiresAt) {
        return { ok: false, reason: "expired_magic" };
      }

      const businessCode = slug(rec.businessCode || "");
      const email = normalizeEmail(rec.email || "");
      if (!businessCode || !email) return { ok: false, reason: "invalid_magic_payload" };

      const member = await env.ENROLL_TOKENS.get(`portalMember:${businessCode}:${email}`, "json");
      if (!member || member.active === false) return { ok: false, reason: "inactive_member" };

      const sid =
        String(rec.sessionSid || "").trim() ||
        String(preferredSid || "").trim() ||
        crypto.randomUUID().replace(/-/g, "");
      const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;

      await env.ENROLL_TOKENS.put(
        `portalSession:${sid}`,
        JSON.stringify({
          sid,
          businessCode,
          email,
          role: normalizePortalRole(member.role || "member"),
          createdAt: Date.now(),
          expiresAt,
        })
      );

      await env.ENROLL_TOKENS.put(
        `portalMagic:${magicToken}`,
        JSON.stringify({
          ...rec,
          sessionSid: sid,
          lastConsumedAt: Date.now(),
        })
      );

      return {
        ok: true,
        sid,
        session: {
          ok: true,
          role: normalizePortalRole(member.role || "member"),
          email,
          businessCode,
          canComment: normalizeCommentPermission(member.canComment, true),
        },
      };
    }

    async function listBusinessDoorSummaries(kv, businessCode) {
      const biz = slug(businessCode || "");
      if (!biz) return [];

      const out = [];
      let cursor;
      do {
        const listed = await kv.list({ prefix: `door:${biz}:`, cursor });
        for (const k of listed.keys || []) {
          const row = await kv.get(k.name, "json");
          if (row && typeof row === "object") out.push(row);
        }
        cursor = listed.cursor;
      } while (cursor);

      return out;
    }

    async function submitCtaRequest(payload) {
      const kind = (payload.kind || "").toString();
      const businessCode = (payload.businessCode || "").toString();
      const buildingCode = (payload.buildingCode || "").toString();
      const doorId = (payload.doorId || "").toString();
      const doorSlug = (payload.doorSlug || "").toString();
      const requesterName = (payload.requesterName || "").toString();
      const requesterEmail = (payload.requesterEmail || "").toString();
      const notes = (payload.notes || "").toString();

      if (!kind || !businessCode || (!doorId && !doorSlug)) {
        return { response: json({ error: "Missing required fields" }, 400), id: null };
      }

      const cfg = (await env.ENROLL_TOKENS.get(`bizcfg:${businessCode}`, "json")) || {};
      if (!cfg || cfg.cta_enabled === false) {
        return { response: json({ error: "CTA disabled for this business" }, 403), id: null };
      }

      const now = Date.now();
      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      const record = {
        id,
        kind,
        businessCode,
        buildingCode,
        doorId,
        doorSlug,
        requesterName,
        requesterEmail,
        notes,
        createdAt: now,
      };
      await env.REPORTS_KV.put(`cta:${businessCode}:${id}`, JSON.stringify(record));

      const sendEmail = async () => {
        try {
          const apiKey = env.RESEND_API_KEY;
          const from = env.RESEND_FROM;
          if (!apiKey || !from) return;

          const to = [];
          const primary = String(cfg.cta_default_to || "").trim();
          const fallback = String(env.RESEND_FALLBACK_TO || "").trim();
          if (primary) to.push(primary);
          else if (fallback) to.push(fallback);
          if (!to.length) return;

          const cc = [];
          if (typeof cfg.cta_always_cc === "string") {
            cfg.cta_always_cc.split(",").forEach((x) => {
              const t = x.trim();
              if (t) cc.push(t);
            });
          }
          const dispatch = String(env.CASTLE_DISPATCH_EMAIL || "").trim();
          if (dispatch && !cc.includes(dispatch)) cc.push(dispatch);

          const payloadBody = {
            from,
            to,
            cc,
            subject: `[Door CTA] ${kind} – ${businessCode} – ${doorId || doorSlug}`,
            html: `<p>Business: ${businessCode}</p><p>Door: ${doorId || doorSlug}</p><p>Requester: ${requesterName || "(unknown)"} &lt;${requesterEmail || "(none)"}&gt;</p><pre>${notes || "(none)"}</pre><p>ID: ${id}</p>`,
          };

          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payloadBody),
          });
        } catch (e) {
          console.log("portal CTA email send failed", e);
        }
      };

      ctx.waitUntil(sendEmail());
      return { response: json({ ok: true, id }), id };
    }

    if (req.method === "GET" && pathname === "/health") {
      return json({ ok: true, worker: "portal-worker", host: hostname, time: new Date().toISOString() });
    }

    if (req.method === "GET" && pathname === "/portal/login") {
      const bizRaw = String(url.searchParams.get("biz") || "").trim();
      const bizPrefill = bizRaw ? slug(bizRaw) : "";
      return html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Customer Portal Login</title>
  <style>
    body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:420px;background:#0f172a;border:1px solid #1f2937;border-radius:14px;padding:18px;box-shadow:0 24px 60px rgba(0,0,0,.4)}
    h1{font-size:18px;margin:0 0 10px 0}
    p{font-size:13px;opacity:.9;line-height:1.4;margin:0 0 12px 0}
    input,button{width:100%;box-sizing:border-box;border-radius:10px;padding:10px;font-size:14px}
    input{background:#0b1220;color:#e5e7eb;border:1px solid #243043;margin-bottom:10px}
    button{border:1px solid #334155;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
    .msg{font-size:12px;margin-top:10px;opacity:.9}
  </style>
</head>
<body>
  <div class="card">
    <h1>Customer portal login</h1>
    <p>Enter your business code and email to sign in.</p>
    <input id="biz" placeholder="Business code" value="${bizPrefill}" />
    <input id="email" type="email" placeholder="you@company.com" />
    <button id="go">Log in</button>
    <div class="msg" id="msg"></div>
  </div>
  <script>
  (function(){
    const biz = document.getElementById("biz");
    const email = document.getElementById("email");
    const go = document.getElementById("go");
    const msg = document.getElementById("msg");
    go.onclick = async function(){
      msg.textContent = "";
      const b = (biz.value || "").trim();
      const e = (email.value || "").trim();
      if(!b || !e){ msg.textContent = "Business and email are required."; return; }
      go.disabled = true;
      try {
        const res = await fetch("/api/portal/auth/start", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessCode: b, email: e })
        });
        const out = await res.json().catch(()=>({}));
        if(!res.ok){ msg.textContent = out.error || "Unable to log in."; return; }
        if (out.portalUrl) {
          msg.textContent = "Login successful. Redirecting…";
          setTimeout(function(){ window.location = out.portalUrl; }, 350);
          return;
        }
        msg.textContent = "Login failed. Please verify your business code and email.";
      } finally {
        go.disabled = false;
      }
    };
  })();
  </script>
</body>
</html>`);
    }

    if (req.method === "GET" && pathname === "/portal/invite") {
      const token = String(url.searchParams.get("t") || "").trim();
      if (!token) return text("Invite token is required", 400);

      return html(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Accept Invite</title><style>body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}.card{width:100%;max-width:460px;background:#0f172a;border:1px solid #1f2937;border-radius:14px;padding:18px}input,button{width:100%;box-sizing:border-box;border-radius:10px;padding:10px;font-size:14px}input{background:#0b1220;color:#e5e7eb;border:1px solid #243043;margin-bottom:10px}button{border:1px solid #334155;background:#2563eb;color:#fff;font-weight:600}.msg{font-size:12px;margin-top:10px;opacity:.9}</style></head><body><div class="card"><h1>Accept customer portal invite</h1><p>Confirm your email to activate access.</p><input id="email" type="email" placeholder="you@company.com"/><button id="go">Accept invite</button><div id="msg" class="msg"></div></div><script>(function(){const token=${JSON.stringify(token)};const email=document.getElementById('email');const go=document.getElementById('go');const msg=document.getElementById('msg');go.onclick=async function(){msg.textContent='';const e=(email.value||'').trim();if(!e){msg.textContent='Email is required.';return;}go.disabled=true;try{const res=await fetch('/api/portal/invite/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,email:e})});const out=await res.json().catch(()=>({}));if(!res.ok){msg.textContent=out.error||'Could not accept invite.';return;}msg.textContent='Invite accepted. Redirecting to portal…';window.location=(out.portalUrl||'/portal');}finally{go.disabled=false;}}})();</script></body></html>`);
    }

    if (req.method === "GET" && pathname === "/portal/magic") {
      const token = String(url.searchParams.get("t") || "").trim();
      if (!token) return text("Missing token", 400);

      const rec = await env.ENROLL_TOKENS.get(`portalMagic:${token}`, "json");
      if (!rec || typeof rec !== "object") {
        console.log("[portal-magic] token-missing", {
          host: hostname,
          tokenPrefix: token.slice(0, 8),
        });
        return text("Invalid magic token", 403);
      }
      if (typeof rec.expiresAt === "number" && Date.now() > rec.expiresAt) return text("Magic token expired", 403);

      const businessCode = slug(rec.businessCode || "");
      const email = normalizeEmail(rec.email || "");
      const member = await env.ENROLL_TOKENS.get(`portalMember:${businessCode}:${email}`, "json");
      if (!member || member.active === false) return text("Portal member not active", 403);

      let sid = String(rec.sessionSid || "").trim();
      let existingSession = null;
      if (sid) {
        existingSession = await env.ENROLL_TOKENS.get(`portalSession:${sid}`, "json");
      }

      const needsNewSession =
        !existingSession ||
        typeof existingSession !== "object" ||
        slug(existingSession.businessCode || "") !== businessCode ||
        normalizeEmail(existingSession.email || "") !== email ||
        (typeof existingSession.expiresAt === "number" && Date.now() > existingSession.expiresAt);

      if (needsNewSession) {
        sid = crypto.randomUUID().replace(/-/g, "");
        const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
        await env.ENROLL_TOKENS.put(
          `portalSession:${sid}`,
          JSON.stringify({ sid, businessCode, email, role: normalizePortalRole(member.role || "member"), createdAt: Date.now(), expiresAt })
        );
        await env.ENROLL_TOKENS.put(
          `portalMagic:${token}`,
          JSON.stringify({
            ...rec,
            sessionSid: sid,
            lastConsumedAt: Date.now(),
          })
        );
      }
      // Do not immediately delete magic token on first GET.
      // Email security scanners can prefetch links before the user clicks,
      // which would otherwise consume the token and cause "Invalid magic token"
      // for the real user. Token expiry still limits lifetime.

      console.log("[portal-magic] session-established", {
        host: hostname,
        businessCode,
        email,
        tokenPrefix: token.slice(0, 8),
        reusedSession: !needsNewSession,
        sidPrefix: String(sid || "").slice(0, 8),
      });

      return redirectWithCookies(
        buildPortalUrl("/portal", { from: "magic", t: token }),
        portalSessionSetCookies(sid, 60 * 60 * 24 * 14)
      );
    }

    if (req.method === "GET" && pathname === "/portal/logout") {
      return redirectWithCookies(
        buildPortalUrl("/"),
        portalSessionClearCookies()
      );
    }

    if (req.method === "GET" && pathname === "/portal") {
      const bizRaw = String(url.searchParams.get("biz") || "").trim();
      const bizFromQuery = bizRaw ? slug(bizRaw) : "";
      const fromMagic = String(url.searchParams.get("from") || "").trim().toLowerCase() === "magic";
      const magicToken = String(url.searchParams.get("t") || "").trim();
      const retryCountRaw = Number(url.searchParams.get("retry") || "0");
      const retryCount = Number.isFinite(retryCountRaw) ? Math.max(0, Math.trunc(retryCountRaw)) : 0;
      const requestSids = getCookieValues(req.headers.get("Cookie") || "", "castle_portal")
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      console.log("[portal] access-check-start", {
        host: hostname,
        fromMagic,
        retryCount,
        hasMagicToken: !!magicToken,
        sidCount: requestSids.length,
        sidPrefixes: requestSids.slice(0, 3).map((s) => s.slice(0, 8)),
      });
      let access = await requirePortalAccess(req, bizFromQuery || "", false);
      let usedMagicBootstrap = false;
      if (!access.ok && fromMagic && magicToken) {
        const bootstrap = await bootstrapPortalSessionFromMagicToken(
          magicToken,
          requestSids[0] || ""
        );
        if (bootstrap.ok) {
          usedMagicBootstrap = true;
          access = {
            ok: true,
            session: bootstrap.session,
          };
          console.log("[portal] bootstrap-session-from-magic", {
            host: hostname,
            tokenPrefix: magicToken.slice(0, 8),
            sidPrefix: String(bootstrap.sid || "").slice(0, 8),
            businessCode: bootstrap.session.businessCode,
          });
        }
      }
      if (!access.ok) {
        console.log("[portal] auth-failed", {
          host: hostname,
          reason: access.reason || "unauthorized",
          fromMagic,
          retryCount,
          hasMagicToken: !!magicToken,
          sidCount: requestSids.length,
          sidPrefixes: requestSids.slice(0, 3).map((s) => s.slice(0, 8)),
        });
        if (requestSids.length && retryCount < 3) {
          return Response.redirect(
            buildPortalUrl("/portal", { retry: String(retryCount + 1) }),
            302
          );
        }
        return Response.redirect(buildPortalUrl("/portal/login"), 302);
      }

      // Clean URL once authenticated after magic-link bootstrap.
      if (!usedMagicBootstrap && (fromMagic || retryCount > 0 || magicToken)) {
        return Response.redirect(buildPortalUrl("/portal"), 302);
      }

      const session = access.session;
      const businessCode = session.businessCode;
      const reportsOrigin = String(env.REPORTS_ORIGIN || "https://r.castledoorict.com")
        .trim()
        .replace(/\/+$/, "");
      return html(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Customer Portal</title><style>:root{--bg:#0b1220;--card:#0f172a;--line:#243043;--border:#1f2937;--text:#e5e7eb;--muted:#94a3b8;--accent:#2563eb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.wrap{max-width:1160px;margin:0 auto;padding:20px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.title{margin:0;font-size:1.3rem}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:12px}.kpis{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:10px}.kpi{background:#0b1220;border:1px solid var(--line);border-radius:10px;padding:10px}.kpi .n{font-size:1.35rem;font-weight:700}.filters{display:grid;grid-template-columns:1fr 180px 180px;gap:10px}input,select,button{padding:9px 10px;border-radius:8px;border:1px solid #334155;background:#111827;color:var(--text)}button{background:var(--accent);cursor:pointer}table{width:100%;border-collapse:collapse}th,td{padding:9px 8px;border-bottom:1px solid var(--line);font-size:.86rem;text-align:left}.link{color:#93c5fd;text-decoration:none}.empty{padding:16px 8px;color:var(--muted)}@media(max-width:920px){.kpis{grid-template-columns:repeat(2,minmax(130px,1fr))}.filters{grid-template-columns:1fr}}@media(max-width:560px){.kpis{grid-template-columns:1fr}}</style></head><body><div class="wrap"><div class="top"><div><h1 class="title">Customer Portal</h1><div class="muted">Business: ${businessCode} • Role: ${session.role}</div></div><a class="link" href="/portal/logout">Logout</a></div><div class="card"><div id="kpis" class="kpis"><div class="kpi"><div class="muted">Loading</div><div class="n">…</div></div></div></div><div class="card"><div class="filters"><input id="q" placeholder="Search door or building"/><select id="status"><option value="all">All statuses</option><option value="pass">Pass</option><option value="conditional">Conditional</option><option value="flagged">Flagged</option></select><select id="sort"><option value="recent">Newest inspected</option><option value="label">Door label</option><option value="building">Building</option><option value="status">Status</option></select></div></div><div class="card"><div class="top" style="margin-bottom:6px"><strong>Doors</strong><span id="count" class="muted">0 doors</span></div><div style="overflow:auto"><table><thead><tr><th>Door</th><th>Status</th><th>Building</th><th>Last inspected</th><th>Action</th></tr></thead><tbody id="rows"></tbody></table></div></div><div class="card" id="managerBlock" style="display:none"><strong>Manager settings</strong><div class="filters" style="margin-top:10px;grid-template-columns:1fr 180px auto"><input id="repairTo" placeholder="maintenance@customer.com"/><button id="saveRepair">Save</button><span id="managerMsg" class="muted"></span></div></div></div><script>(async function(){const businessCode=${JSON.stringify(businessCode)};const reportsOrigin=${JSON.stringify("__REPORTS_ORIGIN__")}.replace('__REPORTS_ORIGIN__', ${JSON.stringify(reportsOrigin)});const kpis=document.getElementById('kpis');const rows=document.getElementById('rows');const count=document.getElementById('count');const q=document.getElementById('q');const status=document.getElementById('status');const sort=document.getElementById('sort');let doors=[];const norm=s=>String(s||'').trim().toLowerCase();const bucket=s=>{const v=norm(s);if(v==='pass')return'pass';if(v==='conditional pass'||v==='conditional')return'conditional';if(v==='fail'||v==='flagged'||v==='needs repair')return'flagged';return'other';};const pct=(n,t)=>t?Math.round((n/t)*100)+'%':'0%';function renderKpis(t){const total=Number(t.total||0),pass=Number(t.pass||0),conditional=Number(t.conditional||0),flagged=Number(t.flagged||0);kpis.innerHTML='<div class="kpi"><div class="muted">Total</div><div class="n">'+total+'</div></div>'+'<div class="kpi"><div class="muted">Pass</div><div class="n">'+pass+'</div><div class="muted">'+pct(pass,total)+'</div></div>'+'<div class="kpi"><div class="muted">Conditional</div><div class="n">'+conditional+'</div><div class="muted">'+pct(conditional,total)+'</div></div>'+'<div class="kpi"><div class="muted">Flagged</div><div class="n">'+flagged+'</div><div class="muted">'+pct(flagged,total)+'</div></div>';}function view(){const query=norm(q.value);const st=norm(status.value||'all');const by=norm(sort.value||'recent');let list=doors.filter(d=>{const dLabel=norm(d.displayLabel||d.doorId||'door');const b=norm(d.building||d.buildingCode||'');if(st!=='all'&&bucket(d.status)!==st)return false;return !query||dLabel.includes(query)||b.includes(query);});list.sort((a,b)=>{if(by==='label')return String(a.displayLabel||a.doorId||'').localeCompare(String(b.displayLabel||b.doorId||''));if(by==='building')return String(a.building||a.buildingCode||'').localeCompare(String(b.building||b.buildingCode||''));if(by==='status')return bucket(a.status).localeCompare(bucket(b.status));return String(b.lastInspectedAt||'').localeCompare(String(a.lastInspectedAt||''));});return list;}function renderRows(){const list=view();rows.innerHTML='';count.textContent=list.length+' door'+(list.length===1?'':'s');if(!list.length){rows.innerHTML='<tr><td colspan="5" class="empty">No doors match current filters.</td></tr>';return;}list.forEach(d=>{const tr=document.createElement('tr');const url=reportsOrigin+'/reports/'+encodeURIComponent(d.businessCode)+'/'+encodeURIComponent(d.buildingCode||'main')+'/'+encodeURIComponent(d.doorSlug||'');tr.innerHTML='<td>'+String(d.displayLabel||d.doorId||'Door')+'</td><td>'+String(d.status||'')+'</td><td>'+String(d.building||d.buildingCode||'')+'</td><td>'+String(d.lastInspectedAt||'')+'</td><td><a class="link" href="'+url+'" target="_blank" rel="noopener">View report</a></td>';rows.appendChild(tr);});}[q,status,sort].forEach(el=>{el.addEventListener('input',renderRows);el.addEventListener('change',renderRows);});const dashRes=await fetch('/api/portal/dashboard?businessCode='+encodeURIComponent(businessCode));const dash=await dashRes.json().catch(()=>({}));if(!dashRes.ok){kpis.innerHTML='<div class="kpi"><div class="muted">Error</div><div class="n">!</div><div class="muted">'+String(dash.error||'Unable to load dashboard')+'</div></div>';rows.innerHTML='<tr><td colspan="5" class="empty">Unable to load doors right now.</td></tr>';return;}renderKpis(dash.totals||{});doors=Array.isArray(dash.doors)?dash.doors:[];renderRows();const meRes=await fetch('/api/portal/me?businessCode='+encodeURIComponent(businessCode));const me=await meRes.json().catch(()=>({}));if(meRes.ok&&me.role==='manager'){document.getElementById('managerBlock').style.display='block';const setRes=await fetch('/api/portal/settings/repair?businessCode='+encodeURIComponent(businessCode));const setOut=await setRes.json().catch(()=>({}));if(setRes.ok)document.getElementById('repairTo').value=setOut.defaultTo||'';document.getElementById('saveRepair').addEventListener('click',async()=>{const defaultTo=String(document.getElementById('repairTo').value||'').trim();const res=await fetch('/api/portal/settings/repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({businessCode,defaultTo})});const out=await res.json().catch(()=>({}));document.getElementById('managerMsg').textContent=res.ok?'Saved.':String(out.error||'Failed');});}})();</script></body></html>`);
    }
    if (req.method === "POST" && pathname === "/api/portal/auth/start") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const traceId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

      const businessCode = slug(body.businessCode || body.biz || "");
      const email = normalizeEmail(body.email || "");
      if (!businessCode || !email || !isValidEmail(email)) return json({ error: "businessCode and valid email required" }, 400);

      const member = await env.ENROLL_TOKENS.get(`portalMember:${businessCode}:${email}`, "json");
      if (!member || member.active === false) {
        console.log("[portal-auth-start] member-missing-or-inactive", {
          traceId,
          businessCode,
          email,
        });
        return json({ ok: true, traceId });
      }

      const sid = crypto.randomUUID().replace(/-/g, "");
      const sessionExpiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
      const magicToken = crypto.randomUUID().replace(/-/g, "");
      await env.ENROLL_TOKENS.put(
        `portalSession:${sid}`,
        JSON.stringify({
          sid,
          businessCode,
          email,
          role: normalizePortalRole(member.role || "member"),
          createdAt: Date.now(),
          expiresAt: sessionExpiresAt,
        })
      );
      await env.ENROLL_TOKENS.put(
        `portalMagic:${magicToken}`,
        JSON.stringify({
          token: magicToken,
          businessCode,
          email,
          sessionSid: sid,
          createdAt: Date.now(),
          expiresAt: Date.now() + 1000 * 60 * 10,
        })
      );
      console.log("[portal-auth-start] session-created", {
        traceId,
        businessCode,
        email,
        sidPrefix: sid.slice(0, 8),
        tokenPrefix: magicToken.slice(0, 8),
      });

      const headers = new Headers({ "content-type": "application/json" });
      for (const c of portalSessionSetCookies(sid, 60 * 60 * 24 * 14)) {
        headers.append("Set-Cookie", c);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          traceId,
          portalUrl: buildPortalUrl("/portal", { from: "magic", t: magicToken }),
        }),
        {
          status: 200,
          headers,
        }
      );
    }

    if (req.method === "POST" && pathname === "/api/portal/invite/accept") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const token = String(body.token || "").trim();
      const email = normalizeEmail(body.email || "");
      if (!token || !email || !isValidEmail(email)) return json({ error: "token and valid email required" }, 400);

      const invite = await env.ENROLL_TOKENS.get(`portalInvite:${token}`, "json");
      if (!invite || typeof invite !== "object") {
        const used = await env.ENROLL_TOKENS.get(`portalInviteUsed:${token}`, "json");
        if (!used || typeof used !== "object") return json({ error: "Invalid invite token" }, 403);

        const usedBiz = slug(used.businessCode || "");
        const usedRole = normalizePortalRole(used.role || "member");
        const usedEmail = normalizeEmail(used.email || "");
        if (!usedBiz) return json({ error: "Invalid invite token" }, 403);
        if (usedEmail && usedEmail !== email) {
          return json({ error: "Invite token is restricted to a specific email" }, 403);
        }

        const effectiveEmail = usedEmail || email;
        const memberKey = `portalMember:${usedBiz}:${effectiveEmail}`;
        const existingMember = await env.ENROLL_TOKENS.get(memberKey, "json");
        if (!existingMember || existingMember.active === false) {
          await env.ENROLL_TOKENS.put(
            memberKey,
            JSON.stringify({
              businessCode: usedBiz,
              email: effectiveEmail,
              role: usedRole,
              canComment: normalizeCommentPermission(used.canComment, true),
              active: true,
              createdAt: Date.now(),
              createdBy: used.createdBy || "invite-recovery",
            })
          );
        }

        const sid = crypto.randomUUID().replace(/-/g, "");
        const sessionExpiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
        await env.ENROLL_TOKENS.put(
          `portalSession:${sid}`,
          JSON.stringify({ sid, businessCode: usedBiz, email: effectiveEmail, role: usedRole, createdAt: Date.now(), expiresAt: sessionExpiresAt })
        );

        const magicToken = crypto.randomUUID().replace(/-/g, "");
        await env.ENROLL_TOKENS.put(
          `portalMagic:${magicToken}`,
          JSON.stringify({
            token: magicToken,
            businessCode: usedBiz,
            email: effectiveEmail,
            createdAt: Date.now(),
            expiresAt: Date.now() + 1000 * 60 * 10,
          })
        );

        const headers = new Headers({ "content-type": "application/json" });
        for (const c of portalSessionSetCookies(sid, 60 * 60 * 24 * 14)) {
          headers.append("Set-Cookie", c);
        }
        return new Response(JSON.stringify({ ok: true, businessCode: usedBiz, email: effectiveEmail, role: usedRole, portalUrl: buildPortalUrl("/portal/magic", { t: magicToken }) }), {
          status: 200,
          headers,
        });
      }
      if (typeof invite.expiresAt === "number" && Date.now() > invite.expiresAt) return json({ error: "Invite token expired" }, 403);

      const businessCode = slug(invite.businessCode || "");
      const role = normalizePortalRole(invite.role || "member");
      const allowedEmail = normalizeEmail(invite.email || "");
      if (allowedEmail && allowedEmail !== email) return json({ error: "Invite token is restricted to a specific email" }, 403);

      await env.ENROLL_TOKENS.put(
        `portalMember:${businessCode}:${email}`,
        JSON.stringify({
          businessCode,
          email,
          role,
          canComment: normalizeCommentPermission(invite.canComment, true),
          active: true,
          createdAt: Date.now(),
          createdBy: invite.createdBy || "invite",
        })
      );
      await env.ENROLL_TOKENS.put(
        `portalInviteUsed:${token}`,
        JSON.stringify({
          token,
          businessCode,
          role,
          email: allowedEmail || email,
          canComment: normalizeCommentPermission(invite.canComment, true),
          createdBy: invite.createdBy || "invite",
          usedAt: Date.now(),
        }),
        { expirationTtl: 60 * 60 * 24 * 30 }
      );
      await env.ENROLL_TOKENS.delete(`portalInvite:${token}`);

      const sid = crypto.randomUUID().replace(/-/g, "");
      const sessionExpiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
      await env.ENROLL_TOKENS.put(
        `portalSession:${sid}`,
        JSON.stringify({ sid, businessCode, email, role, createdAt: Date.now(), expiresAt: sessionExpiresAt })
      );

      const enrollToken = crypto.randomUUID().replace(/-/g, "");
      await env.ENROLL_TOKENS.put(
        `enroll:${enrollToken}`,
        JSON.stringify({
          biz: businessCode,
          scope: "business",
          max_uses: 5,
          uses: 0,
          expires_at: Date.now() + 1000 * 60 * 60 * 24 * 7,
          created_at: Date.now(),
          allowed_email: email,
          allowed_domain: null,
        })
      );

      const reportsOrigin = String(env.REPORTS_ORIGIN || "https://r.castledoorict.com").trim();
      const enrollUrl = `${reportsOrigin}/enroll/${encodeURIComponent(businessCode)}?t=${encodeURIComponent(enrollToken)}&email=${encodeURIComponent(email)}`;
      const magicToken = crypto.randomUUID().replace(/-/g, "");
      await env.ENROLL_TOKENS.put(
        `portalMagic:${magicToken}`,
        JSON.stringify({
          token: magicToken,
          businessCode,
          email,
          createdAt: Date.now(),
          expiresAt: Date.now() + 1000 * 60 * 10,
        })
      );
      const portalUrl = buildPortalUrl("/portal/magic", { t: magicToken });

      const headers = new Headers({ "content-type": "application/json" });
      for (const c of portalSessionSetCookies(sid, 60 * 60 * 24 * 14)) {
        headers.append("Set-Cookie", c);
      }

      return new Response(JSON.stringify({ ok: true, businessCode, email, role, portalUrl, enrollUrl }), {
        status: 200,
        headers,
      });
    }

    if (req.method === "GET" && pathname === "/api/portal/me") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(req, businessCode, false);
      if (!access.ok) return access.response;
      return json({ ok: true, ...access.session, canComment: normalizeCommentPermission(access.session.canComment, true) });
    }

    if (req.method === "GET" && pathname === "/api/portal/dashboard") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(req, businessCode, false);
      if (!access.ok) return access.response;

      const biz = access.session.businessCode;
      const doors = await listBusinessDoorSummaries(env.REPORTS_KV, biz);
      let pass = 0;
      let conditional = 0;
      let flagged = 0;
      for (const d of doors) {
        const s = String(d.status || "").trim().toLowerCase();
        if (s === "pass") pass++;
        else if (s === "conditional pass" || s === "conditional") conditional++;
        else if (s === "fail" || s === "flagged" || s === "needs repair") flagged++;
      }

      return json({
        ok: true,
        businessCode: biz,
        totals: { total: doors.length, pass, conditional, flagged },
        doors: doors
          .slice()
          .sort((a, b) => String(b.lastInspectedAt || "").localeCompare(String(a.lastInspectedAt || "")))
          .slice(0, 300),
      });
    }

    if (req.method === "GET" && pathname === "/api/portal/settings/repair") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode;
      const cfg = (await env.ENROLL_TOKENS.get(`bizcfg:${biz}`, "json")) || {};
      return json({
        ok: true,
        businessCode: biz,
        defaultTo: typeof cfg.cta_default_to === "string" ? cfg.cta_default_to : "",
        alwaysCc: typeof cfg.cta_always_cc === "string" ? cfg.cta_always_cc : "",
        ctaEnabled: cfg.cta_enabled !== false,
      });
    }

    if (req.method === "POST" && pathname === "/api/portal/settings/repair") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const defaultTo = String(body.defaultTo || "").trim();
      const alwaysCc = String(body.alwaysCc || "").trim();
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;

      if (defaultTo && !isValidEmail(defaultTo)) return json({ error: "defaultTo must be a valid email" }, 400);

      const biz = access.session.businessCode;
      const cfgKey = `bizcfg:${biz}`;
      const cfg = (await env.ENROLL_TOKENS.get(cfgKey, "json")) || {};
      cfg.slug = cfg.slug || biz;
      cfg.name = cfg.name || biz;
      cfg.cta_enabled = true;
      cfg.cta_default_to = defaultTo;
      const ccList = splitEmailList(alwaysCc);
      const dispatch = String(env.CASTLE_DISPATCH_EMAIL || "").trim().toLowerCase();
      if (dispatch && isValidEmail(dispatch) && !ccList.includes(dispatch)) ccList.push(dispatch);
      cfg.cta_always_cc = ccList.join(",");
      await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));
      return json({ ok: true, businessCode: biz, defaultTo: cfg.cta_default_to, alwaysCc: cfg.cta_always_cc });
    }

    if (req.method === "GET" && pathname === "/api/portal/members") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;

      const biz = access.session.businessCode;
      const members = [];
      let cursor;
      do {
        const listed = await env.ENROLL_TOKENS.list({ prefix: `portalMember:${biz}:`, cursor });
        for (const k of listed.keys || []) {
          const row = await env.ENROLL_TOKENS.get(k.name, "json");
          if (row) members.push({ ...row, canComment: normalizeCommentPermission(row.canComment, true) });
        }
        cursor = listed.cursor;
      } while (cursor);
      members.sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));
      return json({ ok: true, businessCode: biz, members });
    }

    if (req.method === "POST" && pathname === "/api/portal/members/invite") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const email = normalizeEmail(body.email || "");
      const role = normalizePortalRole(body.role || "member");
      const canComment = normalizeCommentPermission(body.canComment, true);
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;
      if (!email || !isValidEmail(email)) return json({ error: "valid email required" }, 400);

      const biz = access.session.businessCode;
      const token = crypto.randomUUID().replace(/-/g, "");
      const invite = {
        token,
        businessCode: biz,
        email,
        role,
        canComment,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
        createdBy: access.session.email || "manager",
      };
      await env.ENROLL_TOKENS.put(`portalInvite:${token}`, JSON.stringify(invite));
      const inviteUrl = buildPortalUrl("/portal/invite", { t: token });
      return json({ ok: true, businessCode: biz, email, role, canComment, inviteUrl, token });
    }

    if (req.method === "POST" && pathname === "/api/portal/members/comment-permission") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const email = normalizeEmail(body.email || "");
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;
      if (!email || !isValidEmail(email)) return json({ error: "valid email required" }, 400);

      const biz = access.session.businessCode;
      const key = `portalMember:${biz}:${email}`;
      const member = await env.ENROLL_TOKENS.get(key, "json");
      if (!member || member.active === false) return json({ error: "portal member not found" }, 404);

      const canComment = normalizeCommentPermission(body.canComment, true);
      member.canComment = canComment;
      await env.ENROLL_TOKENS.put(key, JSON.stringify(member));
      return json({ ok: true, businessCode: biz, email, canComment });
    }

    if (req.method === "POST" && pathname === "/api/portal/members/remove") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const email = normalizeEmail(body.email || "");
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;
      if (!email || !isValidEmail(email)) return json({ error: "valid email required" }, 400);

      const biz = access.session.businessCode;
      await env.ENROLL_TOKENS.delete(`portalMember:${biz}:${email}`);
      return json({ ok: true, businessCode: biz, email });
    }

    if (req.method === "POST" && pathname === "/api/portal/cta-submit") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const access = await requirePortalAccess(req, businessCode, false);
      if (!access.ok) return access.response;

      const result = await submitCtaRequest({
        ...body,
        businessCode: access.session.businessCode,
        requesterEmail: access.session.email || body.requesterEmail || "",
        requesterName: body.requesterName || access.session.email || "Portal user",
      });
      return result.response;
    }

    if (req.method === "GET" && pathname === "/") {
      const host = String(hostname || "").toLowerCase();
      const isRootSiteHost = host === "castledoorict.com" || host === "www.castledoorict.com";

      if (isRootSiteHost) {
        return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Castle Door & Hardware — commercial door, frame, and hardware solutions. Fast quotes, accurate schedules, and clean installs." />
  <title>Castle Door & Hardware</title>

  <meta property="og:title" content="Castle Door & Hardware" />
  <meta property="og:description" content="Commercial door, frame, and hardware solutions. Fast quotes, accurate schedules, and clean installs." />
  <meta property="og:type" content="website" />

  <style>
    :root{
      --bg: #0b1220;
      --card: rgba(255,255,255,.06);
      --card2: rgba(255,255,255,.09);
      --text: rgba(255,255,255,.92);
      --muted: rgba(255,255,255,.72);
      --border: rgba(255,255,255,.12);
      --brand: #8b5cf6;
      --brand2: #22c55e;
      --shadow: 0 12px 40px rgba(0,0,0,.35);
      --radius: 18px;
      --max: 1120px;
    }

    *{box-sizing:border-box}
    html,body{height:100%}
    body{
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
      color: var(--text);
      background:
        radial-gradient(900px 420px at 20% 10%, rgba(139,92,246,.16), transparent 60%),
        var(--bg);
      line-height: 1.5;
    }

    a{color:inherit; text-decoration:none}
    a:focus, button:focus, input:focus, textarea:focus{outline: 3px solid rgba(139,92,246,.55); outline-offset: 2px}
    .wrap{max-width: var(--max); margin:0 auto; padding: 0 20px}
    .pill{
      display:inline-flex; align-items:center; gap:10px;
      padding: 8px 12px; border: 1px solid var(--border);
      border-radius: 999px; background: rgba(255,255,255,.04);
      color: var(--muted); font-size: 13px;
      backdrop-filter: blur(10px);
    }
    .dot{width:8px; height:8px; border-radius:999px; background: var(--brand2); box-shadow: 0 0 0 4px rgba(34,197,94,.15)}
    header{
      position: sticky; top: 0; z-index: 50;
      background: rgba(11,18,32,.55);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .nav{
      display:flex; align-items:center; justify-content:space-between;
      height: 72px;
    }
    .logo{
      display:flex; align-items:center; gap:12px;
      font-weight: 750; letter-spacing:.2px;
    }
    .mark{
      width: 36px; height: 36px; border-radius: 12px;
      background:
        radial-gradient(16px 16px at 30% 30%, rgba(255,255,255,.25), transparent 60%),
        linear-gradient(135deg, rgba(139,92,246,.95), rgba(34,197,94,.75));
      box-shadow: 0 10px 24px rgba(139,92,246,.25);
      border: 1px solid rgba(255,255,255,.18);
    }
    .links{display:flex; gap:18px; align-items:center}
    .links a{
      font-size: 14px; color: var(--muted);
      padding: 10px 10px; border-radius: 12px;
    }
    .links a:hover{color: var(--text); background: rgba(255,255,255,.05)}
    .ctaRow{display:flex; gap:10px; align-items:center}
    .btn{
      border: 1px solid var(--border);
      background: rgba(255,255,255,.05);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 14px;
      font-weight: 650;
      font-size: 14px;
      display:inline-flex; align-items:center; gap:10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.2);
    }
    .btn:hover{transform: translateY(-1px); background: rgba(255,255,255,.08)}
    .btn.primary{
      border-color: rgba(139,92,246,.35);
      background: linear-gradient(135deg, rgba(139,92,246,.95), rgba(34,197,94,.65));
    }
    .btn.primary:hover{filter: brightness(1.02)}
    .btn span.icon{display:inline-block; width: 18px; height: 18px}

    main{padding: 40px 0 80px}
    .hero{
      display:grid;
      grid-template-columns: 1.15fr .85fr;
      gap: 28px;
      align-items: start;
      padding: 42px 0 20px;
    }
    .hero h1{
      margin: 16px 0 12px;
      font-size: clamp(34px, 4.2vw, 56px);
      line-height: 1.06;
      letter-spacing: -0.02em;
    }
    .hero p{
      margin: 0 0 22px;
      color: var(--muted);
      font-size: 16px;
      max-width: 58ch;
    }
    .heroActions{display:flex; flex-wrap:wrap; gap: 12px; align-items:center}
    .mini{
      display:flex; gap: 16px; margin-top: 18px; color: var(--muted);
      flex-wrap:wrap;
    }
    .mini strong{color: var(--text)}
    .card{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .heroCard{
      padding: 18px;
      position: relative;
      overflow:hidden;
    }
    .heroCard:before{
      content:"";
      position:absolute; inset:-1px;
      background: radial-gradient(400px 250px at 30% 0%, rgba(139,92,246,.35), transparent 55%),
                  radial-gradient(420px 260px at 90% 20%, rgba(34,197,94,.22), transparent 55%);
      pointer-events:none;
      opacity:.7;
    }
    .heroCard > *{position:relative}
    .statGrid{
      display:grid; grid-template-columns: repeat(2, 1fr); gap: 12px;
      margin-top: 12px;
    }
    .stat{
      padding: 14px;
      border-radius: 16px;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.09);
    }
    .stat .k{font-size: 22px; font-weight: 800; letter-spacing: -0.02em}
    .stat .l{color: var(--muted); font-size: 13px; margin-top: 4px}

    .section{
      margin-top: 44px;
    }
    .sectionHead{
      display:flex; align-items:flex-end; justify-content:space-between;
      gap: 16px; margin-bottom: 16px;
    }
    .sectionHead h2{
      margin:0;
      font-size: 22px;
      letter-spacing: -0.01em;
    }
    .sectionHead p{margin:0; color: var(--muted); max-width: 70ch; font-size: 14px}

    .grid3{display:grid; grid-template-columns: repeat(3, 1fr); gap: 14px}
    .feature{
      padding: 18px;
    }
    .feature .tag{
      display:inline-flex; align-items:center; gap:8px;
      font-size: 12px; color: var(--muted);
      padding: 7px 10px; border-radius: 999px;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.10);
    }
    .feature h3{margin: 10px 0 8px; font-size: 16px}
    .feature p{margin:0; color: var(--muted); font-size: 14px}

    .brands{
      display:flex; flex-wrap:wrap; gap: 10px; align-items:center;
      padding: 14px;
      border-radius: var(--radius);
      background: rgba(255,255,255,.04);
      border: 1px dashed rgba(255,255,255,.14);
      color: var(--muted);
    }
    .brandPill{
      padding: 8px 10px;
      border-radius: 999px;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.10);
      font-size: 13px;
      color: rgba(255,255,255,.78);
    }

    .split{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      align-items: stretch;
    }

    form{
      padding: 18px;
    }
    .row{display:grid; grid-template-columns: 1fr 1fr; gap: 12px}
    label{display:block; font-size: 13px; color: var(--muted); margin: 0 0 6px}
    input, textarea{
      width: 100%;
      padding: 12px 12px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(6,10,18,.35);
      color: var(--text);
    }
    textarea{min-height: 120px; resize: vertical}
    .formActions{display:flex; gap: 10px; align-items:center; margin-top: 12px; flex-wrap:wrap}
    .fine{font-size: 12px; color: rgba(255,255,255,.6)}
    footer{
      margin-top: 54px;
      padding-top: 22px;
      border-top: 1px solid rgba(255,255,255,.08);
      color: rgba(255,255,255,.7);
      font-size: 13px;
      display:flex; flex-wrap:wrap; gap: 10px; justify-content:space-between; align-items:center;
    }

    @media (max-width: 920px){
      .hero{grid-template-columns: 1fr; padding-top: 26px}
      .grid3{grid-template-columns: 1fr}
      .split{grid-template-columns: 1fr}
      .links{display:none}
      .row{grid-template-columns: 1fr}
    }

    .lift{transition: transform .18s ease, filter .18s ease}
    .lift:hover{transform: translateY(-2px)}
  </style>
</head>

<body>
  <header>
    <div class="wrap nav">
      <a class="logo" href="#top" aria-label="Castle Door & Hardware home">
        <span class="mark" aria-hidden="true"></span>
        <span>Castle Door &amp; Hardware</span>
      </a>

      <nav class="links" aria-label="Primary">
        <a href="#services">Services</a>
        <a href="#process">Process</a>
        <a href="#brands">Brands</a>
        <a href="#contact">Contact</a>
      </nav>

      <div class="ctaRow">
        <a class="btn lift" href="/portal/login" aria-label="Customer portal login">
          <span class="icon" aria-hidden="true">🔐</span>
          Portal Login
        </a>
        <a class="btn lift" href="tel:+1-000-000-0000" aria-label="Call Castle Door and Hardware">
          <span class="icon" aria-hidden="true">☎</span>
          Call
        </a>
        <a class="btn primary lift" href="#contact">
          <span class="icon" aria-hidden="true">➜</span>
          Request a Quote
        </a>
      </div>
    </div>
  </header>

  <main id="top">
    <div class="wrap hero">
      <section>
        <div class="pill">
          <span class="dot" aria-hidden="true"></span>
          <span>Commercial door, frame &amp; hardware solutions — quoting fast, installing clean.</span>
        </div>

        <h1>Doors &amp; hardware that show up on time—and work on day one.</h1>
        <p>
          Castle Door &amp; Hardware supports contractors, facilities, and project teams with
          accurate takeoffs, clear submittals, and dependable field execution.
        </p>

        <div class="heroActions">
          <a class="btn primary lift" href="#contact">
            <span class="icon" aria-hidden="true">🧾</span>
            Get a Quote
          </a>
          <a class="btn lift" href="#services">
            <span class="icon" aria-hidden="true">▦</span>
            See Services
          </a>
          <a class="btn lift" href="#process">
            <span class="icon" aria-hidden="true">✓</span>
            How We Work
          </a>
        </div>

        <div class="mini" aria-label="Highlights">
          <div><strong>Fast</strong> turnaround</div>
          <div><strong>Accurate</strong> schedules</div>
          <div><strong>Clean</strong> installs</div>
          <div><strong>Responsive</strong> support</div>
        </div>
      </section>

      <aside class="card heroCard">
        <div class="pill" style="margin-bottom: 12px;">
          <span aria-hidden="true">🛠️</span>
          <span>Project-ready deliverables</span>
        </div>

        <div class="statGrid">
          <div class="stat">
            <div class="k">Takeoff</div>
            <div class="l">Door + hardware sets organized for bid &amp; buyout</div>
          </div>
          <div class="stat">
            <div class="k">Submittals</div>
            <div class="l">Clear cut sheets, approvals, and alternates</div>
          </div>
          <div class="stat">
            <div class="k">Coordination</div>
            <div class="l">RFIs &amp; field conditions handled quickly</div>
          </div>
          <div class="stat">
            <div class="k">Install</div>
            <div class="l">Trusted crews, punch-list minded</div>
          </div>
        </div>

        <div style="margin-top: 14px; color: var(--muted); font-size: 13px;">
          Need a door schedule review? Send it over and we’ll flag issues before they cost time.
        </div>
      </aside>
    </div>

    <div class="wrap section" id="services">
      <div class="sectionHead">
        <div>
          <h2>What we do</h2>
          <p>Support from bid through closeout—so your openings don’t become your schedule risk.</p>
        </div>
      </div>

      <div class="grid3">
        <div class="card feature lift">
          <div class="tag">📐 Estimating</div>
          <h3>Takeoffs &amp; budgets</h3>
          <p>Fast, organized counts with clear scope and alternates to keep bids tight.</p>
        </div>

        <div class="card feature lift">
          <div class="tag">🧷 Hardware</div>
          <h3>Hardware sets</h3>
          <p>Code-aware sets built for function, durability, and consistent field install.</p>
        </div>

        <div class="card feature lift">
          <div class="tag">🚪 Doors &amp; frames</div>
          <h3>Hollow metal / wood</h3>
          <p>Openings coordinated for lead times, ratings, and real-world conditions.</p>
        </div>

        <div class="card feature lift">
          <div class="tag">📄 Submittals</div>
          <h3>Submittals &amp; approvals</h3>
          <p>Clean packages that make approvals painless and procurement predictable.</p>
        </div>

        <div class="card feature lift">
          <div class="tag">🧰 Field</div>
          <h3>Install &amp; service</h3>
          <p>Install support, adjustments, and fixes that keep the punch list short.</p>
        </div>

        <div class="card feature lift">
          <div class="tag">🔐 Access</div>
          <h3>Locks &amp; access control</h3>
          <p>From cores to electrified hardware—planned to work with the rest of the opening.</p>
        </div>
      </div>
    </div>

    <div class="wrap section" id="process">
      <div class="sectionHead">
        <div>
          <h2>How we work</h2>
          <p>Simple, transparent, and documented—so everyone stays aligned.</p>
        </div>
      </div>

      <div class="split">
        <div class="card feature">
          <div class="tag">1) Scope</div>
          <h3>Review drawings &amp; schedule</h3>
          <p>We confirm openings, ratings, and constraints (fire, egress, ADA) early.</p>
        </div>
        <div class="card feature">
          <div class="tag">2) Package</div>
          <h3>Deliver takeoff + sets + alternates</h3>
          <p>You get a clean, field-ready package with notes where decisions matter.</p>
        </div>
        <div class="card feature">
          <div class="tag">3) Approvals</div>
          <h3>Submittals &amp; procurement</h3>
          <p>We keep approvals moving and update lead times as selections lock in.</p>
        </div>
        <div class="card feature">
          <div class="tag">4) Install</div>
          <h3>Coordinate + install + closeout</h3>
          <p>We support field questions and deliver closeout documentation cleanly.</p>
        </div>
      </div>
    </div>

    <div class="wrap section" id="brands">
      <div class="sectionHead">
        <div>
          <h2>Brands we work with</h2>
          <p>Swap these placeholders for your actual manufacturer list.</p>
        </div>
      </div>

      <div class="brands" aria-label="Brand list">
        <span class="brandPill">Assa Abloy</span>
        <span class="brandPill">Schlage</span>
        <span class="brandPill">LCN</span>
        <span class="brandPill">Von Duprin</span>
        <span class="brandPill">Allegion</span>
        <span class="brandPill">Sargent</span>
        <span class="brandPill">Hager</span>
        <span class="brandPill">Dormakaba</span>
      </div>
    </div>

    <div class="wrap section" id="contact">
      <div class="sectionHead">
        <div>
          <h2>Request a quote</h2>
          <p>Send a door schedule or describe the scope. We’ll respond with next steps.</p>
        </div>
      </div>

      <div class="split">
        <div class="card feature">
          <div class="tag">Contact</div>
          <h3>Castle Door &amp; Hardware</h3>
          <p style="margin-bottom: 14px;">
            <strong>Email:</strong> <a href="mailto:info@castledoorandhardware.com">info@castledoorandhardware.com</a><br>
            <strong>Phone:</strong> <a href="tel:+1-000-000-0000">+1 (000) 000-0000</a><br>
            <strong>Service area:</strong> (Update this)
          </p>
          <p class="fine">
            Tip: Add your real phone number, office address, and hours here.
          </p>
        </div>

        <div class="card">
          <form method="post" action="#" onsubmit="return fakeSubmit(event)">
            <div class="row">
              <div>
                <label for="name">Name</label>
                <input id="name" name="name" autocomplete="name" required />
              </div>
              <div>
                <label for="company">Company</label>
                <input id="company" name="company" autocomplete="organization" />
              </div>
            </div>

            <div class="row" style="margin-top:12px;">
              <div>
                <label for="email">Email</label>
                <input id="email" name="email" type="email" autocomplete="email" required />
              </div>
              <div>
                <label for="phone">Phone</label>
                <input id="phone" name="phone" autocomplete="tel" />
              </div>
            </div>

            <div style="margin-top:12px;">
              <label for="message">Project details</label>
              <textarea id="message" name="message" placeholder="Tell us what you need (door types, ratings, quantities, timeline)."></textarea>
            </div>

            <div class="formActions">
              <button class="btn primary lift" type="submit">
                <span class="icon" aria-hidden="true">➜</span>
                Send Request
              </button>
              <span class="fine" id="formStatus" aria-live="polite"></span>
            </div>
          </form>
        </div>
      </div>

      <footer>
        <div>© <span id="year"></span> Castle Door &amp; Hardware. All rights reserved.</div>
        <div style="display:flex; gap:12px; flex-wrap:wrap;">
          <a href="#services">Services</a>
          <a href="#process">Process</a>
          <a href="#brands">Brands</a>
          <a href="#top">Back to top ↑</a>
        </div>
      </footer>
    </div>
  </main>

  <script>
    document.getElementById("year").textContent = new Date().getFullYear();

    function fakeSubmit(e){
      e.preventDefault();
      const status = document.getElementById("formStatus");
      status.textContent = "Thanks! This demo form isn’t wired yet. Connect it to a Pages Function or form service.";
      return false;
    }
  </script>
</body>
</html>`);
      }

      return Response.redirect(buildPortalUrl("/portal/login"), 302);
    }

    return text("Not found", 404);
  },
};


