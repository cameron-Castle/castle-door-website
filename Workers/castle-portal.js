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

    const slug = (s = "") =>
      String(s || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unknown";

    const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();
    const isValidEmail = (value = "") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
    const normalizePortalRole = (value = "") =>
      String(value || "").trim().toLowerCase() === "manager" ? "manager" : "member";
    const splitEmailList = (value = "") =>
      String(value || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => !!s && isValidEmail(s))
        .filter((s, i, arr) => arr.indexOf(s) === i);

    const bizCfgCache = new Map();
    async function getBusinessConfig(businessCode) {
      const biz = slug(businessCode || "");
      if (!biz) return {};
      if (bizCfgCache.has(biz)) return bizCfgCache.get(biz);
      let cfg = {};
      try {
        cfg = (await env.ENROLL_TOKENS.get(`bizcfg:${biz}`, "json")) || {};
      } catch {
        cfg = {};
      }
      const normalized = cfg && typeof cfg === "object" ? cfg : {};
      bizCfgCache.set(biz, normalized);
      return normalized;
    }

    async function isSandboxBusiness(businessCode) {
      const cfg = await getBusinessConfig(businessCode);
      return cfg && cfg.sandbox_demo === true;
    }

    async function listSandboxBusinessCodes() {
      const out = new Set();
      let cursor;
      do {
        const listed = await env.ENROLL_TOKENS.list({ prefix: "bizcfg:", cursor });
        for (const k of listed.keys || []) {
          const bizCode = slug(String(k.name || "").replace(/^bizcfg:/, ""));
          if (!bizCode || bizCode === "unknown") continue;
          const cfg = (await env.ENROLL_TOKENS.get(k.name, "json")) || {};
          if (cfg && cfg.sandbox_demo === true) out.add(bizCode);
        }
        cursor = listed.cursor;
      } while (cursor);
      return Array.from(out);
    }

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

    const getCookieValues = (header, name) => {
      if (!header || !name) return [];
      const values = [];
      header.split(";").forEach((part) => {
        const idx = part.indexOf("=");
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        if (k !== name) return;
        const v = part.slice(idx + 1).trim();
        if (!v) return;
        try {
          values.push(decodeURIComponent(v));
        } catch {
          values.push(v);
        }
      });
      return values;
    };

    const setCookie = (name, value, options = {}) => {
      const parts = [`${name}=${encodeURIComponent(String(value || ""))}`];
      parts.push(`Path=${options.path || "/"}`);
      if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`);
      if (options.httpOnly !== false) parts.push("HttpOnly");
      parts.push(`SameSite=${options.sameSite || "Lax"}`);
      if (options.secure !== false) parts.push("Secure");
      if (options.domain) parts.push(`Domain=${options.domain}`);
      return parts.join("; ");
    };

    const readJsonBody = async (request) => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

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
        const sandboxBusiness = await isSandboxBusiness(businessCode);
        if ((!member || member.active === false) && !sandboxBusiness) {
          sawInactiveMember = true;
          continue;
        }

        const allowedBusinesses = Array.isArray(session.allowedBusinesses)
          ? session.allowedBusinesses.map((x) => slug(x || "")).filter((x) => !!x && x !== "unknown")
          : [];
        const allowedSet = new Set([businessCode, ...allowedBusinesses]);
        const normalizedAllowedBusinesses = Array.from(allowedSet);

        const rawAccessByBusiness =
          session.accessByBusiness && typeof session.accessByBusiness === "object"
            ? session.accessByBusiness
            : {};
        const accessByBusiness = {};
        for (const biz of normalizedAllowedBusinesses) {
          const scoped = rawAccessByBusiness[biz] && typeof rawAccessByBusiness[biz] === "object"
            ? rawAccessByBusiness[biz]
            : {};
          accessByBusiness[biz] = {
            role: normalizePortalRole(
              scoped.role || (biz === businessCode ? (member && member.role) || session.role || "member" : "member")
            ),
            canComment: normalizeCommentPermission(
              scoped.canComment,
              biz === businessCode
                ? normalizeCommentPermission((member && member.canComment) ?? session.canComment, true)
                : true
            ),
          };
        }

        return {
          ok: true,
          role: normalizePortalRole((member && member.role) || session.role || "member"),
          email,
          businessCode,
          canComment: normalizeCommentPermission((member && member.canComment) ?? session.canComment, true),
          allowedBusinesses: normalizedAllowedBusinesses,
          accessByBusiness,
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
      const allowed = Array.isArray(sess.allowedBusinesses)
        ? sess.allowedBusinesses.map((x) => slug(x || "")).filter((x) => !!x && x !== "unknown")
        : [sess.businessCode];
      const allowedSet = new Set([sess.businessCode, ...allowed]);

      const effectiveBusinessCode = targetBiz || sess.businessCode;
      if (!allowedSet.has(effectiveBusinessCode)) {
        return { ok: false, response: json({ error: "Forbidden business scope" }, 403) };
      }

      const scopedMember = await env.ENROLL_TOKENS.get(
        `portalMember:${effectiveBusinessCode}:${sess.email}`,
        "json"
      );
      const sandboxBusiness = await isSandboxBusiness(effectiveBusinessCode);
      if ((!scopedMember || scopedMember.active === false) && !sandboxBusiness) {
        return { ok: false, response: json({ error: "Forbidden business scope" }, 403) };
      }

      const scoped =
        sess.accessByBusiness && typeof sess.accessByBusiness === "object"
          ? sess.accessByBusiness[effectiveBusinessCode]
          : null;
      const effectiveRole = normalizePortalRole(
        (scoped && scoped.role) || (scopedMember && scopedMember.role) || sess.role || "member"
      );
      const effectiveCanComment = normalizeCommentPermission(
        scoped && scoped.canComment,
        normalizeCommentPermission(
          (scopedMember && scopedMember.canComment) ?? sess.canComment,
          true
        )
      );

      if (requireManager && effectiveRole !== "manager") {
        return { ok: false, response: json({ error: "Manager role required" }, 403) };
      }

      return {
        ok: true,
        session: {
          ...sess,
          businessCode: effectiveBusinessCode,
          role: effectiveRole,
          canComment: effectiveCanComment,
          allowedBusinesses: Array.from(allowedSet),
        },
      };
    }

    async function listActivePortalMembershipsByEmail(email) {
      const normEmail = normalizeEmail(email || "");
      if (!normEmail || !isValidEmail(normEmail)) return [];

      const byBusiness = new Map();
      let cursor;
      do {
        const listed = await env.ENROLL_TOKENS.list({ prefix: "portalMember:", cursor });
        for (const k of listed.keys || []) {
          const row = await env.ENROLL_TOKENS.get(k.name, "json");
          if (!row || typeof row !== "object") continue;
          if (row.active === false) continue;
          if (normalizeEmail(row.email || "") !== normEmail) continue;

          const businessCode = slug(row.businessCode || "");
          if (!businessCode || businessCode === "unknown") continue;

          const candidate = {
            businessCode,
            role: normalizePortalRole(row.role || "member"),
            canComment: normalizeCommentPermission(row.canComment, true),
          };

          const existing = byBusiness.get(businessCode);
          if (!existing) {
            byBusiness.set(businessCode, candidate);
            continue;
          }

          const pickManager = existing.role !== "manager" && candidate.role === "manager";
          byBusiness.set(
            businessCode,
            pickManager
              ? candidate
              : {
                  ...existing,
                  canComment: existing.canComment || candidate.canComment,
                }
          );
        }
        cursor = listed.cursor;
      } while (cursor);

      return Array.from(byBusiness.values()).sort((a, b) =>
        String(a.businessCode || "").localeCompare(String(b.businessCode || ""))
      );
    }

    async function buildSessionScopeForEmail(email, preferredBusinessCode = "") {
      const memberships = await listActivePortalMembershipsByEmail(email);
      if (!memberships.length) return null;

      const preferred = slug(preferredBusinessCode || "");
      const selected =
        memberships.find((m) => m.businessCode === preferred) ||
        memberships[0];
      const accessByBusiness = {};
      for (const m of memberships) {
        accessByBusiness[m.businessCode] = {
          role: normalizePortalRole(m.role || "member"),
          canComment: normalizeCommentPermission(m.canComment, true),
        };
      }

      return {
        businessCode: selected.businessCode,
        role: normalizePortalRole(selected.role || "member"),
        canComment: normalizeCommentPermission(selected.canComment, true),
        allowedBusinesses: memberships.map((m) => m.businessCode),
        accessByBusiness,
      };
    }

    async function sendPortalMultiBusinessLoginEmail({
      toEmail,
      links = [],
      traceId = "",
    }) {
      const to = normalizeEmail(toEmail || "");
      if (!to || !isValidEmail(to)) return { attempted: false, sent: false, reason: "invalid_recipient" };

      const apiKey = String(env.RESEND_API_KEY || "").trim();
      const from = String(env.RESEND_FROM || "").trim();
      if (!apiKey || !from) return { attempted: false, sent: false, reason: "resend_not_configured" };
      if (!Array.isArray(links) || !links.length) return { attempted: false, sent: false, reason: "no_links" };

      const listHtml = links
        .map(
          (item) =>
            `<li><a href="${String(item.url || "").replace(/\"/g, "&quot;")}">` +
            `${String(item.businessName || item.businessCode || "Business")}</a></li>`
        )
        .join("");

      const payload = {
        from,
        to: [to],
        subject: "Your Castle Door sign-in links",
        html:
          `<p>Use one of these one-click links to sign in:</p>` +
          `<ul>${listHtml}</ul>` +
          `<p>These links may expire. If they do, request a new sign-in email.</p>` +
          (traceId ? `<p style="color:#64748b;font-size:12px">Ref: ${traceId}</p>` : ""),
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

      const scope = await buildSessionScopeForEmail(email, businessCode);
      if (!scope) return { ok: false, reason: "inactive_member" };

      const sid =
        String(rec.sessionSid || "").trim() ||
        String(preferredSid || "").trim() ||
        crypto.randomUUID().replace(/-/g, "");
      const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;

      await env.ENROLL_TOKENS.put(
        `portalSession:${sid}`,
        JSON.stringify({
          sid,
          businessCode: scope.businessCode,
          email,
          role: scope.role,
          canComment: scope.canComment,
          allowedBusinesses: scope.allowedBusinesses,
          accessByBusiness: scope.accessByBusiness,
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
          role: scope.role,
          email,
          businessCode: scope.businessCode,
          canComment: scope.canComment,
          allowedBusinesses: scope.allowedBusinesses,
          accessByBusiness: scope.accessByBusiness,
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

    const parseInspectionTimestamp = (value) => {
      const raw = String(value || "").trim();
      if (!raw) return 0;
      const ts = Date.parse(raw);
      if (Number.isFinite(ts)) return ts;

      const compact = raw.replace(/\s+/g, " ").trim();
      const mdYTime = compact.match(/^([0-1]?\d)-([0-3]?\d)-(\d{4})\s+(.+)$/);
      if (mdYTime) {
        const mm = mdYTime[1].padStart(2, "0");
        const dd = mdYTime[2].padStart(2, "0");
        const yyyy = mdYTime[3];
        const timePart = mdYTime[4].trim();
        const retry = Date.parse(`${yyyy}-${mm}-${dd} ${timePart}`);
        if (Number.isFinite(retry)) return retry;
      }

      return 0;
    };

    async function submitCtaRequest(payload, options = {}) {
      const sandboxMode = options && options.sandboxMode === true;
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

      if (sandboxMode) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { response: json({ ok: true, id, sandbox: true, simulated: true }), id };
      }

      const now = Date.now();
      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      const reportsOrigin = String(env.REPORTS_ORIGIN || "https://r.castledoorict.com")
        .trim()
        .replace(/\/+$/, "");
      const reportUrl =
        reportsOrigin && businessCode && buildingCode && doorSlug
          ? `${reportsOrigin}/reports/${encodeURIComponent(String(businessCode || ""))}/${encodeURIComponent(
              String(buildingCode || "")
            )}/${encodeURIComponent(String(doorSlug || ""))}`
          : "";
      const pdfUrl = String(payload.pdfUrl || "").toString().trim();
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
        reportUrl,
        pdfUrl,
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

          const escHtml = (s = "") =>
            String(s)
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#39;");

          const payloadBody = {
            from,
            to,
            cc,
            subject: `[Door CTA] ${kind} – ${businessCode} – ${doorId || doorSlug}`,
            html:
              `<p>Business: ${escHtml(businessCode)}</p>` +
              `<p>Door: ${escHtml(doorId || doorSlug)}</p>` +
              `<p>Requester: ${escHtml(requesterName || "(unknown)")} &lt;${escHtml(requesterEmail || "(none)")}&gt;</p>` +
              `<pre>${escHtml(notes || "(none)")}</pre>` +
              (reportUrl ? `<p><a href="${escHtml(reportUrl)}">Open door report</a></p>` : "") +
              (pdfUrl ? `<p><a href="${escHtml(pdfUrl)}">Open inspection PDF</a></p>` : "") +
              `<p>ID: ${escHtml(id)}</p>`,
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
      const demoBiz = slug(url.searchParams.get("biz") || "");
      const demoBizSandbox = demoBiz ? await isSandboxBusiness(demoBiz) : false;
      console.log("[portal-login-page][temp-debug]", {
        host: hostname,
        demoBiz,
        demoBizSandbox,
      });
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
    <p>${demoBizSandbox ? "Demo sandbox login: type in an email or anything, then press login to enter instantly." : "Enter your email and we will send one-click sign-in link(s)."}</p>
    <input id="email" type="text" placeholder="${demoBizSandbox ? "type in an email or anything" : "you@company.com"}" />
    <button id="go">${demoBizSandbox ? "Login" : "Send sign-in link"}</button>
    <div class="msg" id="msg"></div>
  </div>
  <script>
  (function(){
    const demoBiz = ${JSON.stringify(demoBiz)};
    const demoBizSandbox = ${JSON.stringify(demoBizSandbox)};
    const email = document.getElementById("email");
    const go = document.getElementById("go");
    const msg = document.getElementById("msg");
    go.onclick = async function(){
      msg.textContent = "";
      const e = (email.value || "").trim();
      if(!demoBizSandbox && !e){ msg.textContent = "Email is required."; return; }
      const effectiveEmail = e || "demo@castledoorict.com";
      go.disabled = true;
      try {
        const res = await fetch("/api/portal/auth/start", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: effectiveEmail, businessCode: demoBiz || "" })
        });
        const out = await res.json().catch(()=>({}));
        if(!res.ok){ msg.textContent = out.error || "Unable to send sign-in links."; return; }
        if (out && out.portalUrl) {
          window.location = out.portalUrl;
          return;
        }
        msg.textContent = "If your email is authorized, sign-in link(s) have been sent.";
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

      const scope = await buildSessionScopeForEmail(email, businessCode);
      if (!scope) return text("Portal member not active", 403);

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
          JSON.stringify({
            sid,
            businessCode: scope.businessCode,
            email,
            role: scope.role,
            canComment: scope.canComment,
            allowedBusinesses: scope.allowedBusinesses,
            accessByBusiness: scope.accessByBusiness,
            createdAt: Date.now(),
            expiresAt,
          })
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

    // Enhanced portal UX + metrics shell.
    // Keep this route before legacy fallback block below.
    if (req.method === "GET" && pathname === "/portal") {
      const bizRaw = String(url.searchParams.get("biz") || "").trim();
      const bizFromQuery = bizRaw ? slug(bizRaw) : "";
      const bizSandbox = bizFromQuery ? await isSandboxBusiness(bizFromQuery) : false;
      const fromMagic = String(url.searchParams.get("from") || "").trim().toLowerCase() === "magic";
      const magicToken = String(url.searchParams.get("t") || "").trim();
      const retryCountRaw = Number(url.searchParams.get("retry") || "0");
      const retryCount = Number.isFinite(retryCountRaw) ? Math.max(0, Math.trunc(retryCountRaw)) : 0;
      const requestSids = getCookieValues(req.headers.get("Cookie") || "", "castle_portal")
        .map((s) => String(s || "").trim())
        .filter(Boolean);

      let access = await requirePortalAccess(req, bizFromQuery || "", false);
      let usedMagicBootstrap = false;
      console.log("[portal-route][temp-debug] access-check", {
        host: hostname,
        bizFromQuery,
        bizSandbox,
        hasAccess: !!access.ok,
        fromMagic,
        hasMagicToken: !!magicToken,
        retryCount,
      });
      if (!access.ok && fromMagic && magicToken) {
        const bootstrap = await bootstrapPortalSessionFromMagicToken(magicToken, requestSids[0] || "");
        if (bootstrap.ok) {
          usedMagicBootstrap = true;
          access = { ok: true, session: bootstrap.session };
          console.log("[portal-route][temp-debug] magic-bootstrap-success", {
            host: hostname,
            bizFromQuery,
            sessionBiz: slug(bootstrap.session && bootstrap.session.businessCode),
          });
        }
      }

      if (!access.ok) {
        if (bizSandbox && bizFromQuery) {
          const sid = crypto.randomUUID().replace(/-/g, "");
          const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
          const role = "manager";
          const canComment = true;
          const sandboxBusinesses = await listSandboxBusinessCodes();
          const allowedBusinesses = Array.from(new Set([bizFromQuery, ...sandboxBusinesses]
            .map((x) => slug(x || ""))
            .filter((x) => !!x && x !== "unknown")));
          const accessByBusiness = {};
          for (const biz of allowedBusinesses) {
            accessByBusiness[biz] = { role, canComment };
          }
          await env.ENROLL_TOKENS.put(
            `portalSession:${sid}`,
            JSON.stringify({
              sid,
              businessCode: bizFromQuery,
              email: "demo@castledoorict.com",
              role,
              canComment,
              allowedBusinesses,
              accessByBusiness,
              createdAt: Date.now(),
              expiresAt,
              sandboxLogin: true,
            })
          );
          console.log("[portal-route][temp-debug] sandbox-auto-bootstrap", {
            host: hostname,
            bizFromQuery,
            sidPrefix: sid.slice(0, 8),
          });
          return redirectWithCookies(
            buildPortalUrl("/portal", { biz: bizFromQuery }),
            portalSessionSetCookies(sid, 60 * 60 * 24 * 14)
          );
        }

        console.log("[portal-route][temp-debug] redirect-login", {
          host: hostname,
          bizFromQuery,
          bizSandbox,
          requestSidCount: requestSids.length,
          retryCount,
        });
        if (requestSids.length && retryCount < 3) {
          return Response.redirect(buildPortalUrl("/portal", { retry: String(retryCount + 1), biz: bizFromQuery || "" }), 302);
        }
        return Response.redirect(buildPortalUrl("/portal/login", { biz: bizFromQuery || "" }), 302);
      }

      if (!usedMagicBootstrap && (fromMagic || retryCount > 0 || magicToken)) {
        return Response.redirect(buildPortalUrl("/portal"), 302);
      }

      const session = access.session;
      const businessScopes = Array.from(
        new Set(
          [session.businessCode, ...(Array.isArray(session.allowedBusinesses) ? session.allowedBusinesses : [])]
            .map((x) => slug(x || ""))
            .filter((x) => !!x && x !== "unknown")
        )
      );
      const businessCode = businessScopes.includes(bizFromQuery) ? bizFromQuery : session.businessCode;
      const businessOptions = [];
      for (const code of businessScopes) {
        const cfg = await getBusinessConfig(code);
        const businessName = String((cfg && cfg.name) || code).trim() || code;
        businessOptions.push({ code, name: businessName });
      }

      const activeBizCfg = await getBusinessConfig(businessCode);
      const sandboxMode = activeBizCfg && activeBizCfg.sandbox_demo === true;

      return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Customer Portal</title>
  <style>
    :root{--bg:#0b1220;--card:#0f172a;--line:#243043;--border:#1f2937;--text:#e5e7eb;--muted:#94a3b8;--accent:#2563eb;--pass:#22c55e;--conditional:#f59e0b;--flagged:#ef4444}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .wrap{max-width:1180px;margin:0 auto;padding:20px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
    .top-actions{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
    .title{margin:0;font-size:1.35rem}
    .muted{color:var(--muted)}
    .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:12px}
    .kpis{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:10px}
    .kpi{background:#0b1220;border:1px solid var(--line);border-radius:10px;padding:10px}
    .kpi .n{font-size:1.35rem;font-weight:700}
    .kpi.pass .n{color:var(--pass)}
    .kpi.conditional .n{color:var(--conditional)}
    .kpi.flagged .n{color:var(--flagged)}
    .filters{display:grid;grid-template-columns:1fr 210px 210px;gap:10px}
    input,select,button,textarea{padding:9px 10px;border-radius:8px;border:1px solid #334155;background:#111827;color:var(--text)}
    button{background:var(--accent);cursor:pointer}
    button.alt{background:#1f2937}
    .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    table{width:100%;border-collapse:collapse}
    th,td{padding:9px 8px;border-bottom:1px solid var(--line);font-size:.86rem;text-align:left;vertical-align:top}
    th{font-size:.78rem;letter-spacing:.02em;text-transform:uppercase;color:#9ca3af}
    .link{color:#93c5fd;text-decoration:none}
    .empty{padding:18px 8px;color:var(--muted)}
    .pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:.75rem}
    .pill.pass{border-color:rgba(34,197,94,.45);color:#86efac}
    .pill.conditional{border-color:rgba(245,158,11,.45);color:#fcd34d}
    .pill.flagged{border-color:rgba(239,68,68,.45);color:#fca5a5}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .msg{margin-top:8px;font-size:.8rem;color:var(--muted)}
    .demo-banner{margin-top:12px;border:1px solid #f59e0b;background:rgba(245,158,11,.16);color:#fef3c7;border-radius:10px;padding:10px 12px;font-size:.85rem;font-weight:600}
    .tabs{display:flex;gap:8px;align-items:center}
    .tab-btn{background:#1f2937;border:1px solid #334155}
    .tab-btn.active{background:var(--accent);border-color:#1d4ed8}
    @media(max-width:980px){.kpis{grid-template-columns:repeat(3,minmax(130px,1fr))}.filters{grid-template-columns:1fr 1fr}.row{grid-template-columns:1fr}}
    @media(max-width:640px){
      .wrap{padding:10px}
      .kpis{grid-template-columns:1fr}
      .top-actions{width:100%;align-items:flex-start}
      .top-actions .link{display:inline-flex;padding:8px 0}
      .card{padding:10px}
      .filters{position:sticky;top:0;z-index:15;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;background:rgba(11,18,32,.96);backdrop-filter:blur(6px);padding:6px;border:1px solid var(--line);border-radius:10px}
      #status,#building{max-width:118px}
      #q,#status,#building{font-size:.8rem;padding:6px 8px;min-height:32px}
      table{border-collapse:collapse;border-spacing:0;width:100%;min-width:0}
      thead{display:table-header-group}
      tbody tr{display:table-row}
      tbody td{display:table-cell;padding:6px 5px;font-size:.76rem;line-height:1.22;border-bottom:1px solid var(--line)}
      tbody td::before{display:none}
      th{font-size:.64rem;padding:6px 5px;white-space:nowrap}
      #doorRows td:first-child .muted{display:block;font-size:.7rem;line-height:1.1}
      table th:nth-child(4),
      table td:nth-child(4){display:none}
      #doorRows td.actions{display:table-cell;white-space:nowrap}
      #doorRows td.actions .link,
      #doorRows td.actions button{min-height:26px;font-size:.72rem;padding:4px 7px}
      .pill{padding:1px 6px;font-size:.64rem}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1 class="title">Customer Portal</h1>
        <div class="muted">Business: <span id="bizName">${String(businessCode || "")}</span> • Role: ${String(session.role || "member")}</div>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label for="bizSwitch" class="muted" style="font-size:12px">View business:</label>
          <select id="bizSwitch" style="min-width:220px"></select>
          <div class="tabs" id="portalTabs" style="display:none;">
            <button id="tabOverview" class="tab-btn active" type="button">Overview</button>
            <button id="tabAdminTools" class="tab-btn" type="button">Admin tools</button>
          </div>
        </div>
      </div>
      <div class="top-actions">
        <button id="resetAliasChanges" type="button" class="alt" title="Reset local name changes for this business in this browser">Reset changes</button>
        <a class="link" href="/portal/logout">Logout</a>
      </div>
    </div>
    ${sandboxMode ? '<div class="demo-banner">Demo sandbox mode is active for this business. Actions are simulated for this session only and are not permanently saved.</div>' : ''}

    <div id="overviewPane">

    <div class="card" id="doorsCard">
      <div id="kpis" class="kpis">
        <div class="kpi"><div class="muted">Loading metrics</div><div class="n">…</div></div>
      </div>
      <div id="metricsMeta" class="msg"></div>
    </div>

    <div class="card">
      <div class="filters">
        <input id="q" placeholder="Search door label, ID, or building" />
        <select id="status">
          <option value="">All statuses</option>
          <option value="pass">Pass</option>
          <option value="conditional">Conditional Pass</option>
          <option value="flagged">Flagged / Needs Repair</option>
        </select>
        <select id="building"><option value="">All buildings</option></select>
      </div>
      <div class="actions" style="margin-top:10px">
        <button id="refresh" type="button">Refresh</button>
        <span id="tableMeta" class="muted"></span>
      </div>

      <div id="doorTableWrap" style="overflow:auto;margin-top:10px">
        <table>
          <thead>
            <tr>
              <th>Door</th>
              <th>Status</th>
              <th>Building</th>
              <th>Last inspected</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="doorRows"><tr><td colspan="5" class="empty">Loading doors…</td></tr></tbody>
        </table>
      </div>
    </div>

    </div>

    <div class="card" id="managerBlock" style="display:none;">
      <h3 style="margin:0 0 8px 0">Manager settings</h3>
      <div class="row">
        <div>
          <label for="repairTo">Default repair destination</label>
          <input id="repairTo" name="repair_to_route" placeholder="maintenance@customer.com" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" />
        </div>
        <div>
          <label for="repairCc">Always CC list (comma-separated)</label>
          <input id="repairCc" placeholder="ops@customer.com, manager@customer.com" />
        </div>
      </div>
      <div class="actions" style="margin-top:10px">
        <button id="saveRepair" type="button">Save routing</button>
        <span id="managerMsg" class="muted"></span>
      </div>

      <div class="row" style="margin-top:14px">
        <div>
          <label for="businessDisplayName">Business display name</label>
          <input id="businessDisplayName" placeholder="Castle Door HQ" />
        </div>
        <div class="actions" style="align-items:flex-end;justify-content:flex-start">
          <button id="saveBusinessDisplayName" type="button">Save business name</button>
          <span id="displayNameMsg" class="muted"></span>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div>
          <label for="buildingRenameCode">Building</label>
          <select id="buildingRenameCode"><option value="">Select building</option></select>
        </div>
        <div>
          <label for="buildingDisplayName">Building display name</label>
          <input id="buildingDisplayName" placeholder="East Wing" />
        </div>
      </div>
      <div class="actions" style="margin-top:10px">
        <button id="saveBuildingDisplayName" type="button">Save building name</button>
      </div>

      <div class="row" style="margin-top:14px">
        <div>
          <label for="doorRenameTarget">Search Door</label>
          <input id="doorRenameTarget" list="doorRenameTargets" placeholder="Door label / UID" />
          <datalist id="doorRenameTargets"></datalist>
        </div>
        <div>
          <label for="doorDisplayName">Door display name</label>
          <input id="doorDisplayName" placeholder="Office 1" />
        </div>
      </div>
      <div class="actions" style="margin-top:10px">
        <button id="saveDoorDisplayName" type="button">Save Door name</button>
      </div>
    </div>
  </div>

  <script>
  (async function(){
    const businessCode = ${JSON.stringify(businessCode)};
    const sandboxMode = ${JSON.stringify(sandboxMode)};
    const reportsOrigin = ${JSON.stringify(String(env.REPORTS_ORIGIN || "https://r.castledoorict.com").trim().replace(/\/+$/, ""))};
    const businessOptions = ${JSON.stringify(businessOptions)};
    let allDoors = [];
    let dashboardSnapshot = null;

    const rowsEl = document.getElementById("doorRows");
    const bizNameEl = document.getElementById("bizName");
    const qEl = document.getElementById("q");
    const statusEl = document.getElementById("status");
    const buildingEl = document.getElementById("building");
    const tableMetaEl = document.getElementById("tableMeta");
    const metricsMetaEl = document.getElementById("metricsMeta");
    const bizSwitchEl = document.getElementById("bizSwitch");
    const portalTabsEl = document.getElementById("portalTabs");
    const tabOverviewEl = document.getElementById("tabOverview");
    const tabAdminToolsEl = document.getElementById("tabAdminTools");
    const overviewPaneEl = document.getElementById("overviewPane");
    const resetAliasChangesEl = document.getElementById("resetAliasChanges");
    let managerToolsEnabled = false;
    let activeUserEmail = "";
    let localAliases = { businessName: "", buildings: {}, doors: {} };

    function aliasStorageKey(email, biz){
      const e = String(email || "").trim().toLowerCase() || "anonymous";
      const b = String(biz || "").trim().toLowerCase() || "unknown";
      return "castle_portal_aliases:v1:" + e + ":" + b;
    }

    function loadLocalAliases(email, biz){
      localAliases = { businessName: "", buildings: {}, doors: {} };
      const key = aliasStorageKey(email, biz);
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) {
          console.log("[portal-alias-debug] loadLocalAliases:empty", { key, email: String(email || ""), biz: String(biz || "") });
          return;
        }
        const parsed = JSON.parse(raw);
        localAliases = {
          businessName: String((parsed && parsed.businessName) || "").trim(),
          buildings:
            parsed && parsed.buildings && typeof parsed.buildings === "object"
              ? parsed.buildings
              : {},
          doors:
            parsed && parsed.doors && typeof parsed.doors === "object"
              ? parsed.doors
              : {},
        };
        console.log("[portal-alias-debug] loadLocalAliases:loaded", {
          key,
          businessName: localAliases.businessName,
          buildingAliasCount: Object.keys(localAliases.buildings || {}).length,
          doorAliasCount: Object.keys(localAliases.doors || {}).length,
        });
      } catch {
        localAliases = { businessName: "", buildings: {}, doors: {} };
        console.log("[portal-alias-debug] loadLocalAliases:parse-error", { key });
      }
    }

    function saveLocalAliases(){
      const key = aliasStorageKey(activeUserEmail, businessCode);
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify(localAliases || { businessName: "", buildings: {}, doors: {} })
        );
        console.log("[portal-alias-debug] saveLocalAliases:ok", {
          key,
          businessName: String((localAliases && localAliases.businessName) || ""),
          buildings: localAliases && localAliases.buildings ? Object.keys(localAliases.buildings).slice(0, 8) : [],
        });
      } catch {
        // ignore local storage failures
        console.log("[portal-alias-debug] saveLocalAliases:failed", { key });
      }
    }

    function getBusinessAlias(defaultName){
      const local = String((localAliases && localAliases.businessName) || "").trim();
      return local || String(defaultName || "").trim();
    }

    function normalizeAliasKey(value){
      return String(value || "").trim().toLowerCase();
    }

    function getBuildingAlias(buildingCode, fallbackName){
      const code = String(buildingCode || "").trim();
      const fallback = String(fallbackName || "").trim();
      const buildings = localAliases && localAliases.buildings && typeof localAliases.buildings === "object"
        ? localAliases.buildings
        : {};
      const directCode = code ? String(buildings[code] || "").trim() : "";
      const normalizedCode = code ? String(buildings[normalizeAliasKey(code)] || "").trim() : "";
      const directFallback = fallback ? String(buildings[fallback] || "").trim() : "";
      const normalizedFallback = fallback
        ? String(buildings[normalizeAliasKey(fallback)] || "").trim()
        : "";
      const resolved = directCode || normalizedCode || directFallback || normalizedFallback || String(fallback || code || "").trim();
      if (resolved && (code || fallback)) {
        console.log("[portal-alias-debug] getBuildingAlias", {
          code,
          fallback,
          directCode,
          normalizedCode,
          directFallback,
          normalizedFallback,
          resolved,
        });
      }
      return resolved;
    }

    function resolveDoorAlias(door){
      const d = door && typeof door === "object" ? door : {};
      const doorId = String(d.doorId || "").trim();
      const doorSlug = String(d.doorSlug || "").trim();
      const baseLabel = String(d.displayLabel || d.doorId || d.doorSlug || "Door").trim();
      const doors = localAliases && localAliases.doors && typeof localAliases.doors === "object"
        ? localAliases.doors
        : {};
      const keys = [
        doorId,
        normalizeAliasKey(doorId),
        doorSlug,
        normalizeAliasKey(doorSlug),
        baseLabel,
        normalizeAliasKey(baseLabel),
      ].filter(Boolean);
      for (const k of keys) {
        const v = String(doors[k] || "").trim();
        if (v) return v;
      }
      return baseLabel || "Door";
    }

    function applyLocalAliasesToDoor(door){
      const d = door && typeof door === "object" ? door : {};
      const code = String(d.buildingCode || "").trim();
      const fallback = String(d.buildingDisplay || d.building || d.buildingCode || "").trim();
      const aliased = getBuildingAlias(code, fallback);
      const aliasedDoorLabel = resolveDoorAlias(d);
      return {
        ...d,
        displayLabel: aliasedDoorLabel,
        buildingDisplay: aliased || fallback,
      };
    }

    function setActiveTab(nextTab){
      const tab = String(nextTab || "overview").toLowerCase() === "admin" ? "admin" : "overview";
      if (overviewPaneEl) overviewPaneEl.style.display = tab === "overview" ? "block" : "none";
      const managerBlock = document.getElementById("managerBlock");
      if (managerBlock) {
        managerBlock.style.display = managerToolsEnabled && tab === "admin" ? "block" : "none";
      }
      if (tabOverviewEl) tabOverviewEl.classList.toggle("active", tab === "overview");
      if (tabAdminToolsEl) tabAdminToolsEl.classList.toggle("active", tab === "admin");
    }

    function loadBusinessSwitcher(){
      if (!bizSwitchEl) return;
      bizSwitchEl.innerHTML = "";
      (businessOptions || []).forEach(function(opt){
        const option = document.createElement("option");
        option.value = String(opt && opt.code || "");
        option.textContent = String(opt && (opt.name || opt.code) || "");
        bizSwitchEl.appendChild(option);
      });
      if (businessCode) bizSwitchEl.value = businessCode;
      const selected = bizSwitchEl.options && bizSwitchEl.selectedIndex >= 0
        ? bizSwitchEl.options[bizSwitchEl.selectedIndex]
        : null;
      if (selected) {
        const currentLabel = String(selected.textContent || businessCode || "").trim();
        const aliased = getBusinessAlias(currentLabel);
        if (aliased) selected.textContent = aliased;
      }
      bizSwitchEl.addEventListener("change", function(){
        const nextBiz = String(bizSwitchEl.value || "").trim();
        if (!nextBiz || nextBiz === businessCode) return;
        const target = new URL(window.location.href);
        target.searchParams.set("biz", nextBiz);
        window.location.href = target.toString();
      });
    }

    function escHtml(v){
      return String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function normalizeStatus(raw){
      const s = String(raw || "").trim().toLowerCase();
      if (s === "pass") return "pass";
      if (s === "conditional" || s === "conditional pass") return "conditional";
      if (s === "flagged" || s === "fail" || s === "needs repair") return "flagged";
      return "other";
    }

    function statusPill(raw){
      const kind = normalizeStatus(raw);
      const label = raw || "Unknown";
      if (kind === "pass") return '<span class="pill pass">' + escHtml(label) + '</span>';
      if (kind === "conditional") return '<span class="pill conditional">' + escHtml(label) + '</span>';
      if (kind === "flagged") return '<span class="pill flagged">' + escHtml(label) + '</span>';
      return '<span class="pill">' + escHtml(label) + '</span>';
    }

    function formatDate(v){
      if (!v) return "—";
      const d = new Date(v);
      if (isNaN(d.getTime())) return String(v);
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    }

    function formatInspectionDateTime(primaryValue, fallbackValue){
      const primaryRaw = String(primaryValue || "").trim();
      if (primaryRaw) {
        const parsedPrimary = Date.parse(primaryRaw);
        if (Number.isFinite(parsedPrimary)) {
          return formatDate(new Date(parsedPrimary).toISOString());
        }

        const parsedFallback = Date.parse(String(fallbackValue || "").trim());
        const looksLikeTimeOnly = /^\d{1,2}:\d{2}(?::\d{2})?\s*(am|pm)?$/i.test(primaryRaw);
        if (looksLikeTimeOnly && Number.isFinite(parsedFallback)) {
          const datePart = new Date(parsedFallback).toLocaleDateString(undefined, { dateStyle: "medium" });
          return datePart + " " + primaryRaw;
        }
      }

      if (fallbackValue) {
        const parsedFallback = Date.parse(String(fallbackValue));
        if (Number.isFinite(parsedFallback)) {
          return formatDate(new Date(parsedFallback).toISOString());
        }
      }

      if (primaryRaw) return primaryRaw;
      return "—";
    }

    function reportUrlFor(door){
      const biz = encodeURIComponent(String(door.businessCode || businessCode || ""));
      const bld = encodeURIComponent(String(door.buildingCode || door.building || "main"));
      const slug = encodeURIComponent(String(door.doorSlug || ""));
      return reportsOrigin + "/reports/" + biz + "/" + bld + "/" + slug;
    }

    function buildingFilterKey(door){
      return String(door && (door.buildingCode || door.buildingDisplay || door.building) || "").trim();
    }

    function buildingDisplayName(door){
      return String(door && (door.buildingDisplay || door.building || door.buildingCode) || "").trim();
    }

    function selectedBuildingScope(){
      const key = String(buildingEl.value || "").trim();
      if (!key) return { key: "", label: "All buildings" };
      const opt = buildingEl.options && buildingEl.options[buildingEl.selectedIndex];
      const label = String((opt && opt.textContent) || key).trim() || key;
      return { key, label };
    }

    function computeKpisForBuilding(){
      const scope = selectedBuildingScope();
      const now = Date.now();
      const sevenDaysMs = 1000 * 60 * 60 * 24 * 7;
      let pass = 0;
      let conditional = 0;
      let flagged = 0;
      let inspected7d = 0;
      let latestInspectionAt = "";
      let latestInspectionTs = 0;
      const buildingSet = new Set();
      let total = 0;

      allDoors.forEach(function(d){
        const doorBuildingKey = buildingFilterKey(d);
        if (scope.key && doorBuildingKey !== scope.key) return;

        total++;
        const statusKind = normalizeStatus(d.status);
        if (statusKind === "pass") pass++;
        else if (statusKind === "conditional") conditional++;
        else if (statusKind === "flagged") flagged++;

        if (doorBuildingKey) buildingSet.add(doorBuildingKey);

        const inspectedAtRaw = d.lastInspectedAt || d.inspectedAt || d.createdAt || "";
        const inspectedAtTs = Date.parse(String(inspectedAtRaw || ""));
        if (Number.isFinite(inspectedAtTs)) {
          if (now - inspectedAtTs <= sevenDaysMs) inspected7d++;
          if (inspectedAtTs > latestInspectionTs) {
            latestInspectionTs = inspectedAtTs;
            latestInspectionAt = String(inspectedAtRaw);
          }
        }
      });

      return {
        totals: { total, pass, conditional, flagged },
        metrics: {
          inspected7d,
          buildingCount: buildingSet.size,
          latestInspectionAt,
        },
        generatedAt: dashboardSnapshot && dashboardSnapshot.generatedAt ? dashboardSnapshot.generatedAt : "",
        scopeLabel: scope.label,
        isScopedToBuilding: !!scope.key,
      };
    }

    function renderRows(){
      renderKpis(computeKpisForBuilding());

      const q = String(qEl.value || "").trim().toLowerCase();
      const status = String(statusEl.value || "").trim().toLowerCase();
      const building = String(buildingEl.value || "").trim();

      const filtered = allDoors.filter(function(d){
        const statusKind = normalizeStatus(d.status);
        if (status && statusKind !== status) return false;
        if (building && buildingFilterKey(d) !== building) return false;
        if (!q) return true;

        const hay = [
          d.displayLabel,
          d.doorId,
          d.doorSlug,
          d.buildingDisplay,
          d.building,
          d.buildingCode,
          d.status,
        ]
          .map(function(x){ return String(x || "").toLowerCase(); })
          .join(" ");
        return hay.indexOf(q) !== -1;
      });

      rowsEl.innerHTML = "";
      if (!filtered.length) {
        rowsEl.innerHTML = '<tr><td colspan="5" class="empty">No doors match the current filters.</td></tr>';
        tableMetaEl.textContent = "0 results";
        return;
      }

      filtered.forEach(function(d){
        const tr = document.createElement("tr");
        const title = d.displayLabel || d.doorId || d.doorSlug || "Door";
        const buildingLabel = d.buildingDisplay || d.building || d.buildingCode || "—";
        const pdfCandidate = d.fileUrl || d.pdfUrl || d.pdfPath || d.pdfKey || "";
        const pdfUrl =
          pdfCandidate && String(pdfCandidate).startsWith("http")
            ? String(pdfCandidate)
            : "";
        tr.innerHTML =
          '<td><strong>' + escHtml(title) + '</strong><div class="muted">' + escHtml(d.doorId || "") + '</div></td>' +
          '<td>' + statusPill(d.status || "") + '</td>' +
          '<td>' + escHtml(buildingLabel) + '</td>' +
          '<td>' + escHtml(formatInspectionDateTime(d.lastInspectedAt || d.inspectedAt || "", d.uploadedAt || d.createdAt || "")) + '</td>' +
          '<td class="actions">' +
            '<a class="link" href="' + escHtml(reportUrlFor(d)) + '" target="_blank" rel="noopener">View report</a>' +
            '<button type="button" class="alt" data-door="' + escHtml(d.doorId || "") + '" data-door-slug="' + escHtml(d.doorSlug || "") + '" data-building-code="' + escHtml(d.buildingCode || d.building || "") + '" data-pdf-url="' + escHtml(pdfUrl) + '">Request repair</button>' +
          '</td>';
        rowsEl.appendChild(tr);
      });

      rowsEl.querySelectorAll("button[data-door],button[data-door-slug]").forEach(function(btn){
        btn.addEventListener("click", async function(){
          const doorId = btn.getAttribute("data-door") || "";
          const doorSlug = btn.getAttribute("data-door-slug") || "";
          const buildingCode = btn.getAttribute("data-building-code") || "";
          const pdfUrl = btn.getAttribute("data-pdf-url") || "";
          const notes = window.prompt("Describe the requested repair:", "") || "";
          if (!notes.trim()) return;

          btn.disabled = true;
          try {
            const res = await fetch("/api/portal/cta-submit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                businessCode: businessCode,
                kind: "repair",
                buildingCode: buildingCode,
                doorId: doorId,
                doorSlug: doorSlug,
                pdfUrl: pdfUrl,
                notes: notes,
              }),
            });
            const out = await res.json().catch(function(){ return {}; });
            if (!res.ok) {
              window.alert(out.error || "Unable to submit repair request.");
              return;
            }
            if (out && out.sandbox) {
              window.alert("Demo sandbox: repair request simulated. ID: " + out.id);
            } else {
              window.alert("Repair request submitted. ID: " + out.id);
            }
          } finally {
            btn.disabled = false;
          }
        });
      });

      tableMetaEl.textContent = String(filtered.length) + " result" + (filtered.length === 1 ? "" : "s");
    }

    function renderKpis(kpiState){
      const totals = kpiState && kpiState.totals ? kpiState.totals : {};
      const metrics = kpiState && kpiState.metrics ? kpiState.metrics : {};
      const kpis = document.getElementById("kpis");
      kpis.innerHTML =
        '<div class="kpi"><div class="muted">Total doors</div><div class="n">' + Number(totals.total || 0) + '</div></div>' +
        '<div class="kpi pass"><div class="muted">Pass</div><div class="n">' + Number(totals.pass || 0) + '</div></div>' +
        '<div class="kpi conditional"><div class="muted">Conditional</div><div class="n">' + Number(totals.conditional || 0) + '</div></div>' +
        '<div class="kpi flagged"><div class="muted">Flagged</div><div class="n">' + Number(totals.flagged || 0) + '</div></div>' +
        '<div class="kpi"><div class="muted">Inspected (7d)</div><div class="n">' + Number(metrics.inspected7d || 0) + '</div></div>';

      const generatedAt = kpiState && kpiState.generatedAt ? formatDate(kpiState.generatedAt) : "";
      const buildingCount = Number(metrics.buildingCount || 0);
      const baselineTotals = dashboardSnapshot && dashboardSnapshot.totals ? dashboardSnapshot.totals : {};
      const scopeLabel = String((kpiState && kpiState.scopeLabel) || "All buildings").trim() || "All buildings";
      const isScopedToBuilding = !!(kpiState && kpiState.isScopedToBuilding);

      if (bizNameEl && dashboardSnapshot && dashboardSnapshot.businessName) {
        bizNameEl.textContent = String(dashboardSnapshot.businessName || "");
      }
      metricsMetaEl.textContent = [
        generatedAt ? ("Updated: " + generatedAt) : "",
        "Scope: " + scopeLabel,
        "Buildings: " + buildingCount,
        isScopedToBuilding ? ("Business total doors: " + Number(baselineTotals.total || 0)) : "",
      ].filter(Boolean).join(" • ");
    }

    async function loadDashboard(){
      rowsEl.innerHTML = '<tr><td colspan="5" class="empty">Loading doors…</td></tr>';
      const dashboardRes = await fetch("/api/portal/dashboard?businessCode=" + encodeURIComponent(businessCode));
      const dashboard = await dashboardRes.json().catch(function(){ return {}; });
      if (!dashboardRes.ok) {
        rowsEl.innerHTML = '<tr><td colspan="5" class="empty">' + escHtml(dashboard.error || "Unable to load dashboard") + '</td></tr>';
        return;
      }

      dashboardSnapshot = dashboard;
      const rawDoors = Array.isArray(dashboard.doors) ? dashboard.doors : [];
      console.log("[portal-alias-debug] loadDashboard:raw", {
        businessCode,
        doorCount: rawDoors.length,
        sample: rawDoors.slice(0, 6).map(function(d){
          return {
            doorId: String((d && d.doorId) || ""),
            buildingCode: String((d && d.buildingCode) || ""),
            buildingDisplay: String((d && d.buildingDisplay) || ""),
            building: String((d && d.building) || ""),
          };
        }),
      });
      allDoors = rawDoors.map(function(d){ return applyLocalAliasesToDoor(d); });
      console.log("[portal-alias-debug] loadDashboard:aliased", {
        businessCode,
        doorCount: allDoors.length,
        sample: allDoors.slice(0, 6).map(function(d){
          return {
            doorId: String((d && d.doorId) || ""),
            buildingCode: String((d && d.buildingCode) || ""),
            buildingDisplay: String((d && d.buildingDisplay) || ""),
          };
        }),
      });
      if (dashboardSnapshot && typeof dashboardSnapshot === "object") {
        dashboardSnapshot.businessName = getBusinessAlias(dashboardSnapshot.businessName || businessCode || "");
      }

      const buildingOptions = new Map();
      allDoors.forEach(function(d){
        const key = buildingFilterKey(d);
        const label = buildingDisplayName(d) || key;
        if (!key) return;
        if (!buildingOptions.has(key)) {
          buildingOptions.set(key, label);
          return;
        }
        const existing = String(buildingOptions.get(key) || "");
        if (existing === key && label && label !== key) {
          buildingOptions.set(key, label);
        }
      });
      const current = String(buildingEl.value || "");
      buildingEl.innerHTML = '<option value="">All buildings</option>';
      Array.from(buildingOptions.entries())
        .sort(function(a, b){ return String(a[1] || a[0]).localeCompare(String(b[1] || b[0])); })
        .forEach(function(entry){
        const v = entry[0];
        const label = entry[1];
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = label;
        buildingEl.appendChild(opt);
      });
      if (current && buildingOptions.has(current)) buildingEl.value = current;

      renderRows();
    }

    qEl.addEventListener("input", renderRows);
    statusEl.addEventListener("change", renderRows);
    buildingEl.addEventListener("change", renderRows);
    document.getElementById("refresh").addEventListener("click", loadDashboard);

    const meRes = await fetch("/api/portal/me?businessCode=" + encodeURIComponent(businessCode));
    const me = await meRes.json().catch(function(){ return {}; });
    activeUserEmail = String(me && me.email || "").trim().toLowerCase();
    loadLocalAliases(activeUserEmail, businessCode);

    if (resetAliasChangesEl) {
      resetAliasChangesEl.addEventListener("click", async function(){
        const confirmed = window.confirm("Reset local business/building name changes for this business on this browser?");
        if (!confirmed) return;

        const key = aliasStorageKey(activeUserEmail, businessCode);
        try {
          window.localStorage.removeItem(key);
        } catch {
          // ignore localStorage failures
        }
        localAliases = { businessName: "", buildings: {}, doors: {} };

        loadBusinessSwitcher();
        await loadDashboard();

        const businessDisplayNameEl = document.getElementById("businessDisplayName");
        const buildingRenameCodeEl = document.getElementById("buildingRenameCode");
        const buildingDisplayNameEl = document.getElementById("buildingDisplayName");
        const doorRenameTargetEl = document.getElementById("doorRenameTarget");
        const doorDisplayNameEl = document.getElementById("doorDisplayName");
        const displayNameMsgEl = document.getElementById("displayNameMsg");
        if (businessDisplayNameEl) businessDisplayNameEl.value = String((dashboardSnapshot && dashboardSnapshot.businessName) || businessCode || "");
        if (buildingRenameCodeEl) buildingRenameCodeEl.value = "";
        if (buildingDisplayNameEl) buildingDisplayNameEl.value = "";
        if (doorRenameTargetEl) doorRenameTargetEl.value = "";
        if (doorDisplayNameEl) doorDisplayNameEl.value = "";
        if (displayNameMsgEl) displayNameMsgEl.textContent = "Local name changes reset for this browser.";
      });
    }

    loadBusinessSwitcher();
    await loadDashboard();

    if (meRes.ok && me.role === "manager") {
      const managerBlock = document.getElementById("managerBlock");
      const repairToEl = document.getElementById("repairTo");
      const repairCcEl = document.getElementById("repairCc");
      const managerMsgEl = document.getElementById("managerMsg");
      const businessDisplayNameEl = document.getElementById("businessDisplayName");
      const saveBusinessDisplayNameEl = document.getElementById("saveBusinessDisplayName");
      const buildingRenameCodeEl = document.getElementById("buildingRenameCode");
      const buildingDisplayNameEl = document.getElementById("buildingDisplayName");
      const saveBuildingDisplayNameEl = document.getElementById("saveBuildingDisplayName");
      const doorRenameTargetEl = document.getElementById("doorRenameTarget");
      const doorRenameTargetsEl = document.getElementById("doorRenameTargets");
      const doorDisplayNameEl = document.getElementById("doorDisplayName");
      const saveDoorDisplayNameEl = document.getElementById("saveDoorDisplayName");
      const displayNameMsgEl = document.getElementById("displayNameMsg");
      let hiddenRepairDefaultTo = "";
      const viewerEmail = String(me && me.email || "").trim().toLowerCase();
      managerToolsEnabled = true;
      managerBlock.style.display = "none";
      if (portalTabsEl) portalTabsEl.style.display = "flex";
      if (tabOverviewEl) tabOverviewEl.addEventListener("click", function(){ setActiveTab("overview"); });
      if (tabAdminToolsEl) tabAdminToolsEl.addEventListener("click", function(){ setActiveTab("admin"); });
      setActiveTab("overview");

      const setRes = await fetch("/api/portal/settings/repair?businessCode=" + encodeURIComponent(businessCode));
      const setOut = await setRes.json().catch(function(){ return {}; });

      const hideViewerEmailFromRepairTo = function(){
        const current = String(repairToEl.value || "").trim();
        if (!current || !viewerEmail) return;
        if (current.toLowerCase() !== viewerEmail) return;
        if (!hiddenRepairDefaultTo) hiddenRepairDefaultTo = current;
        repairToEl.value = "";
        repairToEl.placeholder = "(hidden — your email)";
      };

      if (setRes.ok) {
        const defaultToRaw = String(setOut.defaultTo || "").trim();
        if (defaultToRaw && viewerEmail && defaultToRaw.toLowerCase() === viewerEmail) {
          hiddenRepairDefaultTo = defaultToRaw;
          repairToEl.value = "";
          repairToEl.placeholder = "(hidden — your email)";
        } else {
          hiddenRepairDefaultTo = "";
          repairToEl.value = defaultToRaw;
          repairToEl.placeholder = "maintenance@customer.com";
        }
        repairCcEl.value = setOut.alwaysCc || "";
      }

      // Browser password/email managers may autofill after script sets values.
      // Re-check a few times and strip viewer email from visible input.
      hideViewerEmailFromRepairTo();
      setTimeout(hideViewerEmailFromRepairTo, 50);
      setTimeout(hideViewerEmailFromRepairTo, 300);
      setTimeout(hideViewerEmailFromRepairTo, 1000);

      repairToEl.addEventListener("input", function(){
        const v = String(repairToEl.value || "").trim();
        if (v) hiddenRepairDefaultTo = "";
        hideViewerEmailFromRepairTo();
      });
      repairToEl.addEventListener("focus", hideViewerEmailFromRepairTo);
      repairToEl.addEventListener("blur", hideViewerEmailFromRepairTo);

      document.getElementById("saveRepair").addEventListener("click", async function(){
        managerMsgEl.textContent = "Saving…";
        const defaultToInput = String(repairToEl.value || "").trim();
        const effectiveDefaultTo = defaultToInput || hiddenRepairDefaultTo || "";
        const res = await fetch("/api/portal/settings/repair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            businessCode: businessCode,
            defaultTo: effectiveDefaultTo,
            alwaysCc: (repairCcEl.value || "").trim(),
          }),
        });
        const out = await res.json().catch(function(){ return {}; });
        if (res.ok && out && out.sandbox) {
          managerMsgEl.textContent = "Demo sandbox: settings change simulated for this session only.";
        } else {
          managerMsgEl.textContent = res.ok ? "Saved." : (out.error || "Failed to save routing.");
        }
        if (res.ok) {
          const savedDefaultTo = String((out && out.defaultTo) || effectiveDefaultTo || "").trim();
          if (savedDefaultTo && viewerEmail && savedDefaultTo.toLowerCase() === viewerEmail) {
            hiddenRepairDefaultTo = savedDefaultTo;
            repairToEl.value = "";
            repairToEl.placeholder = "(hidden — your email)";
          } else {
            hiddenRepairDefaultTo = "";
            repairToEl.value = savedDefaultTo;
            repairToEl.placeholder = "maintenance@customer.com";
          }
        }
      });

      const displayRes = await fetch("/api/portal/settings/display?businessCode=" + encodeURIComponent(businessCode));
      const displayOut = await displayRes.json().catch(function(){ return {}; });
      if (displayRes.ok) {
        businessDisplayNameEl.value = getBusinessAlias(String(displayOut.businessName || ""));
        const buildings = Array.isArray(displayOut.buildings) ? displayOut.buildings : [];
        buildingRenameCodeEl.innerHTML = '<option value="">Select building</option>';
        buildings
          .slice()
          .sort(function(a, b){ return String(a.name || a.buildingCode || "").localeCompare(String(b.name || b.buildingCode || "")); })
          .forEach(function(row){
            const code = String(row && row.buildingCode || "").trim();
            if (!code) return;
            const opt = document.createElement("option");
            opt.value = code;
            const baseName = String(row && (row.name || row.buildingCode) || code);
            const aliasedName = getBuildingAlias(code, baseName);
            opt.textContent = aliasedName;
            opt.setAttribute("data-name", aliasedName);
            buildingRenameCodeEl.appendChild(opt);
          });
      }

      buildingRenameCodeEl.addEventListener("change", function(){
        const opt = buildingRenameCodeEl.options[buildingRenameCodeEl.selectedIndex];
        const name = String((opt && opt.getAttribute("data-name")) || "").trim();
        buildingDisplayNameEl.value = name;
      });

      const doorKeyFor = function(d){
        const doorId = String((d && d.doorId) || "").trim();
        const doorSlug = String((d && d.doorSlug) || "").trim();
        return doorId || doorSlug;
      };

      const findDoorByKey = function(key){
        const k = normalizeAliasKey(key);
        if (!k) return null;
        return (allDoors || []).find(function(d){
          const doorId = normalizeAliasKey(d && d.doorId);
          const doorSlug = normalizeAliasKey(d && d.doorSlug);
          const label = normalizeAliasKey(d && d.displayLabel);
          return k === doorId || k === doorSlug || k === label;
        }) || null;
      };

      const populateDoorRenameTargets = function(){
        if (!doorRenameTargetsEl) return;
        doorRenameTargetsEl.innerHTML = "";
        const seen = new Set();
        (allDoors || []).forEach(function(d){
          const key = doorKeyFor(d);
          if (!key) return;
          const label = String((d && d.displayLabel) || key).trim() || key;
          if (seen.has(key)) return;
          seen.add(key);
          const opt = document.createElement("option");
          opt.value = key;
          opt.label = label;
          doorRenameTargetsEl.appendChild(opt);
        });
      };

      populateDoorRenameTargets();

      if (doorRenameTargetEl && doorDisplayNameEl) {
        doorRenameTargetEl.addEventListener("change", function(){
          const key = String(doorRenameTargetEl.value || "").trim();
          if (!key) {
            doorDisplayNameEl.value = "";
            return;
          }
          const found = findDoorByKey(key);
          if (!found) return;
          doorDisplayNameEl.value = String((found && found.displayLabel) || "").trim();
        });
      }

      if (saveDoorDisplayNameEl && doorRenameTargetEl && doorDisplayNameEl) {
        saveDoorDisplayNameEl.addEventListener("click", async function(){
          const key = String(doorRenameTargetEl.value || "").trim();
          const name = String(doorDisplayNameEl.value || "").trim();
          if (!key) {
            displayNameMsgEl.textContent = "Choose a door first.";
            return;
          }
          if (!name) {
            displayNameMsgEl.textContent = "Door name is required.";
            return;
          }
          const found = findDoorByKey(key);
          if (!found) {
            displayNameMsgEl.textContent = "Door not found in current list.";
            return;
          }

          const doorId = String((found && found.doorId) || "").trim();
          const doorSlug = String((found && found.doorSlug) || "").trim();
          const priorLabel = String((found && found.displayLabel) || "").trim();
          localAliases.doors = localAliases.doors && typeof localAliases.doors === "object"
            ? localAliases.doors
            : {};
          const doorKeys = [
            doorId,
            normalizeAliasKey(doorId),
            doorSlug,
            normalizeAliasKey(doorSlug),
            key,
            normalizeAliasKey(key),
            priorLabel,
            normalizeAliasKey(priorLabel)
          ].filter(Boolean);
          doorKeys.forEach(function(k){ localAliases.doors[k] = name; });
          saveLocalAliases();

          displayNameMsgEl.textContent = "Door name saved locally for this signed-in customer.";
          await loadDashboard();
          populateDoorRenameTargets();
          doorRenameTargetEl.value = doorId || doorSlug || key;
          doorDisplayNameEl.value = name;
        });
      }

      saveBusinessDisplayNameEl.addEventListener("click", async function(){
        const name = String(businessDisplayNameEl.value || "").trim();
        if (!name) {
          displayNameMsgEl.textContent = "Business name is required.";
          return;
        }
        console.log("[portal-alias-debug] saveBusinessAlias:start", {
          businessCode,
          activeUserEmail,
          nextName: name,
        });
        localAliases.businessName = name;
        saveLocalAliases();
        businessDisplayNameEl.value = name;
        if (bizNameEl) bizNameEl.textContent = name;
        if (bizSwitchEl && bizSwitchEl.value === businessCode && bizSwitchEl.selectedIndex >= 0) {
          bizSwitchEl.options[bizSwitchEl.selectedIndex].textContent = name;
        }
        displayNameMsgEl.textContent = "Business name saved locally for this signed-in customer.";
        await loadDashboard();
        populateDoorRenameTargets();
      });

      saveBuildingDisplayNameEl.addEventListener("click", async function(){
        const buildingCode = String(buildingRenameCodeEl.value || "").trim();
        const name = String(buildingDisplayNameEl.value || "").trim();
        if (!buildingCode) {
          displayNameMsgEl.textContent = "Choose a building first.";
          return;
        }
        if (!name) {
          displayNameMsgEl.textContent = "Building name is required.";
          return;
        }
        localAliases.buildings = localAliases.buildings && typeof localAliases.buildings === "object"
          ? localAliases.buildings
          : {};
        localAliases.buildings[buildingCode] = name;
        localAliases.buildings[normalizeAliasKey(buildingCode)] = name;
        const opt = buildingRenameCodeEl.options[buildingRenameCodeEl.selectedIndex];
        const priorName = String((opt && opt.getAttribute("data-name")) || "").trim();
        console.log("[portal-alias-debug] saveBuildingAlias:start", {
          businessCode,
          activeUserEmail,
          buildingCode,
          priorName,
          nextName: name,
        });
        if (priorName) {
          localAliases.buildings[priorName] = name;
          localAliases.buildings[normalizeAliasKey(priorName)] = name;
        }
        saveLocalAliases();
        if (opt) {
          opt.textContent = name;
          opt.setAttribute("data-name", name);
        }
        displayNameMsgEl.textContent = "Building name saved locally for this signed-in customer.";
        await loadDashboard();
        populateDoorRenameTargets();
      });
    }
  })();
  </script>
</body>
</html>`);
    }

    if (req.method === "POST" && pathname === "/api/portal/auth/start") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const traceId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

      const rawEmail = String(body.email || "").trim();
      const normalizedEmail = normalizeEmail(rawEmail);
      const preferredBusinessCode = slug(body.businessCode || body.biz || "");
      const sandboxForPreferredBiz = preferredBusinessCode
        ? await isSandboxBusiness(preferredBusinessCode)
        : false;
      console.log("[portal-auth-start][temp-debug] request", {
        traceId,
        preferredBusinessCode,
        rawEmailLen: rawEmail.length,
        sandboxForPreferredBiz,
      });

      if (preferredBusinessCode && sandboxForPreferredBiz) {
        const email = normalizedEmail || "demo@castledoorict.com";
        const sid = crypto.randomUUID().replace(/-/g, "");
        const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
        const role = "manager";
        const canComment = true;
        const sandboxBusinesses = await listSandboxBusinessCodes();
        const allowedBusinesses = Array.from(new Set([preferredBusinessCode, ...sandboxBusinesses]
          .map((x) => slug(x || ""))
          .filter((x) => !!x && x !== "unknown")));
        const accessByBusiness = {};
        for (const biz of allowedBusinesses) {
          accessByBusiness[biz] = { role, canComment };
        }
        await env.ENROLL_TOKENS.put(
          `portalSession:${sid}`,
          JSON.stringify({
            sid,
            businessCode: preferredBusinessCode,
            email,
            role,
            canComment,
            allowedBusinesses,
            accessByBusiness,
            createdAt: Date.now(),
            expiresAt,
            sandboxLogin: true,
          })
        );

        const headers = new Headers({ "content-type": "application/json" });
        for (const c of portalSessionSetCookies(sid, 60 * 60 * 24 * 14)) {
          headers.append("Set-Cookie", c);
        }
        console.log("[portal-auth-start][temp-debug] sandbox-branch", {
          traceId,
          preferredBusinessCode,
          email,
          sidPrefix: sid.slice(0, 8),
        });
        return new Response(
          JSON.stringify({
            ok: true,
            sandbox: true,
            simulated: true,
            businessCode: preferredBusinessCode,
            email,
            portalUrl: buildPortalUrl("/portal", { biz: preferredBusinessCode }),
          }),
          { status: 200, headers }
        );
      }

      const email = normalizedEmail;
      if (!email || !isValidEmail(email)) {
        console.log("[portal-auth-start][temp-debug] rejected-invalid-email", {
          traceId,
          preferredBusinessCode,
          rawEmailLen: rawEmail.length,
        });
        return json({ error: "valid email required" }, 400);
      }

      const memberships = await listActivePortalMembershipsByEmail(email);
      if (!memberships.length) {
        console.log("[portal-auth-start] member-missing-or-inactive", {
          traceId,
          email,
        });
        return json({ ok: true, traceId });
      }

      const orderedMemberships = memberships.slice().sort((a, b) => {
        if (a.businessCode === preferredBusinessCode && b.businessCode !== preferredBusinessCode) return -1;
        if (b.businessCode === preferredBusinessCode && a.businessCode !== preferredBusinessCode) return 1;
        return String(a.businessCode || "").localeCompare(String(b.businessCode || ""));
      });

      const links = [];
      for (const m of orderedMemberships) {
        const magicToken = crypto.randomUUID().replace(/-/g, "");
        await env.ENROLL_TOKENS.put(
          `portalMagic:${magicToken}`,
          JSON.stringify({
            token: magicToken,
            businessCode: m.businessCode,
            email,
            createdAt: Date.now(),
            expiresAt: Date.now() + 1000 * 60 * 10,
          })
        );
        const cfg = (await env.ENROLL_TOKENS.get(`bizcfg:${m.businessCode}`, "json")) || {};
        links.push({
          businessCode: m.businessCode,
          businessName: String((cfg && cfg.name) || m.businessCode).trim() || m.businessCode,
          url: buildPortalUrl("/portal/magic", { t: magicToken }),
        });
      }

      const emailDispatch = await sendPortalMultiBusinessLoginEmail({
        toEmail: email,
        links,
        traceId,
      });

      console.log("[portal-auth-start] session-created", {
        traceId,
        email,
        links: links.length,
        emailSent: !!(emailDispatch && emailDispatch.sent),
      });

      const isUploadDebug = String(env.DEBUG_UPLOAD || "").trim() === "1";
      return json({
        ok: true,
        traceId,
        businesses: links.map((x) => ({ businessCode: x.businessCode, businessName: x.businessName })),
        emailDispatch,
        debugLinks: isUploadDebug ? links : undefined,
      });
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
      const sandboxMode = await isSandboxBusiness(access.session.businessCode);
      return json({ ok: true, ...access.session, canComment: normalizeCommentPermission(access.session.canComment, true), sandboxMode });
    }

    if (req.method === "GET" && pathname === "/api/portal/dashboard") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(req, businessCode, false);
      if (!access.ok) return access.response;

      const biz = access.session.businessCode;
      const doors = await listBusinessDoorSummaries(env.REPORTS_KV, biz);
      const bizCfg = await getBusinessConfig(biz);
      const firstDoorBizName =
        doors.find((d) => d && typeof d.business === "string" && d.business.trim())?.business || "";
      const businessName =
        String((bizCfg && bizCfg.name) || firstDoorBizName || biz)
          .trim() || biz;
      const buildingCodes = new Set();
      for (const d of doors) {
        const code = String(d?.buildingCode || "").trim();
        if (code) buildingCodes.add(code);
      }
      const buildingNameByCode = {};
      for (const code of buildingCodes) {
        try {
          const rec = await env.REPORTS_KV.get(`bldcfg:${biz}:${code}`, "json");
          const name = String((rec && rec.name) || "").trim();
          if (name) buildingNameByCode[code] = name;
        } catch {
          // ignore per-building lookup errors and continue with fallback labels
        }
      }

      const normalizedDoors = doors.map((d) => {
        const buildingCode = String(d?.buildingCode || "").trim();
        const buildingRaw = String(d?.building || "").trim();
        const cfgName = buildingCode ? String(buildingNameByCode[buildingCode] || "").trim() : "";
        const buildingDisplay =
          cfgName ||
          (buildingRaw && buildingRaw !== buildingCode ? buildingRaw : "") ||
          buildingCode ||
          buildingRaw ||
          "main";
        return {
          ...d,
          buildingDisplay,
        };
      });
      let pass = 0;
      let conditional = 0;
      let flagged = 0;
      let inspected7d = 0;
      let latestInspectionAt = "";
      const buildingSet = new Set();
      const now = Date.now();
      const sevenDaysMs = 1000 * 60 * 60 * 24 * 7;
      for (const d of normalizedDoors) {
        const s = String(d.status || "").trim().toLowerCase();
        if (s === "pass") pass++;
        else if (s === "conditional pass" || s === "conditional") conditional++;
        else if (s === "fail" || s === "flagged" || s === "needs repair") flagged++;

        const buildingKey = String(d.buildingCode || d.building || "").trim();
        if (buildingKey) buildingSet.add(buildingKey);

        const inspectedAtRaw = d.lastInspectedAt || d.inspectedAt || d.createdAt || "";
        const inspectedAtTs = parseInspectionTimestamp(inspectedAtRaw);
        if (Number.isFinite(inspectedAtTs)) {
          if (now - inspectedAtTs <= sevenDaysMs) inspected7d++;
          const latestTs = parseInspectionTimestamp(latestInspectionAt);
          if (!latestInspectionAt || inspectedAtTs > latestTs) {
            latestInspectionAt = String(inspectedAtRaw);
          }
        }
      }

      return json({
        ok: true,
        businessCode: biz,
        sandboxMode: bizCfg && bizCfg.sandbox_demo === true,
        businessName,
        totals: { total: doors.length, pass, conditional, flagged },
        metrics: {
          inspected7d,
          buildingCount: buildingSet.size,
          latestInspectionAt,
        },
        generatedAt: new Date().toISOString(),
        doors: normalizedDoors
          .slice()
          .sort((a, b) => {
            const aTs = parseInspectionTimestamp(a.lastInspectedAt || a.inspectedAt || a.createdAt || "");
            const bTs = parseInspectionTimestamp(b.lastInspectedAt || b.inspectedAt || b.createdAt || "");
            if (aTs !== bTs) return bTs - aTs;
            return String(b.lastInspectedAt || b.inspectedAt || b.createdAt || "").localeCompare(
              String(a.lastInspectedAt || a.inspectedAt || a.createdAt || "")
            );
          })
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
      const sandboxMode = await isSandboxBusiness(biz);
      if (sandboxMode) {
        return json({
          ok: true,
          businessCode: biz,
          defaultTo,
          alwaysCc,
          sandbox: true,
          simulated: true,
        });
      }
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

    if (req.method === "GET" && pathname === "/api/portal/settings/display") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;

      const biz = access.session.businessCode;
      const bizCfg = (await env.ENROLL_TOKENS.get(`bizcfg:${biz}`, "json")) || {};
      const doors = await listBusinessDoorSummaries(env.REPORTS_KV, biz);
      const buildingCodes = new Set();
      for (const d of doors) {
        const code = String((d && d.buildingCode) || "").trim();
        if (code) buildingCodes.add(code);
      }

      const buildings = [];
      for (const code of buildingCodes) {
        const rec = (await env.REPORTS_KV.get(`bldcfg:${biz}:${code}`, "json")) || {};
        const cfgName = String((rec && rec.name) || "").trim();
        const fallbackName =
          doors.find((d) => String((d && d.buildingCode) || "").trim() === code && String((d && d.building) || "").trim())
            ?.building || code;
        buildings.push({ buildingCode: code, name: cfgName || String(fallbackName || code) });
      }

      return json({
        ok: true,
        businessCode: biz,
        businessName: String((bizCfg && bizCfg.name) || biz).trim() || biz,
        buildings: buildings
          .slice()
          .sort((a, b) => String(a.name || a.buildingCode || "").localeCompare(String(b.name || b.buildingCode || ""))),
      });
    }

    if (req.method === "POST" && pathname === "/api/portal/settings/display/business") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const name = String(body.name || "").trim();
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;
      if (!name) return json({ error: "Business name is required" }, 400);
      if (name.length > 120) return json({ error: "Business name is too long" }, 400);

      const biz = access.session.businessCode;
      const sandboxMode = await isSandboxBusiness(biz);
      if (sandboxMode) {
        return json({ ok: true, businessCode: biz, businessName: name, sandbox: true, simulated: true });
      }

      const cfgKey = `bizcfg:${biz}`;
      const cfg = (await env.ENROLL_TOKENS.get(cfgKey, "json")) || {};
      cfg.slug = cfg.slug || biz;
      cfg.name = name;
      await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));

      return json({ ok: true, businessCode: biz, businessName: cfg.name });
    }

    if (req.method === "POST" && pathname === "/api/portal/settings/display/building") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const buildingCode = String(body.buildingCode || "").trim();
      const name = String(body.name || "").trim();
      const access = await requirePortalAccess(req, businessCode, true);
      if (!access.ok) return access.response;
      if (!buildingCode) return json({ error: "buildingCode is required" }, 400);
      if (!name) return json({ error: "Building name is required" }, 400);
      if (name.length > 120) return json({ error: "Building name is too long" }, 400);

      const biz = access.session.businessCode;
      const sandboxMode = await isSandboxBusiness(biz);
      if (sandboxMode) {
        return json({ ok: true, businessCode: biz, buildingCode, name, sandbox: true, simulated: true });
      }

      await env.REPORTS_KV.put(
        `bldcfg:${biz}:${buildingCode}`,
        JSON.stringify({
          name,
          updatedAt: Date.now(),
          updatedBy: access.session.email || "portal-manager",
        })
      );

      return json({ ok: true, businessCode: biz, buildingCode, name });
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
      if (await isSandboxBusiness(biz)) {
        const token = crypto.randomUUID().replace(/-/g, "");
        const inviteUrl = buildPortalUrl("/portal/invite", { t: token });
        return json({ ok: true, businessCode: biz, email, role, canComment, inviteUrl, token, sandbox: true, simulated: true });
      }
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
      if (await isSandboxBusiness(biz)) {
        const canComment = normalizeCommentPermission(body.canComment, true);
        return json({ ok: true, businessCode: biz, email, canComment, sandbox: true, simulated: true });
      }
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
      if (await isSandboxBusiness(biz)) {
        return json({ ok: true, businessCode: biz, email, sandbox: true, simulated: true });
      }
      await env.ENROLL_TOKENS.delete(`portalMember:${biz}:${email}`);
      return json({ ok: true, businessCode: biz, email });
    }

    if (req.method === "POST" && pathname === "/api/portal/cta-submit") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const access = await requirePortalAccess(req, businessCode, false);
      if (!access.ok) return access.response;

      const sandboxMode = await isSandboxBusiness(access.session.businessCode);
      const result = await submitCtaRequest({
        ...body,
        businessCode: access.session.businessCode,
        requesterEmail: access.session.email || body.requesterEmail || "",
        requesterName: body.requesterName || access.session.email || "Portal user",
      }, { sandboxMode });
      return result.response;
    }

    return text("Not found", 404);
  },
};


