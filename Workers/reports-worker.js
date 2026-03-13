import {
  slug,
  normalizeEmail,
  isValidEmail,
  normalizePortalRole,
  splitEmailList,
  parseCookies as parseCookiesShared,
  getCookieValues,
  setCookie,
  readJsonBody,
} from "./shared/helpers.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;
    const hostname = String(url.hostname || "").toLowerCase();

    const rawPortalOrigin = String(env.PORTAL_ORIGIN || "").trim();
    const portalOrigin = (() => {
      const fallback = "https://castledoorict.com";
      const candidate = rawPortalOrigin
        ? (/^https?:\/\//i.test(rawPortalOrigin) ? rawPortalOrigin : `https://${rawPortalOrigin}`)
        : fallback;
      try {
        return new URL(candidate).origin;
      } catch {
        return fallback;
      }
    })();
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

    // Portal routes are owned by portal-worker.
    // If portal routes land on reports-worker, forward to canonical portal origin.
    if (isPortalPath) {
      let target;
      try {
        target = new URL(`${pathname}${url.search}`, portalOrigin);
      } catch {
        target = null;
      }
      if (target && target.origin !== url.origin) {
        console.log("[reports-portal-compat] redirect", {
          fromHost: hostname,
          toOrigin: target.origin,
          path: pathname,
          method: req.method,
        });
        const redirectStatus = req.method === "GET" || req.method === "HEAD" ? 302 : 307;
        return Response.redirect(target.toString(), redirectStatus);
      }

      // If already on canonical portal host, allow legacy compatibility
      // handlers below to continue serving during route-binding transitions.
    }

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
    const isUploadDebug = String(env.DEBUG_UPLOAD || "") === "1";
    const isStatusDebug = String(env.DEBUG_STATUS || "") === "1";
    const statusDebug = (...args) => {
      if (isStatusDebug) console.log("[reports-status-debug]", ...args);
    };

    const parseCookies = (header) => {
      const parsed = parseCookiesShared(header, { decode: false });
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!k || !v) continue;
        out[k] = v;
      }
      return out;
    };

    const normalizeCommentPermission = (value, defaultValue = true) => {
      if (typeof value === "boolean") return value;
      if (value == null) return !!defaultValue;
      const t = String(value).trim().toLowerCase();
      if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
      if (t === "false" || t === "0" || t === "no" || t === "off") return false;
      return !!defaultValue;
    };

    async function getPortalSession(env, req) {
      const cookies = parseCookies(req.headers.get("Cookie"));
      const hasAdminSession = cookies["admin_auth"] === "ok";
      if (hasAdminSession) {
        return {
          ok: true,
          superuser: true,
          role: "superuser",
          email: "admin@castledoorict.com",
          businessCode: "",
        };
      }

      const cookieHeader = req.headers.get("Cookie") || "";
      const sids = getCookieValues(cookieHeader, "castle_portal")
        .map((v) => String(v || "").trim())
        .filter(Boolean);
      if (!sids.length) return { ok: false, reason: "missing_session" };

      let sawExpired = false;
      let sawInvalidPayload = false;
      let sawInactiveMember = false;

      for (const sid of sids) {
        const session = await env.ENROLL_TOKENS.get(`portalSession:${sid}`, "json");
        if (!session || typeof session !== "object") continue;

        const now = Date.now();
        if (typeof session.expiresAt === "number" && now > session.expiresAt) {
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
          superuser: false,
          role: normalizePortalRole(member.role || "member"),
          email,
          businessCode,
          member,
        };
      }

      if (sawInactiveMember) return { ok: false, reason: "inactive_member" };
      if (sawInvalidPayload) return { ok: false, reason: "invalid_session_payload" };
      if (sawExpired) return { ok: false, reason: "expired_session" };
      return { ok: false, reason: "invalid_session" };
    }

    async function requirePortalAccess(env, req, businessCode = "", requireManager = false) {
      const sess = await getPortalSession(env, req);
      if (!sess.ok) {
        return {
          ok: false,
          response: json({ error: "Portal authentication required", reason: sess.reason || "unauthorized" }, 401),
          session: null,
        };
      }

      const targetBiz = slug(businessCode || "");
      if (sess.superuser) {
        return {
          ok: true,
          session: {
            ...sess,
            businessCode: targetBiz || sess.businessCode || "",
          },
          response: null,
        };
      }

      if (targetBiz && sess.businessCode !== targetBiz) {
        return {
          ok: false,
          response: json({ error: "Forbidden business scope" }, 403),
          session: null,
        };
      }

      if (requireManager && sess.role !== "manager") {
        return {
          ok: false,
          response: json({ error: "Manager role required" }, 403),
          session: null,
        };
      }

      return { ok: true, session: sess, response: null };
    }

    async function listBusinessDoorSummaries(kv, businessCode) {
      const biz = slug(businessCode || "");
      if (!biz) return [];

      const out = [];
      let cursor;
      do {
        const listed = await kv.list({
          prefix: `door:${biz}:`,
          cursor,
        });

        for (const k of listed.keys || []) {
          const row = await kv.get(k.name, "json");
          if (!row || typeof row !== "object") continue;
          out.push(row);
        }

        cursor = listed.cursor;
      } while (cursor);

      return out;
    }

    async function submitCtaRequest(env, ctx, req, payload) {
      const kind = (payload.kind || "").toString();
      const businessCode = (payload.businessCode || "").toString();
      const buildingCode = (payload.buildingCode || "").toString();
      const doorId = (payload.doorId || "").toString();
      const doorSlug = (payload.doorSlug || "").toString();
      const requesterName = (payload.requesterName || "").toString();
      const requesterEmail = (payload.requesterEmail || "").toString();
      const sendToOverride = (payload.sendToOverride || "").toString();
      const notes = (payload.notes || "").toString();

      const businessLabel = (payload.businessLabel || "").toString();
      const buildingLabel = (payload.buildingLabel || "").toString();
      const doorLabel = (payload.doorLabel || "").toString();
      const doorStatus = (payload.doorStatus || "").toString();

      if (!kind || !businessCode || (!doorId && !doorSlug)) {
        return { response: json({ error: "Missing required fields" }, 400), id: null };
      }

      const cfgRaw = await env.ENROLL_TOKENS.get(`bizcfg:${businessCode}`, "text");
      if (!cfgRaw) {
        return { response: json({ error: "Unknown business" }, 400), id: null };
      }

      let cfg;
      try {
        cfg = JSON.parse(cfgRaw);
      } catch {
        cfg = {};
      }

      if (!cfg.cta_enabled) {
        return { response: json({ error: "CTA disabled for this business" }, 403), id: null };
      }

      const now = Date.now();
      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      const key = `cta:${businessCode}:${id}`;

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

      const sendEmail = async () => {
        try {
          const apiKey = env.RESEND_API_KEY;
          const from = env.RESEND_FROM;
          if (!apiKey || !from) {
            console.log("Resend not configured (missing RESEND_API_KEY or RESEND_FROM)");
            return;
          }

          const primaryTo = (sendToOverride || cfg.cta_default_to || "").trim();
          const fallbackTo = (env.RESEND_FALLBACK_TO || "").trim();
          const to = [];
          if (primaryTo) to.push(primaryTo);
          else if (fallbackTo) to.push(fallbackTo);
          if (!to.length) {
            console.log("CTA request has no destination email; skipping send");
            return;
          }

          const cc = [];
          if (typeof cfg.cta_always_cc === "string" && cfg.cta_always_cc.trim()) {
            cfg.cta_always_cc.split(",").forEach((addr) => {
              const t = addr.trim();
              if (t) cc.push(t);
            });
          }
          const dispatch = String(env.CASTLE_DISPATCH_EMAIL || "").trim();
          if (dispatch && !cc.includes(dispatch)) cc.push(dispatch);

          const kindLabel =
            kind === "repair"
              ? "Repair"
              : kind === "reinspect"
                ? "Reinspection"
                : kind;

          const bizName = businessLabel || businessCode || "(unknown business)";
          const bldgName = buildingLabel || buildingCode || "(unknown building)";
          const doorName = doorLabel || doorId || doorSlug || "(unknown door)";
          const statusText = doorStatus || "";
          const subject = `[Door CTA] ${kindLabel} – ${bizName} – ${bldgName} – ${doorName}`;

          const safeNotes = notes || "(none)";
          const safeRequester = requesterName && requesterName.trim() ? requesterName.trim() : "(unknown requester)";
          const safeRequesterEmail =
            requesterEmail && requesterEmail.trim() ? requesterEmail.trim() : "(no email provided)";

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

          const htmlBody = `
          <div style="font-family: system-ui, sans-serif; color: #222; line-height: 1.45;">
            <h2 style="margin-bottom: 0.3em;">${kindLabel} Request – ${doorName}</h2>
            <div style="font-size: 14px; color: #555;">${bizName} • ${bldgName}</div>
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
            <pre style="background: #f8f8f8; padding: 10px; border-radius: 6px; white-space: pre-wrap; font-family: system-ui, sans-serif;">${safeNotes}</pre>
            ${doorUrl ? `<p style="margin-top: 1.5em;"><a href="${doorUrl}" style="display: inline-block; padding: 10px 14px; background: #2b5cff; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600;">View Full Door Report</a></p>` : ""}
            <p style="margin-top: 1.5em; font-size: 12px; color: #999;">Request ID: ${id}</p>
          </div>
          `;

          const emailPayload = { from, to, subject, html: htmlBody };
          if (cc.length) emailPayload.cc = cc;

          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(emailPayload),
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
      return { response: json({ ok: true, id }), id };
    }

    const normalizeDomain = (value = "") =>
      normalizeEmail(value).replace(/^@+/, "");

    const normalizeStringArray = (value, normalizeFn) => {
      if (!Array.isArray(value)) return [];
      const out = [];
      for (const item of value) {
        const normalized = normalizeFn(item);
        if (!normalized) continue;
        if (!out.includes(normalized)) out.push(normalized);
      }
      return out;
    };

    const sanitizeUidToken = (value = "") =>
      String(value).trim().replace(/[^\w\-./]/g, "_");

    const sanitizeOneLineText = (value = "", maxLen = 160) =>
      String(value || "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen);

    const sanitizeCommentMessage = (value = "", maxLen = 2000) =>
      String(value || "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
        .slice(0, maxLen);

    function parseBizSecurityConfig(rawCfg, businessCode) {
      const cfg = rawCfg && typeof rawCfg === "object" ? rawCfg : {};
      const whitelistDomains = normalizeStringArray(
        cfg.whitelist_domains,
        normalizeDomain
      );
      const whitelistEmails = normalizeStringArray(
        cfg.whitelist_emails,
        normalizeEmail
      );

      const mode = String(cfg.mode || "standard").toLowerCase() === "secure"
        ? "secure"
        : "standard";

      const requireWhitelist =
        typeof cfg.require_whitelist === "boolean"
          ? cfg.require_whitelist
          : whitelistDomains.length > 0 || whitelistEmails.length > 0;

      return {
        ...cfg,
        slug: String(cfg.slug || businessCode || "").trim() || businessCode,
        mode,
        whitelist_domains: whitelistDomains,
        whitelist_emails: whitelistEmails,
        require_whitelist: requireWhitelist,
      };
    }

    function parseBuildingSecurityConfig(rawCfg) {
      const cfg = rawCfg && typeof rawCfg === "object" ? rawCfg : {};
      const rawMode = String(cfg.mode || "inherit").toLowerCase();
      const mode =
        rawMode === "secure" || rawMode === "standard" || rawMode === "public"
          ? rawMode
          : "inherit";

      return {
        mode,
        whitelist_domains: normalizeStringArray(cfg.whitelist_domains, normalizeDomain),
        whitelist_emails: normalizeStringArray(cfg.whitelist_emails, normalizeEmail),
        require_whitelist:
          typeof cfg.require_whitelist === "boolean" ? cfg.require_whitelist : false,
      };
    }

    function deviceHasScope(device, businessCode, buildingCode) {
      if (!device || typeof device !== "object") return false;

      const targetBiz = slug(businessCode || "");
      const targetBld = String(buildingCode || "main").trim() || "main";

      const scopes = Array.isArray(device.scopes) ? device.scopes : [];
      for (const scope of scopes) {
        if (!scope || typeof scope !== "object") continue;
        const scopeBiz = slug(scope.businessCode || scope.biz || "");
        if (!scopeBiz || scopeBiz !== targetBiz) continue;

        const scopeType = String(scope.scope || "business").toLowerCase();
        const scopeBld = String(scope.buildingCode || "").trim();

        if (scopeType === "business") return true;
        if (scopeType === "building" && scopeBld && scopeBld === targetBld) return true;
      }

      const legacyBiz = slug(device.biz || device.businessCode || "");
      if (legacyBiz && legacyBiz === targetBiz) return true;

      return false;
    }

    function deviceMatchesWhitelist(device, effectivePolicy) {
      if (!effectivePolicy || !effectivePolicy.requireWhitelist) return true;

      const allowedEmails = Array.isArray(effectivePolicy.whitelistEmails)
        ? effectivePolicy.whitelistEmails
        : [];
      const allowedDomains = Array.isArray(effectivePolicy.whitelistDomains)
        ? effectivePolicy.whitelistDomains
        : [];

      if (!allowedEmails.length && !allowedDomains.length) return true;

      const email = normalizeEmail(
        device?.email || device?.userEmail || device?.enrolled_email || ""
      );
      const inferredDomain =
        email && email.includes("@") ? email.split("@").pop() : "";
      const domain = normalizeDomain(
        device?.emailDomain || device?.domain || inferredDomain || ""
      );

      if (email && allowedEmails.includes(email)) return true;
      if (domain && allowedDomains.includes(domain)) return true;

      return false;
    }

    async function getSecurityDecisionForDoor(env, req, businessCode, buildingCode) {
      const bizCode = slug(businessCode || "");
      const bldCode = String(buildingCode || "main").trim() || "main";

      let rawBizCfg = null;
      try {
        rawBizCfg = await env.ENROLL_TOKENS.get(`bizcfg:${bizCode}`, "json");
      } catch (e) {
        console.log("Failed loading biz security config", bizCode, e);
      }
      const bizCfg = parseBizSecurityConfig(rawBizCfg, bizCode);

      let rawBldCfg = null;
      try {
        rawBldCfg = await env.ENROLL_TOKENS.get(`bldsec:${bizCode}:${bldCode}`, "json");
      } catch (e) {
        console.log("Failed loading building security config", bizCode, bldCode, e);
      }
      const buildingCfg = parseBuildingSecurityConfig(rawBldCfg);

      const bizSecure = bizCfg.mode === "secure";
      let secureRequired = bizSecure;
      if (buildingCfg.mode === "secure") secureRequired = true;
      else if (buildingCfg.mode === "standard" || buildingCfg.mode === "public") {
        secureRequired = false;
      }

      const whitelistDomains = [
        ...bizCfg.whitelist_domains,
        ...buildingCfg.whitelist_domains,
      ].filter((v, i, a) => v && a.indexOf(v) === i);
      const whitelistEmails = [
        ...bizCfg.whitelist_emails,
        ...buildingCfg.whitelist_emails,
      ].filter((v, i, a) => v && a.indexOf(v) === i);

      const requireWhitelist =
        !!bizCfg.require_whitelist ||
        !!buildingCfg.require_whitelist ||
        whitelistDomains.length > 0 ||
        whitelistEmails.length > 0;

      const effectivePolicy = {
        secureRequired,
        requireWhitelist,
        whitelistDomains,
        whitelistEmails,
        buildingMode: buildingCfg.mode,
      };

      if (!secureRequired) {
        return {
          allowed: true,
          status: 200,
          reason: "public",
          bizCfg,
          buildingCfg,
          effectivePolicy,
          device: null,
        };
      }

      const cookies = parseCookies(req.headers.get("Cookie"));
      const tokenId = cookies["castle_access"];
      if (!tokenId) {
        return {
          allowed: false,
          status: 403,
          reason: "missing_device_cookie",
          bizCfg,
          buildingCfg,
          effectivePolicy,
          device: null,
        };
      }

      const deviceRaw = await env.DEVICE_TOKENS.get(`device:${tokenId}`, "json");
      if (!deviceRaw || typeof deviceRaw !== "object") {
        return {
          allowed: false,
          status: 403,
          reason: "invalid_device",
          bizCfg,
          buildingCfg,
          effectivePolicy,
          device: null,
        };
      }

      if (deviceRaw.revoked) {
        return {
          allowed: false,
          status: 403,
          reason: "revoked_device",
          bizCfg,
          buildingCfg,
          effectivePolicy,
          device: deviceRaw,
        };
      }

      if (!deviceHasScope(deviceRaw, bizCode, bldCode)) {
        return {
          allowed: false,
          status: 403,
          reason: "scope_mismatch",
          bizCfg,
          buildingCfg,
          effectivePolicy,
          device: deviceRaw,
        };
      }

      if (!deviceMatchesWhitelist(deviceRaw, effectivePolicy)) {
        return {
          allowed: false,
          status: 403,
          reason: "whitelist_mismatch",
          bizCfg,
          buildingCfg,
          effectivePolicy,
          device: deviceRaw,
        };
      }

      return {
        allowed: true,
        status: 200,
        reason: "ok",
        bizCfg,
        buildingCfg,
        effectivePolicy,
        device: deviceRaw,
      };
    }

    async function resolveCanonicalCommentUid(kv, uidInput) {
      const raw = String(uidInput || "").trim();
      if (!raw) return null;

      const mapping = await getDoorIndexMapping(kv, raw);
      if (!mapping) return null;

      const doorKey = `door:${mapping.businessCode}:${mapping.buildingCode}:${mapping.doorSlug}`;
      const summary = await kv.get(doorKey, "json");

      // Canonical UID should follow existing doorIndex resolution and the door summary if present.
      const canonicalUid = sanitizeUidToken(
        (summary && summary.doorId) || sanitizeUidToken(raw)
      );

      return {
        uid: canonicalUid,
        mapping,
        doorKey,
      };
    }

    async function listApprovedCommentsForUid(kv, uidInput, limitRaw = 50) {
      const limit = Number.isFinite(Number(limitRaw))
        ? Math.max(1, Math.min(Math.trunc(Number(limitRaw)), 200))
        : 50;

      const resolved = await resolveCanonicalCommentUid(kv, uidInput);
      if (!resolved) {
        return { resolved: null, comments: [] };
      }

      const approved = [];
      let cursor;
      do {
        const listed = await kv.list({
          prefix: `comment:${resolved.uid}:`,
          cursor,
        });

        for (const { name } of listed.keys || []) {
          const rec = await kv.get(name, "json");
          if (!rec || typeof rec !== "object") continue;

          const status = String(rec.status || "pending").trim().toLowerCase();
          if (status !== "approved") continue;

          approved.push({
            commentId: rec.commentId || null,
            uid: rec.uid || resolved.uid,
            message: rec.message || "",
            requesterName: rec.requesterName || null,
            requesterEmail: rec.requesterEmail || null,
            createdAt: rec.createdAt || null,
            status: rec.status || "approved",
            source: rec.source || "public",
          });

          if (approved.length >= limit) break;
        }

        cursor = listed.cursor;
      } while (cursor && approved.length < limit);

      approved.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

      return {
        resolved,
        comments: approved,
      };
    }

    const buildCanonicalReportPath = (mapping = {}) =>
      `/reports/${encodeURIComponent(mapping.businessCode || "")}/${encodeURIComponent(
        mapping.buildingCode || ""
      )}/${encodeURIComponent(mapping.doorSlug || "")}`;

    async function getDoorIndexMapping(kv, token) {
      const raw = String(token || "").trim();
      if (!raw) return null;

      const normalized = sanitizeUidToken(raw);
      const primary = await kv.get(`doorIndex:${normalized}`, "json");
      if (primary && primary.businessCode && primary.buildingCode && primary.doorSlug) {
        return primary;
      }

      // Legacy compatibility: some historical keys may have been written unsanitized.
      if (normalized !== raw) {
        const legacy = await kv.get(`doorIndex:${raw}`, "json");
        if (legacy && legacy.businessCode && legacy.buildingCode && legacy.doorSlug) {
          return legacy;
        }
      }

      return null;
    }

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

    const parseUploadFieldsFromBaseName = (baseName = "") => {
      let business = "";
      let triRaw = "";
      let building = "";
      let doorLabel = "";
      let barcodeUid = "";
      let submittedAt = "";
      let doorStatusRaw = "";
      let constructionCompany = "";

      let parts = String(baseName || "").split("|").map((p) => p.trim());
      if (parts.length >= 8) {
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
        const uParts = String(baseName || "").split("_").map((p) => p.trim());

        if (uParts.length >= 8) {
          business = uParts[0];
          doorStatusRaw = uParts[1];
          building = uParts[2];
          doorLabel = uParts[3];
          barcodeUid = (uParts[4] || "").trim();
          constructionCompany = uParts[5];

          const datePart = uParts[6];
          const timePart = uParts.slice(7).join(" ");
          submittedAt = `${datePart} ${timePart}`.trim();

          if (barcodeUid) {
            const tokens = barcodeUid.split(" ").filter(Boolean);
            if (
              tokens.length > 1 &&
              /^(true|false)$/i.test(tokens[tokens.length - 1])
            ) {
              tokens.pop();
              barcodeUid = tokens.join(" ");
            }
          }
        } else if (uParts.length === 7) {
          business = uParts[0];
          doorStatusRaw = uParts[1];
          building = "";
          doorLabel = uParts[2];
          barcodeUid = (uParts[3] || "").trim();
          constructionCompany = uParts[4];

          const datePart = uParts[5];
          const timePart = uParts.slice(6).join(" ");
          submittedAt = `${datePart} ${timePart}`.trim();
        } else if (uParts.length >= 5) {
          business = uParts[0];
          triRaw = uParts[1];
          building = uParts[2];
          doorLabel = uParts[3];
          barcodeUid = (uParts[4] || "").trim();
          if (uParts.length > 5) submittedAt = uParts.slice(5).join(" ");
        } else {
          business = baseName;
          triRaw = "0";
          building = "";
          doorLabel = baseName;
          barcodeUid = baseName;
        }
      }

      let status = "";
      if (doorStatusRaw) {
        const v = doorStatusRaw.trim().toLowerCase();
        if (v === "pass") status = "Pass";
        else if (v === "conditional pass") status = "Conditional Pass";
        else if (v === "fail" || v === "flagged") status = "Fail";
        else status = doorStatusRaw.trim();
      } else if (triRaw === "1") {
        status = "Fail";
      } else if (triRaw === "0") {
        status = "Pass";
      }

      const normalizedUid = (barcodeUid || "").trim();
      const normalizedUidLower = normalizedUid.toLowerCase();
      const hasRealUid =
        normalizedUid !== "" &&
        normalizedUidLower !== "true" &&
        normalizedUidLower !== "false";

      const doorIdRaw =
        (hasRealUid ? normalizedUid : "") ||
        [business, building, doorLabel].filter(Boolean).join(" | ") ||
        baseName;

      const doorId = String(doorIdRaw || "").trim();
      const inspectedAt = submittedAt || isoNow();

      return {
        business,
        triRaw,
        building: (building || "").toString().trim(),
        doorLabel,
        barcodeUid,
        submittedAt,
        doorStatusRaw,
        constructionCompany,
        status,
        doorId,
        inspectedAt,
      };
    };

    const requireAdminCookie = () => {
      const cookies = parseCookies(req.headers.get("Cookie"));
      if (cookies["admin_auth"] === "ok") return null;
      const adminBase = String(env.ADMIN_UI_ORIGIN || "https://admin.castledoorict.com").trim();
      const loginUrl = new URL("/admin/login", adminBase);
      loginUrl.searchParams.set("return", req.url);
      return Response.redirect(loginUrl.toString(), 302);
    };

    const mapUidHistoryToCustomerObjects = (uidHistory = []) => {
      if (!Array.isArray(uidHistory)) return [];
      const out = [];

      for (const ev of uidHistory) {
        if (!ev || typeof ev !== "object") continue;

        const customerKey = ev?.pdfs?.customer?.objectKey;
        if (customerKey) {
          out.push({
            key: customerKey,
            customMetadata: {
              doorId: ev.doorId || ev.uid || "",
              displayLabel: ev.displayLabel || ev.doorLabel || ev.uid || "",
              business: ev.business || "",
              building: ev.building || "",
              status: ev.status || "",
              inspectedAt: ev.inspectedAt || "",
              uploadedAt: ev.uploadedAt || "",
              businessCode: ev.businessCode || "",
              buildingCode: ev.buildingCode || "",
              role: "customer",
            },
          });
          continue;
        }

        if (ev.key || ev.objectKey) {
          out.push(ev);
        }
      }

      return out.slice().sort((a, b) => {
        const aKey = String((a && (a.key || a.objectKey)) || "");
        const bKey = String((b && (b.key || b.objectKey)) || "");
        return bKey.localeCompare(aKey);
      });
    };

    const mapUidHistoryToAdminObjects = (uidHistory = []) => {
      if (!Array.isArray(uidHistory)) return [];
      const out = [];

      for (const ev of uidHistory) {
        if (!ev || typeof ev !== "object") continue;
        const adminKey = ev?.pdfs?.admin?.objectKey;
        if (!adminKey) continue;
        out.push({
          key: adminKey,
          inspectedAt: ev.inspectedAt || "",
          uploadedAt: ev.uploadedAt || "",
          status: ev.status || "",
        });
      }

      return out.slice().sort((a, b) => {
        const aTs = String(a.inspectedAt || a.uploadedAt || a.key || "");
        const bTs = String(b.inspectedAt || b.uploadedAt || b.key || "");
        return bTs.localeCompare(aTs);
      });
    };

    async function upsertUidEventPdf(kv, uid, payload) {
      const safeUid = sanitizeUidToken(uid);
      const role = payload && payload.role === "admin" ? "admin" : "customer";
      const key = `uidEvents:${safeUid}`;
      let events = await kv.get(key, "json");
      if (!Array.isArray(events)) events = [];

      const inspectedAt = String(payload?.inspectedAt || "").trim();
      const eventMatch = events.find(
        (ev) =>
          ev &&
          typeof ev === "object" &&
          String(ev.inspectedAt || "").trim() === inspectedAt
      );

      const now = String(payload?.uploadedAt || isoNow());
      const event = eventMatch || {
        eventId: `evt_${crypto.randomUUID()}`,
        uid: safeUid,
        doorId: payload?.doorId || safeUid,
        displayLabel: payload?.displayLabel || payload?.doorId || safeUid,
        business: payload?.business || "",
        building: payload?.building || "",
        businessCode: payload?.businessCode || "",
        buildingCode: payload?.buildingCode || "",
        status: payload?.status || "",
        inspectedAt: inspectedAt || now,
        uploadedAt: now,
        pdfs: {},
      };

      if (!event.pdfs || typeof event.pdfs !== "object") event.pdfs = {};
      event.business = payload?.business || event.business || "";
      event.building = payload?.building || event.building || "";
      event.businessCode = payload?.businessCode || event.businessCode || "";
      event.buildingCode = payload?.buildingCode || event.buildingCode || "";
      event.status = payload?.status || event.status || "";
      event.displayLabel = payload?.displayLabel || event.displayLabel || safeUid;
      event.doorId = payload?.doorId || event.doorId || safeUid;
      event.uploadedAt = now;

      event.pdfs[role] = {
        objectKey: payload?.objectKey || "",
        sourceFileName: payload?.sourceFileName || "",
        uploadedAt: now,
      };

      if (!eventMatch) events.push(event);

      events.sort((a, b) => {
        const aTs = String((a && (a.inspectedAt || a.uploadedAt)) || "");
        const bTs = String((b && (b.inspectedAt || b.uploadedAt)) || "");
        return bTs.localeCompare(aTs);
      });

      if (events.length > 300) events = events.slice(0, 300);
      await kv.put(key, JSON.stringify(events));
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

      const biz = slug(parts[2]);
      const buildingCode = String(url.searchParams.get("building") || "").trim();
      const scope = buildingCode ? "building" : "business";

      // Simple admin auth using ?k=... query
      const providedKey = url.searchParams.get("k");
      if (!providedKey || providedKey !== env.ADMIN_KEY) {
        return text("Forbidden", 403);
      }

      const allowedEmail = normalizeEmail(url.searchParams.get("email") || "");
      const allowedDomain = normalizeDomain(url.searchParams.get("domain") || "");

      const maxUsesRaw = Number(url.searchParams.get("maxUses"));
      const maxUses = Number.isFinite(maxUsesRaw) && maxUsesRaw > 0
        ? Math.min(Math.trunc(maxUsesRaw), 5000)
        : 50;

      const expiresHoursRaw = Number(url.searchParams.get("expiresHours"));
      const expiresMs =
        Number.isFinite(expiresHoursRaw) && expiresHoursRaw > 0
          ? Math.min(Math.trunc(expiresHoursRaw), 24 * 30) * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;

      // Generate a random enrollment token
      const enrollToken = crypto.randomUUID().replace(/-/g, "");
      const enrollKey = `enroll:${enrollToken}`;

      const now = Date.now();
      const data = {
        biz,              // which business code this token is for
        scope,
        buildingCode: buildingCode || null,
        max_uses: maxUses,
        uses: 0,
        expires_at: now + expiresMs,
        created_at: now,
        allowed_email: allowedEmail || null,
        allowed_domain: allowedDomain || null,
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

      const biz = slug(parts[1]);
      const enrollToken = url.searchParams.get("t");
      if (!enrollToken) {
        return text("Missing enrollment token", 400);
      }

      const requesterEmail = normalizeEmail(url.searchParams.get("email") || "");
      const requesterDomain = normalizeDomain(
        url.searchParams.get("domain") ||
          (requesterEmail.includes("@") ? requesterEmail.split("@").pop() : "")
      );

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
      if (slug(data.biz || "") !== biz) {
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

      const tokenAllowedEmail = normalizeEmail(data.allowed_email || "");
      const tokenAllowedDomain = normalizeDomain(data.allowed_domain || "");
      if (tokenAllowedEmail && requesterEmail !== tokenAllowedEmail) {
        return text("Enrollment token restricted to a specific email", 403);
      }
      if (tokenAllowedDomain && requesterDomain !== tokenAllowedDomain) {
        return text("Enrollment token restricted to a specific email domain", 403);
      }

      const scope = String(data.scope || "business").toLowerCase() === "building"
        ? "building"
        : "business";
      const scopeBuildingCode =
        scope === "building" ? String(data.buildingCode || "").trim() : "";

      if (scope === "building" && !scopeBuildingCode) {
        return text("Enrollment token missing building scope", 403);
      }

      // Create device token (per-device ID)
      const deviceTokenId = "dev_" + crypto.randomUUID().replace(/-/g, "");
      const deviceKey = `device:${deviceTokenId}`;

      const deviceRecord = {
        id: deviceTokenId,
        biz,
        businessCode: biz,
        scopes: [
          {
            scope,
            businessCode: biz,
            buildingCode: scope === "building" ? scopeBuildingCode : null,
          },
        ],
        email: requesterEmail || null,
        emailDomain: requesterDomain || null,
        created_at: now,
        revoked: false,
        enrolled_via: {
          token: enrollToken,
          scope,
          buildingCode: scopeBuildingCode || null,
        },
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

      // 1) Pick the FIRST file in the form as the report PDF (single pass)
      let file = null;
      const debugKeys = isUploadDebug ? [] : null;
      for (const [name, value] of form.entries()) {
        if (debugKeys) {
          debugKeys.push(`${name}${value instanceof File ? " (file)" : ""}`);
        }
        if (value instanceof File) {
          file = value;
          break;
        }
      }
      if (debugKeys) console.log("Form keys:", debugKeys.join(", "));
      if (!file) return text("Missing file in upload (no file parts found)", 400);

      // 2) Parse metadata from the file name.
      const rawName = decodeMimeFilename(file.name || "");
      if (isUploadDebug) console.log("Raw file name:", rawName);

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
      if (isUploadDebug) console.log("Pipe-split parts:", parts);

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
        if (isUploadDebug) console.log("Underscore-split parts:", uParts);

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
          if (isUploadDebug) console.log("Filename did not match expected formats, falling back", {
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
      const safeDoor = sanitizeUidToken(doorId);
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
          role: "customer",
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

      await upsertUidEventPdf(env.REPORTS_KV, safeDoor, {
        role: "customer",
        objectKey,
        sourceFileName: rawName,
        doorId,
        displayLabel,
        business,
        building,
        businessCode,
        buildingCode,
        status,
        inspectedAt,
        uploadedAt: ts,
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

        // security defaults (backward-compatible)
        if (!Array.isArray(cfg.whitelist_domains)) cfg.whitelist_domains = [];
        if (!Array.isArray(cfg.whitelist_emails)) cfg.whitelist_emails = [];
        if (typeof cfg.require_whitelist !== "boolean") {
          cfg.require_whitelist = false;
        }

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
    //  POST /upload-admin-pdf  (FastField side-load admin PDF)
    // =====================================================================
    if (req.method === "POST" && pathname === "/upload-admin-pdf") {
      const apiKey = req.headers.get("x-api-key");
      const expectedAdminKey = String(env.ADMIN_UPLOAD_KEY || "").trim();
      const expectedFallback = String(env.API_KEY || "").trim();
      const expected = expectedAdminKey || expectedFallback;

      if (!apiKey || !expected || apiKey !== expected) {
        return text("Unauthorized", 401);
      }

      const ctype = req.headers.get("content-type") || "";
      if (!ctype.includes("multipart/form-data")) {
        return text("Expected multipart/form-data", 400);
      }

      const form = await req.formData();
      let file = null;
      for (const [, value] of form.entries()) {
        if (value instanceof File) {
          file = value;
          break;
        }
      }
      if (!file) return text("Missing file in upload", 400);

      const rawName = decodeMimeFilename(file.name || "");
      const isPdfByName = /\.pdf$/i.test(rawName || "");
      const isPdfByType = String(file.type || "").toLowerCase().includes("pdf");
      if (!isPdfByName && !isPdfByType) {
        return text("Admin side-load must be a PDF", 400);
      }

      const baseName = rawName.replace(/\.[^.]+$/, "").trim();
      const parsed = parseUploadFieldsFromBaseName(baseName);

      if (!parsed.doorId) {
        return text("Missing door identifier (UID)", 400);
      }

      const safeDoor = sanitizeUidToken(parsed.doorId);
      const ts = isoNow();
      const fileName = `${ts}.pdf`;
      const objectKey = `${safeDoor}/admin/${fileName}`;

      let businessCode = "";
      let buildingCode = "";
      let doorSlug = "";
      let business = parsed.business || "";
      let building = parsed.building || "";
      let displayLabel = parsed.doorLabel || parsed.doorId;

      const mapping = await getDoorIndexMapping(env.REPORTS_KV, safeDoor);
      if (mapping) {
        businessCode = mapping.businessCode;
        buildingCode = mapping.buildingCode;
        doorSlug = mapping.doorSlug;

        const summaryKey = `door:${businessCode}:${buildingCode}:${doorSlug}`;
        const summary = await env.REPORTS_KV.get(summaryKey, "json");
        if (summary && typeof summary === "object") {
          business = summary.business || business;
          building = summary.building || building;
          displayLabel = summary.displayLabel || displayLabel;
        }
      } else {
        const buildingForCode = building || "main";
        businessCode = await getOrCreateBusinessCode(env.REPORTS_KV, business || "unknown");
        buildingCode = await getOrCreateBuildingCode(
          env.REPORTS_KV,
          businessCode,
          buildingForCode
        );
        doorSlug = slug(parsed.doorLabel || parsed.doorId);
      }

      await env.REPORTS_BUCKET.put(objectKey, await file.arrayBuffer(), {
        httpMetadata: {
          contentType: "application/pdf",
          contentDisposition: `inline; filename="${rawName || fileName}"`,
        },
        customMetadata: {
          role: "admin",
          uid: safeDoor,
          doorId: parsed.doorId,
          business,
          building,
          displayLabel,
          status: parsed.status || "",
          inspectedAt: parsed.inspectedAt,
          uploadedAt: ts,
          sourceFileName: rawName,
          businessCode,
          buildingCode,
          doorSlug,
        },
      });

      await upsertUidEventPdf(env.REPORTS_KV, safeDoor, {
        role: "admin",
        objectKey,
        sourceFileName: rawName,
        doorId: parsed.doorId,
        displayLabel,
        business,
        building,
        businessCode,
        buildingCode,
        status: parsed.status || "",
        inspectedAt: parsed.inspectedAt,
        uploadedAt: ts,
      });

      return json(
        {
          ok: true,
          uid: safeDoor,
          role: "admin",
          object_key: objectKey,
          admin_report_url: `/admin/reports/${encodeURIComponent(safeDoor)}`,
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

      const role = String((obj.customMetadata && obj.customMetadata.role) || "").toLowerCase();
      if (role === "admin" || key.includes("/admin/")) {
        return text("File not found", 404);
      }

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
    //  GET /admin/file/:uid/:fileName  (admin-only admin PDF serving)
    // =====================================================================
    if (req.method === "GET" && pathname.startsWith("/admin/file/")) {
      const authErr = requireAdminCookie();
      if (authErr) return authErr;

      const parts = pathname.split("/").filter(Boolean); // ["admin", "file", ":uid", ":fileName"]
      if (parts.length !== 4) return text("Not Found", 404);

      const uid = sanitizeUidToken(decodeURIComponent(parts[2] || ""));
      const fileName = decodeURIComponent(parts[3] || "");
      const key = `${uid}/admin/${fileName}`;
      const obj = await env.REPORTS_BUCKET.get(key);
      if (!obj) return text("File not found", 404);

      const role = String((obj.customMetadata && obj.customMetadata.role) || "").toLowerCase();
      if (role && role !== "admin") return text("Not Found", 404);

      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "application/pdf",
          "content-disposition":
            obj.httpMetadata?.contentDisposition || `inline; filename="${fileName}"`,
          "cache-control": "private, max-age=0, no-store",
        },
      });
    }

    // =====================================================================
    //  GET /admin/pdfviewer/:uid/:fileName  (admin-only PDF wrapper)
    // =====================================================================
    if (req.method === "GET" && pathname.startsWith("/admin/pdfviewer/")) {
      const authErr = requireAdminCookie();
      if (authErr) return authErr;

      const parts = pathname.split("/").filter(Boolean); // ["admin", "pdfviewer", ":uid", ":fileName"]
      if (parts.length !== 4) return text("Not Found", 404);

      const uid = sanitizeUidToken(decodeURIComponent(parts[2] || ""));
      const fileName = decodeURIComponent(parts[3] || "");
      const filePath = `/admin/file/${encodeURIComponent(uid)}/${encodeURIComponent(fileName)}`;

      return html(`<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Admin report</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin:0; padding:0; height:100%; background:#111827; }
      iframe { width:100%; height:100%; border:none; background:#fff; }
    </style>
  </head>
  <body>
    <iframe src="${filePath}" title="Admin report PDF"></iframe>
  </body>
  </html>`);
    }

    // =====================================================================
    //  GET /admin/reports/:uid  (admin-only page with customer + admin PDFs)
    // =====================================================================
    if (req.method === "GET" && pathname.startsWith("/admin/reports/")) {
      const authErr = requireAdminCookie();
      if (authErr) return authErr;

      const parts = pathname.split("/").filter(Boolean); // ["admin", "reports", ":uid"]
      if (parts.length !== 3) return text("Not Found", 404);

      const uid = sanitizeUidToken(decodeURIComponent(parts[2] || ""));
      if (!uid) return text("UID is required", 400);

      const mapping = await getDoorIndexMapping(env.REPORTS_KV, uid);
      const basePath = mapping
        ? buildCanonicalReportPath(mapping)
        : `/reports/${encodeURIComponent(uid)}`;
      const joiner = basePath.includes("?") ? "&" : "?";
      return Response.redirect(`${url.origin}${basePath}${joiner}viewer=admin`, 302);
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

        const mapping = await getDoorIndexMapping(env.REPORTS_KV, token);
        const redirectPath = mapping
          ? buildCanonicalReportPath(mapping)
          : `/reports/${encodeURIComponent(token)}`;
        const redirectUrl = `${url.origin}${redirectPath}`;

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
      const requestedViewer = String(url.searchParams.get("viewer") || "").toLowerCase();
      const reportCookies = parseCookies(req.headers.get("Cookie"));
      const hasAdminSession = reportCookies["admin_auth"] === "ok";

      let isAdminViewer = false;
      if (requestedViewer === "admin") {
        if (!hasAdminSession) {
          const adminViewerAuthErr = requireAdminCookie();
          if (adminViewerAuthErr) return adminViewerAuthErr;
        }
        isAdminViewer = true;
      }

      const viewerParam = isAdminViewer ? "admin" : "";
      const appendViewerToPath = (path, preserveScopeAll = false, forceScopeAll = false) => {
        const p = new URLSearchParams();
        if (forceScopeAll || (preserveScopeAll && scopeAll)) p.set("scope", "all");
        if (viewerParam) p.set("viewer", viewerParam);
        const qs = p.toString();
        return qs ? `${path}?${qs}` : path;
      };

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
        doorId = summary.doorId;
        business = summary.business || "";
        building = summary.building || "";

        // Canonical redirect via doorIndex:<UID>
        if (summary && summary.doorId) {
          const map = await getDoorIndexMapping(env.REPORTS_KV, summary.doorId);

          if (map) {
            const canonicalPath = buildCanonicalReportPath(map);
            const canonical = canonicalPath + (url.search || "");

            if (url.pathname !== canonicalPath) {
              const canonicalUrl = `${url.origin}${canonical}`;
              return Response.redirect(canonicalUrl, 302);
            }
          }
        }
      }

      // Shape B (legacy): /reports/:doorId
      else if (parts.length === 2) {
        const token = decodeURIComponent(parts[1]);
        doorId = token;

        // Canonical redirect via doorIndex:<UID>
        const map = await getDoorIndexMapping(env.REPORTS_KV, doorId);

        if (map) {
          const canonical = buildCanonicalReportPath(map) + (url.search || "");
          const canonicalUrl = `${url.origin}${canonical}`;
          return Response.redirect(canonicalUrl, 302);
        }

        // If no mapping, continue legacy rendering (R2 metadata)
      }

      else {
        return text("Not found", 404);
      }


      // Use sanitized doorId as folder prefix in R2
      const safeDoor = sanitizeUidToken(doorId);

      let uidHistory = null;
      // If we didn't get a door record from Shape A, try UID-first record.
      // Upload path writes this as door:${safeDoor}.
      try {
        const [doorRecFallback, rawUidEvents] = await Promise.all([
          !doorRec ? env.REPORTS_KV.get(`door:${safeDoor}`, "json") : Promise.resolve(null),
          env.REPORTS_KV.get(`uidEvents:${safeDoor}`, "json"),
        ]);

        if (!doorRec && doorRecFallback) {
          doorRec = doorRecFallback;
        }

        if (Array.isArray(rawUidEvents) && rawUidEvents.length > 0) {
          uidHistory = rawUidEvents;
        }
      } catch { }

      let objects = [];

      if (uidHistory) {
        // UID-first history
        objects = isAdminViewer
          ? mapUidHistoryToAdminObjects(uidHistory)
          : mapUidHistoryToCustomerObjects(uidHistory);
      } else {
        // Legacy fallback
        const list = await env.REPORTS_BUCKET.list({
          prefix: isAdminViewer ? `${safeDoor}/admin/` : `${safeDoor}/`,
        });

        objects = (list.objects || [])
          .filter((o) => {
            const role = String((o?.customMetadata && o.customMetadata.role) || "").toLowerCase();
            if (isAdminViewer) return role === "admin" || String(o?.key || "").includes("/admin/");
            return role !== "admin" && !String(o?.key || "").includes("/admin/");
          })
          .slice()
          .sort((a, b) => b.key.localeCompare(a.key));
      }


      if (objects.length === 0) {
        const kind = isAdminViewer ? "admin reports" : "reports";
        return html(`<h1>No ${kind} yet for ${esc(doorId)}</h1>`);
      }

      const latest = objects[0];
      const meta = latest.customMetadata || latest || {};
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

      const deriveDisplayStatus = (statusRaw, severityRaw) => {
        const normalized = normalizeDisplayStatus(statusRaw);
        if (normalized) return normalized;

        const sev =
          severityRaw !== null && severityRaw !== undefined && String(severityRaw).trim() !== ""
            ? Number(severityRaw)
            : null;

        if (sev === null || Number.isNaN(sev)) return "";
        if (sev >= 2) return "Flagged";
        if (sev === 1) return "Conditional Pass";
        if (sev === 0) return "Pass";
        return "";
      };

      // Admin override wins (if present), otherwise metadata wins
      let effectiveStatus =
        deriveDisplayStatus(adminStatusRaw, adminSeverityNum) ||
        deriveDisplayStatus(metaStatus, metaSeverityNum);

      statusDebug("/reports effective-status", {
        path: pathname,
        query: url.search,
        safeDoor,
        isAdminViewer,
        doorId: doorRec && doorRec.doorId ? String(doorRec.doorId) : String(doorId || ""),
        mapping: {
          businessCode,
          buildingCode,
          doorSlug,
        },
        adminStatusRaw,
        adminSeverityRaw,
        adminSeverityNum,
        metaStatus,
        metaSeverityNum,
        effectiveStatus,
      });

      // Customer-visible admin comments (opt-in only)
      const visibleAdminComments =
        doorRec && Array.isArray(doorRec.eventHistory)
          ? doorRec.eventHistory
            .filter((ev) => {
              if (!ev || typeof ev !== "object") return false;
              const type = String(ev.type || "").trim();
              const notes = String(ev.notes || "").trim();
              const visible = ev.visibleToCustomer === true;
              const allowedType = type === "admin_note" || type === "admin_override";
              return visible && allowedType && !!notes;
            })
            .map((ev) => {
              const isoTs = String(ev.timestamp || "").trim();
              let displayTs = isoTs;
              if (isoTs) {
                const d = new Date(isoTs);
                if (!Number.isNaN(d.getTime())) {
                  try {
                    displayTs = d.toLocaleString("en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    });
                  } catch {
                    displayTs = isoTs;
                  }
                }
              }

              return {
                timestamp: displayTs || "",
                notes: String(ev.notes || "").trim(),
              };
            })
          : [];

      const adminCommentsHeaderIndicatorHtml = visibleAdminComments.length
        ? `<button
            type="button"
            class="btn btn-small open-admin-comments viewer-admin-notes-indicator"
            title="View admin comments"
            aria-label="View admin comments"
          >
            Admin notes (${visibleAdminComments.length})
          </button>`
        : "";

      const adminCommentsModalHtml = visibleAdminComments.length
        ? `
  <div class="overlay" id="admin-comments-overlay" style="display:none;">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Admin comments">
      <div class="modal-head">
        <strong>Admin Comments</strong>
        <button type="button" class="btn btn-small" id="admin-comments-close">Close</button>
      </div>
      <div class="modal-body">
        ${visibleAdminComments
          .map(
            (c) => `
              <div class="admin-comment-item">
                <div class="admin-comment-time">${esc(c.timestamp || "")}</div>
                <div class="admin-comment-note">${esc(c.notes || "")}</div>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
  </div>
`
        : "";

      // If business/building not filled yet (legacy path), use metadata
      if (!business) business = meta.business || "";
      if (!building) building = meta.building || "";

      const latestFile = latest.key
        ? latest.key.split("/").pop()
        : latest.objectKey.split("/").pop();

      const latestUrl = `/file/${encodeURIComponent(
        safeDoor
      )}/${encodeURIComponent(latestFile)}`;
      const viewerUrl = isAdminViewer
        ? `/admin/pdfviewer/${encodeURIComponent(safeDoor)}/${encodeURIComponent(latestFile)}`
        : `/pdfviewer/${encodeURIComponent(safeDoor)}/${encodeURIComponent(latestFile)}`;

      // Build History list for the sidebar (newest → oldest)
      const historyItemsHtml = objects
        .map((o, idx) => {
          const m = o.customMetadata || o || {};
          const file = o.key
            ? o.key.split("/").pop()
            : o.objectKey.split("/").pop();


          const viewUrl = isAdminViewer
            ? `/admin/pdfviewer/${encodeURIComponent(safeDoor)}/${encodeURIComponent(file)}`
            : `/pdfviewer/${encodeURIComponent(safeDoor)}/${encodeURIComponent(file)}`;
          const dlUrl = isAdminViewer
            ? `/admin/file/${encodeURIComponent(safeDoor)}/${encodeURIComponent(file)}`
            : `/file/${encodeURIComponent(safeDoor)}/${encodeURIComponent(file)}`;

          const when = m.inspectedAt || m.uploadedAt || file.replace(/\.pdf$/i, "");

          const doorLabel = (m.displayLabel || m.label || m.doorId || "").toString().trim();

          const statusTextRaw = (m.status || m.doorStatusRaw || "").toString().trim();
          const normalizedHistoryStatus = deriveDisplayStatus(statusTextRaw, m.severity);
          const statusText = normalizedHistoryStatus || (idx === 0 ? effectiveStatus : "") || "Unknown";

          // “actual condition” (best available from metadata)
          let conditionText = "";
          if (typeof m.severity !== "undefined" && m.severity !== null && String(m.severity).trim() !== "") {
            const sevNum = Number(m.severity);
            if (!Number.isNaN(sevNum)) {
              if (sevNum >= 2) conditionText = "Flagged";
              else if (sevNum === 1) conditionText = "Conditional Pass";
              else if (sevNum === 0) conditionText = "Pass";
            }
          }

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

      // ---------- Unified security gate + biz CTA config ----------
      let bizCtaEnabled = false;
      let bizCtaDefaultTo = "";
      let bizCtaAlwaysCc = "";

      const securityDecision = await getSecurityDecisionForDoor(
        env,
        req,
        businessCode,
        buildingCode
      );

      const bizCfgForUi = securityDecision.bizCfg || {};
      bizCtaEnabled = !!bizCfgForUi.cta_enabled;
      bizCtaDefaultTo =
        typeof bizCfgForUi.cta_default_to === "string"
          ? bizCfgForUi.cta_default_to
          : "";
      bizCtaAlwaysCc =
        typeof bizCfgForUi.cta_always_cc === "string"
          ? bizCfgForUi.cta_always_cc
          : "";

      if (!securityDecision.allowed) {
        const reasonMap = {
          missing_device_cookie:
            "This location requires an enrolled device. Ask your administrator for an access link.",
          invalid_device: "Invalid device token.",
          revoked_device: "This device token has been revoked.",
          scope_mismatch:
            "This enrolled device is not authorized for this business/building scope.",
          whitelist_mismatch:
            "This device identity is not in the approved whitelist for this secure location.",
        };

        const message =
          reasonMap[securityDecision.reason] ||
          "Access is restricted for this location.";

        const restrictedHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Access restricted</title>
  </head>
  <body>
    <h1>Access restricted</h1>
    <p>${esc(message)}</p>
    <p>If you should have access, please contact your administrator or maintenance manager.</p>
  </body>
</html>`;

        return html(restrictedHtml, securityDecision.status || 403);
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
        effectiveStatus && `Status: ${esc(effectiveStatus)}`,
        `Viewer: ${isAdminViewer ? "Admin report" : "Customer report"}`,
      ]
        .filter(Boolean)
        .join(" • ");

      const viewerQueryCustomer = (() => {
        const p = new URLSearchParams(url.searchParams);
        p.delete("viewer");
        const s = p.toString();
        return s ? `?${s}` : "";
      })();
      const viewerQueryAdmin = (() => {
        const p = new URLSearchParams(url.searchParams);
        p.set("viewer", "admin");
        const s = p.toString();
        return s ? `?${s}` : "?viewer=admin";
      })();

      const currentViewerBasePath = `/reports/${encodeURIComponent(
        businessCode
      )}/${encodeURIComponent(buildingCode)}/${encodeURIComponent(
        doorSlug || slug(String(doorId || ""))
      )}`;

      const viewerToggleHtml = hasAdminSession ? `
        <a class="btn btn-small ${isAdminViewer ? "" : "btn-primary"}" href="${currentViewerBasePath}${viewerQueryCustomer}">Customer report</a>
        <a class="btn btn-small ${isAdminViewer ? "btn-primary" : ""}" href="${currentViewerBasePath}${viewerQueryAdmin}">Admin report</a>
      ` : "";

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
          const statusNorm = normalizeDisplayStatus(d.status || "").toLowerCase();

          const slugForDoor = d.doorSlug || slug(String(d.doorId || ""));

          if (!firstAnySlug) {
            firstAnySlug = slugForDoor;
          }

          // Severity is deprecated: use STATUS only
          const isFlagged =
            (statusNorm === "fail") ||
            (statusNorm === "flagged") ||
            (statusNorm === "needs repair");

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
              href = appendViewerToPath(
                "/reports/" +
                encodeURIComponent(businessCode) +
                "/" +
                encodeURIComponent(b.code) +
                "/" +
                encodeURIComponent(b.targetSlug)
              );
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

        let status = normalizeDisplayStatus(d.status || "");
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

        const url = appendViewerToPath(
          `/reports/${encodeURIComponent(
            thisBizCode
          )}/${encodeURIComponent(thisBldCode)}/${encodeURIComponent(
            targetSlug
          )}`,
          true
        );

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

        if (isStatusDebug && isCurrent) {
          statusDebug("/reports sidebar-current-door", {
            safeDoor,
            currentSlug,
            targetSlug,
            doorId: String(d.doorId || ""),
            statusRaw: d.status || "",
            normalizedStatus: status,
            severityRaw: d.severity ?? null,
            normalizedSeverity: sev,
            businessCode: thisBizCode,
            buildingCode: thisBldCode,
            doorKey,
          });
        }

        if (
          sev >= 2 ||
          statusNorm === "fail" ||
          statusNorm === "flagged" ||
          statusNorm === "needs repair"
        ) {
          if (isCurrent) currentInFlagged = true;
          flaggedDoors.push(entry);
        } else if (sev === 1 || statusNorm === "conditional pass" || statusNorm === "conditional") {
          if (isCurrent) currentInConditional = true;
          conditionalDoors.push(entry);
        } else if (sev === 0 || statusNorm === "pass") {
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

            const searchAttr =
              ' data-search="' +
              esc((String(d.label || "") + " " + String(d.status || "")).toLowerCase()) +
              '"';

            return (
              '<li class="door-item' +
              currentClass +
              '"' +
              fileUrlAttr +
              doorIdAttr +
              doorKeyAttr +
              statusAttr +
              searchAttr +
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
            --bg: ${isAdminViewer ? "#0b1220" : "#f5f5f7"};
            --panel: ${isAdminViewer ? "#111827" : "#ffffff"};
            --border: ${isAdminViewer ? "#243043" : "#e5e7eb"};
            --accent: ${isAdminViewer ? "#7c3aed" : "#2563eb"};
            --accent-soft: ${isAdminViewer ? "#2b1d4a" : "#dbeafe"};
            --text-main: ${isAdminViewer ? "#e5e7eb" : "#111827"};
            --text-muted: ${isAdminViewer ? "#9ca3af" : "#6b7280"};
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
            background: ${isAdminViewer ? "#1f2937" : "#f9fafb"};
          }
          .btn-primary:hover {
            background: ${isAdminViewer ? "#6d28d9" : "#1d4ed8"};
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
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            flex-wrap: wrap;
            font-size: 0.75rem;
            color: var(--text-muted);
          }

          .viewer-admin-notes-indicator {
            margin-left: 0;
            white-space: nowrap;
            flex-shrink: 0;
          }

          .viewer-meta-actions {
            margin-left: auto;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            flex-wrap: wrap;
          }

          .viewer-meta-label {
            min-width: 0;
          }

          .customer-comments {
            border: 1px solid var(--border);
            border-radius: 0.75rem;
            background: var(--panel);
            padding: 0.65rem;
            display: grid;
            gap: 0.5rem;
          }

          .customer-comments-title {
            font-size: 0.85rem;
            font-weight: 600;
            color: var(--text-main);
          }

          .customer-comments-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
          }

          .customer-comments-list {
            display: grid;
            gap: 0.45rem;
          }

          .customer-comment-item {
            border: 1px solid var(--border);
            border-radius: 0.55rem;
            padding: 0.5rem 0.55rem;
            background: ${isAdminViewer ? "#0f172a" : "#fff"};
          }

          .customer-comment-meta {
            font-size: 0.72rem;
            color: var(--text-muted);
            margin-bottom: 0.2rem;
          }

          .customer-comment-message {
            font-size: 0.8rem;
            white-space: pre-wrap;
            word-break: break-word;
          }

          .customer-comments-empty {
            font-size: 0.75rem;
            color: var(--text-muted);
          }

          .customer-comment-form {
            display: grid;
            gap: 0.4rem;
          }

          .customer-comment-row {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 0.4rem;
          }

          .customer-comment-input,
          .customer-comment-textarea {
            width: 100%;
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.45rem 0.55rem;
            font-size: 0.8rem;
            font-family: inherit;
          }

          .customer-comment-textarea {
            min-height: 84px;
            resize: vertical;
          }

          .customer-comment-hint {
            font-size: 0.72rem;
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

          .overlay {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.45);
            z-index: 80;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
          }

          .modal {
            width: min(760px, 100%);
            max-height: 80vh;
            overflow: auto;
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(15, 23, 42, 0.28);
          }

          .modal-head {
            padding: 0.75rem 0.9rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 0.5rem;
          }

          .modal-body {
            padding: 0.75rem 0.9rem;
            display: grid;
            gap: 0.65rem;
          }

          .admin-comment-item {
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 0.6rem 0.7rem;
            background: #fff;
          }

          .admin-comment-time {
            font-size: 0.72rem;
            color: var(--text-muted);
            margin-bottom: 0.25rem;
          }

          .admin-comment-note {
            font-size: 0.84rem;
            white-space: pre-wrap;
            word-break: break-word;
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

          .customer-comment-row {
            grid-template-columns: minmax(0, 1fr);
          }

  .viewer-admin-notes-indicator {
    margin-left: 0;
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

            /* --- Sleek mobile-first UX refresh --- */
            .header-main {
              gap: 0.35rem;
            }

            .header-topline {
              display: flex;
              align-items: center;
              gap: 0.5rem;
              min-width: 0;
            }

            .meta-toggle {
              border: 1px solid var(--border);
              border-radius: 999px;
              background: transparent;
              color: var(--text-muted);
              font-size: 0.68rem;
              padding: 0.12rem 0.55rem;
              cursor: pointer;
              align-self: flex-start;
            }

            .page-meta-collapsible {
              display: none;
              font-size: 0.72rem;
              color: var(--text-muted);
              border: 1px solid var(--border);
              border-radius: 10px;
              padding: 0.45rem 0.55rem;
              background: ${isAdminViewer ? "#0f172a" : "#f8fafc"};
            }

            body.meta-open .page-meta-collapsible {
              display: block;
            }

            .sidebar-backdrop {
              display: none;
              position: fixed;
              inset: 0;
              z-index: 35;
              background: rgba(2, 6, 23, 0.5);
              backdrop-filter: blur(2px);
            }

            .sidebar-top {
              position: sticky;
              top: 0;
              z-index: 2;
              background: var(--panel);
              padding-bottom: 0.55rem;
              margin-bottom: 0.55rem;
              border-bottom: 1px solid var(--border);
            }

            .sidebar-search {
              width: 100%;
              border: 1px solid var(--border);
              border-radius: 10px;
              background: ${isAdminViewer ? "#0b1220" : "#f8fafc"};
              color: var(--text-main);
              font-size: 0.8rem;
              padding: 0.5rem 0.62rem;
            }

            .mobile-quickbar {
              display: none;
            }

            @media (max-width: 880px) {
              .sidebar-backdrop {
                display: block;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.18s ease-out;
              }

              body.sidebar-open .sidebar-backdrop {
                opacity: 1;
                pointer-events: auto;
              }

              .page-header {
                padding: 0.58rem 0.65rem;
                gap: 0.5rem;
              }

              .header-actions {
                gap: 0.35rem;
              }

              .header-actions .btn {
                padding: 0.23rem 0.62rem;
                font-size: 0.72rem;
              }

              .header-actions .cta-repair,
              .header-actions .cta-reinspect,
              .header-actions a.btn {
                display: none;
              }

              .page-meta {
                display: none;
              }

              .sidebar {
                top: 3.45rem;
                width: min(86vw, 380px);
                border-top-right-radius: 14px;
              }

              .viewer {
                padding: 0.58rem 0.58rem 4.15rem;
                gap: 0.4rem;
              }

              .viewer-meta {
                font-size: 0.71rem;
              }

              .viewer-meta-actions {
                display: none;
              }

              .pdf-shell {
                border-radius: 12px;
                height: calc(100vh - 188px);
              }

              .mobile-quickbar {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 0.48rem;
                position: fixed;
                left: 0.58rem;
                right: 0.58rem;
                bottom: calc(env(safe-area-inset-bottom, 0px) + 0.58rem);
                z-index: 45;
                background: ${isAdminViewer ? "rgba(15, 23, 42, 0.9)" : "rgba(255, 255, 255, 0.92)"};
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 0.45rem;
                box-shadow: 0 12px 26px rgba(2, 6, 23, 0.28);
                backdrop-filter: blur(10px);
              }

              .mobile-quickbar .btn {
                width: 100%;
                border-radius: 10px;
              }
            }
          }
        </style>
      </head>
      <body>
        <div class="page">
        <header class="page-header">
        <div class="header-main">
          <div class="header-topline">
            <button type="button" class="btn btn-small viewer-nav-toggle" aria-label="Open door list">
              ☰
            </button>
            <div class="page-title">${esc(title)}</div>
          </div>
          <div class="page-meta">${esc(metaLine)}</div>
          <button type="button" class="meta-toggle" id="page-meta-toggle" aria-expanded="false">Details</button>
          <div class="page-meta-collapsible" id="page-meta-collapsible">${esc(metaLine)}</div>
        </div>
        <div class="header-actions">
          ${viewerToggleHtml}
          ${bizCtaEnabled
          ? '<button type="button" class="btn btn-small cta-repair">Request repair</button>' +
          '<button type="button" class="btn btn-small cta-reinspect">Request reinspection</button>'
          : ""
        }
        </div>
      </header>    
          <main class="content">
          <aside class="sidebar">
          <div class="sidebar-top">
            <input id="sidebar-search" class="sidebar-search" type="search" placeholder="Search doors" aria-label="Search doors" />
          </div>
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
  <a href="${allTargetSlug && allTargetBuildingCode
            ? appendViewerToPath(`/reports/${encodeURIComponent(
              businessCode
            )}/${encodeURIComponent(
              allTargetBuildingCode
            )}/${encodeURIComponent(allTargetSlug)}`, false, true)
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
            <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
       
            <section class="viewer">
            <div class="viewer-meta">
              <span class="viewer-meta-label">Viewing door: ${esc(title)}</span>
              <span class="viewer-meta-actions">
                ${adminCommentsHeaderIndicatorHtml}
                <button type="button" class="btn btn-small" id="open-customer-comments" hidden>View comments</button>
                <button type="button" class="btn btn-small" id="open-customer-comment">Make a comment</button>
              </span>
            </div>
            <div class="pdf-shell">
            <iframe id="pdf-frame" src="${viewerUrl}" class="pdf-frame" title="Door report PDF"></iframe>
            </div>
          </section>          
          </main>
          <div class="mobile-quickbar">
            <button type="button" class="btn btn-small" id="quick-open-customer-comments" hidden>Comments</button>
            <button type="button" class="btn btn-small btn-primary" id="quick-open-customer-comment">Make comment</button>
          </div>
        </div>
        ${adminCommentsModalHtml}
        <div class="overlay" id="customer-comments-overlay" style="display:none;">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Customer comments">
            <div class="modal-head">
              <strong>Customer comments</strong>
              <button type="button" class="btn btn-small" id="customer-comments-close">Close</button>
            </div>
            <div class="modal-body">
              <div class="customer-comments-list" id="customer-comments-list">
                <div class="customer-comments-empty">Loading customer comments…</div>
              </div>
            </div>
          </div>
        </div>
        <div class="overlay" id="customer-comment-overlay" style="display:none;">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Make a comment">
            <div class="modal-head">
              <strong>Make a comment</strong>
              <button type="button" class="btn btn-small" id="customer-comment-cancel">Cancel</button>
            </div>
            <div class="modal-body">
              <form class="customer-comment-form" id="customer-comment-form">
                <div class="customer-comment-row">
                  <input class="customer-comment-input" id="customer-comment-name" type="text" maxlength="120" placeholder="Your name (optional)" />
                  <input class="customer-comment-input" id="customer-comment-email" type="email" maxlength="254" placeholder="Your email (optional)" />
                </div>
                <textarea class="customer-comment-textarea" id="customer-comment-message" maxlength="2000" required placeholder="Leave a comment for this door"></textarea>
                <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
                  <button type="submit" class="btn btn-small">Submit comment</button>
                  <button type="button" class="btn btn-small" id="customer-comment-cancel-secondary">Cancel</button>
                  <span class="customer-comment-hint" id="customer-comment-status"></span>
                </div>
                <div class="customer-comment-hint">Comments are reviewed before being shown publicly.</div>
              </form>
            </div>
          </div>
        </div>
        
        <script>
        window.__DOOR_CTX = ${JSON.stringify({
            // slugs / codes
            businessCode,
            buildingCode,
            doorId,
            doorSlug,
            uid: safeDoor,

            // human labels
            businessLabel: business,
            buildingLabel: buildingCode,
            doorLabel: displayLabel,
            doorStatus: effectiveStatus || "",

            // CTA settings
            bizCtaEnabled,
            bizCtaDefaultTo,
            bizCtaAlwaysCc,
          })};
          document.addEventListener("DOMContentLoaded", function () {
          function formatCommentTime(value) {
            var s = String(value || "").trim();
            if (!s) return "";
            var d = new Date(s);
            if (Number.isNaN(d.getTime())) return s;
            try {
              return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
            } catch (e) {
              return s;
            }
          }

          function renderApprovedComments(comments) {
            var list = document.getElementById("customer-comments-list");
            if (!list) return;

            list.innerHTML = "";

            if (!comments || !comments.length) {
              var empty = document.createElement("div");
              empty.className = "customer-comments-empty";
              empty.textContent = "No customer comments yet.";
              list.appendChild(empty);
              return;
            }

            comments.forEach(function (comment) {
              var item = document.createElement("div");
              item.className = "customer-comment-item";

              var meta = document.createElement("div");
              meta.className = "customer-comment-meta";
              var who = String(comment.requesterName || "").trim();
              var when = formatCommentTime(comment.createdAt || "");
              meta.textContent = [who || "Customer", when].filter(Boolean).join(" • ");

              var msg = document.createElement("div");
              msg.className = "customer-comment-message";
              msg.textContent = String(comment.message || "");

              item.appendChild(meta);
              item.appendChild(msg);
              list.appendChild(item);
            });
          }

          async function loadApprovedComments() {
            var ctx = window.__DOOR_CTX || {};
            var uid = String(ctx.uid || "").trim();
            var list = document.getElementById("customer-comments-list");
            if (!uid || !list) {
              if (openCustomerCommentsBtn) openCustomerCommentsBtn.hidden = true;
              if (quickOpenCustomerCommentsBtn) quickOpenCustomerCommentsBtn.hidden = true;
              return;
            }

            list.innerHTML = '<div class="customer-comments-empty">Loading customer comments…</div>';

            try {
              var res = await fetch("/api/comments?uid=" + encodeURIComponent(uid), {
                method: "GET",
              });
              if (!res.ok) throw new Error("HTTP " + res.status);
              var data = await res.json();
              var comments = Array.isArray(data && data.comments) ? data.comments : [];
              if (openCustomerCommentsBtn) {
                openCustomerCommentsBtn.hidden = comments.length === 0;
                if (comments.length > 0) {
                  openCustomerCommentsBtn.textContent = "View comments (" + comments.length + ")";
                }
              }
              if (quickOpenCustomerCommentsBtn) {
                quickOpenCustomerCommentsBtn.hidden = comments.length === 0;
                if (comments.length > 0) {
                  quickOpenCustomerCommentsBtn.textContent = "Comments (" + comments.length + ")";
                }
              }
              renderApprovedComments(comments);
            } catch (err) {
              if (openCustomerCommentsBtn) openCustomerCommentsBtn.hidden = true;
              if (quickOpenCustomerCommentsBtn) quickOpenCustomerCommentsBtn.hidden = true;
              list.innerHTML = '<div class="customer-comments-empty">Unable to load comments right now.</div>';
            }
          }

          var commentForm = document.getElementById("customer-comment-form");
          var commentName = document.getElementById("customer-comment-name");
          var commentEmail = document.getElementById("customer-comment-email");
          var commentMessage = document.getElementById("customer-comment-message");
          var commentStatus = document.getElementById("customer-comment-status");
          var openCustomerCommentsBtn = document.getElementById("open-customer-comments");
          var openCustomerCommentBtn = document.getElementById("open-customer-comment");
          var customerCommentsOverlay = document.getElementById("customer-comments-overlay");
          var customerCommentsClose = document.getElementById("customer-comments-close");
          var customerCommentOverlay = document.getElementById("customer-comment-overlay");
          var customerCommentCancel = document.getElementById("customer-comment-cancel");
          var customerCommentCancelSecondary = document.getElementById("customer-comment-cancel-secondary");
          var quickOpenCustomerCommentsBtn = document.getElementById("quick-open-customer-comments");
          var quickOpenCustomerCommentBtn = document.getElementById("quick-open-customer-comment");
          var metaToggleBtn = document.getElementById("page-meta-toggle");
          var metaCollapsible = document.getElementById("page-meta-collapsible");

          function openCustomerComments() {
            if (!customerCommentsOverlay) return;
            customerCommentsOverlay.style.display = "flex";
          }

          function closeCustomerComments() {
            if (!customerCommentsOverlay) return;
            customerCommentsOverlay.style.display = "none";
          }

          function openCustomerComment() {
            if (!customerCommentOverlay) return;
            customerCommentOverlay.style.display = "flex";
            if (commentStatus) commentStatus.textContent = "";
            if (commentMessage) commentMessage.focus();
          }

          function closeCustomerComment() {
            if (!customerCommentOverlay) return;
            customerCommentOverlay.style.display = "none";
          }

          if (openCustomerCommentBtn) {
            openCustomerCommentBtn.addEventListener("click", function (e) {
              e.preventDefault();
              openCustomerComment();
            });
          }

          if (quickOpenCustomerCommentBtn) {
            quickOpenCustomerCommentBtn.addEventListener("click", function (e) {
              e.preventDefault();
              openCustomerComment();
            });
          }

          if (openCustomerCommentsBtn) {
            openCustomerCommentsBtn.addEventListener("click", function (e) {
              e.preventDefault();
              openCustomerComments();
            });
          }

          if (quickOpenCustomerCommentsBtn) {
            quickOpenCustomerCommentsBtn.addEventListener("click", function (e) {
              e.preventDefault();
              openCustomerComments();
            });
          }

          if (metaToggleBtn && metaCollapsible) {
            metaToggleBtn.addEventListener("click", function () {
              var isOpen = document.body.classList.toggle("meta-open");
              metaToggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
            });
          }

          if (customerCommentsClose) {
            customerCommentsClose.addEventListener("click", function (e) {
              e.preventDefault();
              closeCustomerComments();
            });
          }

          if (customerCommentsOverlay) {
            customerCommentsOverlay.addEventListener("click", function (e) {
              if (e.target === customerCommentsOverlay) {
                closeCustomerComments();
              }
            });
          }

          if (customerCommentCancel) {
            customerCommentCancel.addEventListener("click", function (e) {
              e.preventDefault();
              closeCustomerComment();
            });
          }

          if (customerCommentCancelSecondary) {
            customerCommentCancelSecondary.addEventListener("click", function (e) {
              e.preventDefault();
              closeCustomerComment();
            });
          }

          if (customerCommentOverlay) {
            customerCommentOverlay.addEventListener("click", function (e) {
              if (e.target === customerCommentOverlay) {
                closeCustomerComment();
              }
            });
          }

          if (commentForm) {
            commentForm.addEventListener("submit", async function (e) {
              e.preventDefault();

              var ctx = window.__DOOR_CTX || {};
              var uid = String(ctx.uid || "").trim();
              var message = String((commentMessage && commentMessage.value) || "").trim();

              if (!uid) {
                if (commentStatus) commentStatus.textContent = "Door UID unavailable.";
                return;
              }

              if (!message) {
                if (commentStatus) commentStatus.textContent = "Please enter a comment.";
                return;
              }

              var submitBtn = commentForm.querySelector('button[type="submit"]');
              if (submitBtn) submitBtn.disabled = true;
              if (commentStatus) commentStatus.textContent = "Submitting…";

              try {
                var res = await fetch("/api/customer-comment", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    uid: uid,
                    message: message,
                    requesterName: (commentName && commentName.value) || "",
                    requesterEmail: (commentEmail && commentEmail.value) || "",
                  }),
                });

                if (!res.ok) {
                  var errText = "Unable to submit comment.";
                  try {
                    var errJson = await res.json();
                    if (errJson && errJson.error) errText = String(errJson.error);
                  } catch (_e) {
                    errText = "Unable to submit comment.";
                  }
                  throw new Error(errText);
                }

                if (commentMessage) commentMessage.value = "";
                var submitOut = await res.json().catch(function(){ return {}; });
                if (commentStatus) {
                  if (String(submitOut.status || "").toLowerCase() === "approved") {
                    commentStatus.textContent = "Comment posted and visible now.";
                  } else {
                    commentStatus.textContent = "Comment submitted. It is pending moderation before public display.";
                  }
                }

                closeCustomerComment();

                await loadApprovedComments();
              } catch (err) {
                if (commentStatus) {
                  commentStatus.textContent = err && err.message
                    ? err.message
                    : "Unable to submit comment.";
                }
              } finally {
                if (submitBtn) submitBtn.disabled = false;
              }
            });
          }

          loadApprovedComments();

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
                if (e.target.closest(".download-bucket") || e.target.closest(".open-admin-comments")) return;

                var section = titleEl.closest(".sidebar-section");
                if (!section) return;
                section.classList.toggle("collapsed");

                var bucket = section.getAttribute("data-bucket");
                if (!bucket) return;
                sectionState[bucket] = section.classList.contains("collapsed");
                saveSectionState(sectionState);
              });
            });

          // Admin comments modal behavior
          var adminCommentsOverlay = document.getElementById("admin-comments-overlay");
          var adminCommentsClose = document.getElementById("admin-comments-close");

          function openAdminComments() {
            if (!adminCommentsOverlay) return;
            adminCommentsOverlay.style.display = "flex";
          }

          function closeAdminComments() {
            if (!adminCommentsOverlay) return;
            adminCommentsOverlay.style.display = "none";
          }

          document.querySelectorAll(".open-admin-comments").forEach(function (btn) {
            btn.addEventListener("click", function (e) {
              e.preventDefault();
              e.stopPropagation();
              openAdminComments();
            });
          });

          if (adminCommentsClose) {
            adminCommentsClose.addEventListener("click", function (e) {
              e.preventDefault();
              closeAdminComments();
            });
          }

          if (adminCommentsOverlay) {
            adminCommentsOverlay.addEventListener("click", function (e) {
              if (e.target === adminCommentsOverlay) {
                closeAdminComments();
              }
            });
          }

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

            var sidebarBackdrop = document.getElementById("sidebar-backdrop");
            if (sidebarBackdrop) {
              sidebarBackdrop.addEventListener("click", function () {
                document.body.classList.remove("sidebar-open");
                saveSidebarOpen(false);
              });
            }

            var sidebarSearch = document.getElementById("sidebar-search");
            if (sidebarSearch) {
              sidebarSearch.addEventListener("input", function () {
                var q = String(sidebarSearch.value || "").trim().toLowerCase();
                document.querySelectorAll(".door-item[data-search]").forEach(function (item) {
                  var hay = String(item.getAttribute("data-search") || "").toLowerCase();
                  item.style.display = !q || hay.indexOf(q) !== -1 ? "" : "none";
                });
              });
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

            document.addEventListener("keydown", function (e) {
              if (e.key === "Escape") {
                closeAdminComments();
                closeCustomerComment();
              }
            });
          });
        </script>
      </body>
      </html>`);

    }
    // =====================================================================
    //  COMPATIBILITY PORTAL ROUTES
    //  Canonical owner is portal-worker. Keep these only as compatibility
    //  shims where route bindings still target reports-worker.
    // =====================================================================
    //  GET /portal/login  (customer portal login page)
    // =====================================================================
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
    <p>Enter your business code and email. We will send a one-time login link.</p>
    <input id="biz" placeholder="Business code" value="${esc(bizPrefill)}" />
    <input id="email" type="email" placeholder="you@company.com" />
    <button id="go">Send login link</button>
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessCode: b, email: e })
        });
        const out = await res.json().catch(()=>({}));
        if(!res.ok){ msg.textContent = out.error || "Unable to send login link."; return; }
        msg.textContent = out.magicLink
          ? "Magic link generated. Check your email."
          : "If your account is valid, a login link has been sent.";
      } finally {
        go.disabled = false;
      }
    };
  })();
  </script>
</body>
</html>`);
    }

    // =====================================================================
    //  GET /portal/invite?t=...  (accept manager/member invite)
    // =====================================================================
    if (req.method === "GET" && pathname === "/portal/invite") {
      const token = String(url.searchParams.get("t") || "").trim();
      if (!token) return text("Invite token is required", 400);

      return html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Accept Invite</title>
  <style>
    body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:460px;background:#0f172a;border:1px solid #1f2937;border-radius:14px;padding:18px}
    input,button{width:100%;box-sizing:border-box;border-radius:10px;padding:10px;font-size:14px}
    input{background:#0b1220;color:#e5e7eb;border:1px solid #243043;margin-bottom:10px}
    button{border:1px solid #334155;background:#2563eb;color:#fff;font-weight:600}
    .msg{font-size:12px;margin-top:10px;opacity:.9}
  </style>
</head>
<body>
  <div class="card">
    <h1>Accept customer portal invite</h1>
    <p>Confirm your email to activate your portal access.</p>
    <input id="email" type="email" placeholder="you@company.com" />
    <button id="go">Accept invite</button>
    <div id="msg" class="msg"></div>
  </div>
  <script>
  (function(){
    const token = ${JSON.stringify(token)};
    const email = document.getElementById("email");
    const go = document.getElementById("go");
    const msg = document.getElementById("msg");
    go.onclick = async function(){
      msg.textContent = "";
      const e = (email.value || "").trim();
      if(!e){ msg.textContent = "Email is required."; return; }
      go.disabled = true;
      try {
        const res = await fetch("/api/portal/invite/accept", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: token, email: e })
        });
        const out = await res.json().catch(()=>({}));
        if(!res.ok){ msg.textContent = out.error || "Could not accept invite."; return; }
        msg.textContent = "Invite accepted. Redirecting to portal...";
        window.location = (out.portalUrl || "/portal");
      } finally {
        go.disabled = false;
      }
    };
  })();
  </script>
</body>
</html>`);
    }

    // =====================================================================
    //  GET /portal/magic?t=...  (magic link callback)
    // =====================================================================
    if (req.method === "GET" && pathname === "/portal/magic") {
      const token = String(url.searchParams.get("t") || "").trim();
      if (!token) return text("Missing token", 400);

      const key = `portalMagic:${token}`;
      const rec = await env.ENROLL_TOKENS.get(key, "json");
      if (!rec || typeof rec !== "object") return text("Invalid magic token", 403);

      const now = Date.now();
      if (typeof rec.expiresAt === "number" && now > rec.expiresAt) {
        return text("Magic token expired", 403);
      }

      const businessCode = slug(rec.businessCode || "");
      const email = normalizeEmail(rec.email || "");
      if (!businessCode || !email) return text("Invalid magic token payload", 403);

      const member = await env.ENROLL_TOKENS.get(`portalMember:${businessCode}:${email}`, "json");
      if (!member || member.active === false) return text("Portal member not active", 403);

      const sid = crypto.randomUUID().replace(/-/g, "");
      const expiresAt = now + 1000 * 60 * 60 * 24 * 14;
      await env.ENROLL_TOKENS.put(
        `portalSession:${sid}`,
        JSON.stringify({
          sid,
          businessCode,
          email,
          role: normalizePortalRole(member.role || "member"),
          createdAt: now,
          expiresAt,
        })
      );

      await env.ENROLL_TOKENS.delete(key);

      const resp = Response.redirect(`${url.origin}/portal`, 302);
      resp.headers.append(
        "Set-Cookie",
        setCookie("castle_portal", sid, {
          maxAge: 60 * 60 * 24 * 14,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          domain: ".castledoorict.com",
        })
      );
      return resp;
    }

    // =====================================================================
    //  GET /portal/logout
    // =====================================================================
    if (req.method === "GET" && pathname === "/portal/logout") {
      const resp = Response.redirect(`${url.origin}/portal/login`, 302);
      resp.headers.append(
        "Set-Cookie",
        setCookie("castle_portal", "", {
          maxAge: 0,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          domain: ".castledoorict.com",
        })
      );
      return resp;
    }

    // =====================================================================
    //  GET /portal  (portal landing)
    // =====================================================================
    if (req.method === "GET" && pathname === "/portal") {
      const bizRaw = String(url.searchParams.get("biz") || "").trim();
      const bizFromQuery = bizRaw ? slug(bizRaw) : "";
      const access = await requirePortalAccess(env, req, bizFromQuery || "", false);
      if (!access.ok) return Response.redirect(`${url.origin}/portal/login`, 302);

      const session = access.session;
      const businessCode = slug(session.businessCode || bizFromQuery || "");
      if (!businessCode) return text("Business scope required", 400);

      return html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Customer Portal</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e5e7eb}
    .wrap{max-width:1100px;margin:0 auto;padding:20px}
    .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between}
    .card{background:#0f172a;border:1px solid #1f2937;border-radius:12px;padding:14px;margin-top:14px}
    .kpi{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}
    .box{background:#0b1220;border:1px solid #243043;border-radius:10px;padding:10px}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #243043;padding:8px;font-size:13px;text-align:left}
    button,input,select{border-radius:8px;border:1px solid #334155;background:#111827;color:#e5e7eb;padding:8px}
    button{cursor:pointer;background:#2563eb}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row">
      <h1>Customer Portal – ${esc(businessCode)}</h1>
      <div>
        <span>Role: ${esc(session.role || "member")}</span>
        <a href="/portal/logout" style="color:#93c5fd;margin-left:12px">Logout</a>
      </div>
    </div>
    <div class="card" id="kpis">Loading dashboard…</div>
    <div class="card">
      <h3>Doors</h3>
      <table>
        <thead><tr><th>Door</th><th>Status</th><th>Building</th><th>Action</th></tr></thead>
        <tbody id="doorRows"></tbody>
      </table>
    </div>
    <div class="card" id="managerBlock" style="display:none;">
      <h3>Manager settings</h3>
      <label>Repair destination email</label>
      <input id="repairTo" placeholder="maintenance@customer.com" />
      <button id="saveRepair">Save repair destination</button>
      <div id="managerMsg" style="font-size:12px;margin-top:8px;"></div>
    </div>
  </div>
  <script>
  (async function(){
    const dashboardRes = await fetch("/api/portal/dashboard?businessCode=${encodeURIComponent(businessCode)}");
    const dashboard = await dashboardRes.json().catch(()=>({}));
    if(!dashboardRes.ok){
      document.getElementById("kpis").textContent = dashboard.error || "Unable to load dashboard.";
      return;
    }
    document.getElementById("kpis").innerHTML =
      '<div class="kpi">' +
      '<div class="box"><div>Total doors</div><strong>' + dashboard.totals.total + '</strong></div>' +
      '<div class="box"><div>Pass</div><strong>' + dashboard.totals.pass + '</strong></div>' +
      '<div class="box"><div>Conditional</div><strong>' + dashboard.totals.conditional + '</strong></div>' +
      '<div class="box"><div>Flagged</div><strong>' + dashboard.totals.flagged + '</strong></div>' +
      '</div>';

    const rows = document.getElementById("doorRows");
    (dashboard.doors || []).forEach(function(d){
      const tr = document.createElement("tr");
      const reportUrl = '/reports/' + encodeURIComponent(d.businessCode) + '/' + encodeURIComponent(d.buildingCode || 'main') + '/' + encodeURIComponent(d.doorSlug || '');
      tr.innerHTML =
        '<td>' + (d.displayLabel || d.doorId || 'Door') + '</td>' +
        '<td>' + (d.status || '') + '</td>' +
        '<td>' + (d.building || '') + '</td>' +
        '<td><a href="' + reportUrl + '" target="_blank" style="color:#93c5fd">View</a> <button data-door="' + (d.doorId || '') + '">Needs fixed</button></td>';
      rows.appendChild(tr);
    });

    rows.querySelectorAll("button[data-door]").forEach(function(btn){
      btn.addEventListener("click", async function(){
        const doorId = btn.getAttribute("data-door") || "";
        const notes = window.prompt("What needs fixed?", "") || "";
        if(!doorId || !notes) return;
        const body = {
          businessCode: ${JSON.stringify(businessCode)},
          kind: "repair",
          doorId,
          notes
        };
        const res = await fetch("/api/portal/cta-submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        const out = await res.json().catch(()=>({}));
        if(!res.ok){ alert(out.error || "Unable to submit request"); return; }
        alert("Repair request submitted. ID: " + out.id);
      });
    });

    const meRes = await fetch('/api/portal/me?businessCode=${encodeURIComponent(businessCode)}');
    const me = await meRes.json().catch(()=>({}));
    if(meRes.ok && me.role === 'manager'){
      document.getElementById('managerBlock').style.display = 'block';
      const setRes = await fetch('/api/portal/settings/repair?businessCode=${encodeURIComponent(businessCode)}');
      const setOut = await setRes.json().catch(()=>({}));
      if(setRes.ok){ document.getElementById('repairTo').value = setOut.defaultTo || ''; }
      document.getElementById('saveRepair').onclick = async function(){
        const defaultTo = (document.getElementById('repairTo').value || '').trim();
        const res = await fetch('/api/portal/settings/repair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ businessCode: ${JSON.stringify(businessCode)}, defaultTo: defaultTo })
        });
        const out = await res.json().catch(()=>({}));
        document.getElementById('managerMsg').textContent = res.ok ? 'Saved.' : (out.error || 'Failed');
      };
    }
  })();
  </script>
</body>
</html>`);
    }

    // =====================================================================
    //  POST /api/portal/auth/start
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/portal/auth/start") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || body.biz || "");
      const email = normalizeEmail(body.email || "");
      if (!businessCode || !email || !isValidEmail(email)) {
        return json({ error: "businessCode and valid email required" }, 400);
      }

      const member = await env.ENROLL_TOKENS.get(`portalMember:${businessCode}:${email}`, "json");
      if (!member || member.active === false) {
        return json({ ok: true });
      }

      const token = crypto.randomUUID().replace(/-/g, "");
      const expiresAt = Date.now() + 1000 * 60 * 30;
      await env.ENROLL_TOKENS.put(
        `portalMagic:${token}`,
        JSON.stringify({ token, businessCode, email, createdAt: Date.now(), expiresAt })
      );

      const magicLink = `${url.origin}/portal/magic?t=${encodeURIComponent(token)}`;
      const apiKey = env.RESEND_API_KEY;
      const from = env.RESEND_FROM;
      if (apiKey && from) {
        ctx.waitUntil(
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from,
              to: [email],
              subject: `Your Castle Door portal login link (${businessCode})`,
              html: `<p>Use this one-time login link:</p><p><a href=\"${magicLink}\">Sign in to portal</a></p><p>This link expires in 30 minutes.</p>`,
            }),
          }).catch(() => null)
        );
      }

      return json({ ok: true, magicLink: isUploadDebug ? magicLink : undefined });
    }

    // =====================================================================
    //  POST /api/portal/invite/accept
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/portal/invite/accept") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const token = String(body.token || "").trim();
      const email = normalizeEmail(body.email || "");
      if (!token || !email || !isValidEmail(email)) {
        return json({ error: "token and valid email required" }, 400);
      }

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
        headers.append(
          "Set-Cookie",
          setCookie("castle_portal", sid, {
            maxAge: 60 * 60 * 24 * 14,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
            domain: ".castledoorict.com",
          })
        );
        return new Response(
          JSON.stringify({ ok: true, businessCode: usedBiz, email: effectiveEmail, role: usedRole, portalUrl: `${url.origin}/portal/magic?t=${encodeURIComponent(magicToken)}` }),
          {
            status: 200,
            headers,
          }
        );
      }
      if (typeof invite.expiresAt === "number" && Date.now() > invite.expiresAt) {
        return json({ error: "Invite token expired" }, 403);
      }

      const businessCode = slug(invite.businessCode || "");
      const role = normalizePortalRole(invite.role || "member");
      const allowedEmail = normalizeEmail(invite.email || "");
      if (allowedEmail && allowedEmail !== email) {
        return json({ error: "Invite token is restricted to a specific email" }, 403);
      }

      const member = {
        businessCode,
        email,
        role,
        canComment: normalizeCommentPermission(invite.canComment, true),
        active: true,
        createdAt: Date.now(),
        createdBy: invite.createdBy || "invite",
      };
      await env.ENROLL_TOKENS.put(`portalMember:${businessCode}:${email}`, JSON.stringify(member));
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
        JSON.stringify({
          sid,
          businessCode,
          email,
          role,
          createdAt: Date.now(),
          expiresAt: sessionExpiresAt,
        })
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

      const enrollUrl = `${url.origin}/enroll/${encodeURIComponent(businessCode)}?t=${encodeURIComponent(enrollToken)}&email=${encodeURIComponent(email)}`;
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
      const portalUrl = `${url.origin}/portal/magic?t=${encodeURIComponent(magicToken)}`;

      const headers = new Headers({ "content-type": "application/json" });
      headers.append(
        "Set-Cookie",
        setCookie("castle_portal", sid, {
          maxAge: 60 * 60 * 24 * 14,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          domain: ".castledoorict.com",
        })
      );

      return new Response(JSON.stringify({ ok: true, businessCode, email, role, portalUrl, enrollUrl }), {
        status: 200,
        headers,
      });
    }

    // =====================================================================
    //  GET /api/portal/me
    // =====================================================================
    if (req.method === "GET" && pathname === "/api/portal/me") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(env, req, businessCode, false);
      if (!access.ok) return access.response;

      return json({
        ok: true,
        superuser: !!access.session.superuser,
        businessCode: access.session.businessCode || businessCode,
        email: access.session.email,
        role: access.session.role,
        canComment: normalizeCommentPermission(access.session.member && access.session.member.canComment, true),
      });
    }

    // =====================================================================
    //  GET /api/portal/dashboard
    // =====================================================================
    if (req.method === "GET" && pathname === "/api/portal/dashboard") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(env, req, businessCode, false);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;

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
        totals: {
          total: doors.length,
          pass,
          conditional,
          flagged,
        },
        doors: doors
          .slice()
          .sort((a, b) => String(b.lastInspectedAt || "").localeCompare(String(a.lastInspectedAt || "")))
          .slice(0, 300),
      });
    }

    // =====================================================================
    //  GET /api/portal/settings/repair
    // =====================================================================
    if (req.method === "GET" && pathname === "/api/portal/settings/repair") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(env, req, businessCode, true);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;

      const cfg = (await env.ENROLL_TOKENS.get(`bizcfg:${biz}`, "json")) || {};
      return json({
        ok: true,
        businessCode: biz,
        defaultTo: typeof cfg.cta_default_to === "string" ? cfg.cta_default_to : "",
        alwaysCc: typeof cfg.cta_always_cc === "string" ? cfg.cta_always_cc : "",
        ctaEnabled: cfg.cta_enabled !== false,
      });
    }

    // =====================================================================
    //  POST /api/portal/settings/repair
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/portal/settings/repair") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const defaultTo = String(body.defaultTo || "").trim();
      const alwaysCc = String(body.alwaysCc || "").trim();

      const access = await requirePortalAccess(env, req, businessCode, true);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;

      if (defaultTo && !isValidEmail(defaultTo)) {
        return json({ error: "defaultTo must be a valid email" }, 400);
      }

      const cfgKey = `bizcfg:${biz}`;
      const cfg = (await env.ENROLL_TOKENS.get(cfgKey, "json")) || {};
      cfg.slug = cfg.slug || biz;
      cfg.name = cfg.name || biz;
      cfg.cta_enabled = true;
      cfg.cta_default_to = defaultTo;
      const ccList = splitEmailList(alwaysCc);
      cfg.cta_always_cc = ccList.join(",");

      const dispatch = String(env.CASTLE_DISPATCH_EMAIL || "").trim().toLowerCase();
      if (dispatch && !splitEmailList(cfg.cta_always_cc).includes(dispatch)) {
        const next = splitEmailList((cfg.cta_always_cc ? cfg.cta_always_cc + "," : "") + dispatch);
        cfg.cta_always_cc = next.join(",");
      }

      await env.ENROLL_TOKENS.put(cfgKey, JSON.stringify(cfg));
      return json({ ok: true, businessCode: biz, defaultTo: cfg.cta_default_to, alwaysCc: cfg.cta_always_cc });
    }

    // =====================================================================
    //  GET /api/portal/members
    // =====================================================================
    if (req.method === "GET" && pathname === "/api/portal/members") {
      const businessCode = slug(url.searchParams.get("businessCode") || "");
      const access = await requirePortalAccess(env, req, businessCode, true);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;

      const members = [];
      let cursor;
      do {
        const listed = await env.ENROLL_TOKENS.list({
          prefix: `portalMember:${biz}:`,
          cursor,
        });
        for (const k of listed.keys || []) {
          const row = await env.ENROLL_TOKENS.get(k.name, "json");
          if (row) members.push(row);
        }
        cursor = listed.cursor;
      } while (cursor);

      members.sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));
      return json({
        ok: true,
        businessCode: biz,
        members: members.map((m) => ({
          ...m,
          canComment: normalizeCommentPermission(m && m.canComment, true),
        })),
      });
    }

    // =====================================================================
    //  POST /api/portal/members/invite
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/portal/members/invite") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const email = normalizeEmail(body.email || "");
      const role = normalizePortalRole(body.role || "member");
      const canComment = normalizeCommentPermission(body.canComment, true);

      const access = await requirePortalAccess(env, req, businessCode, true);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;

      if (!email || !isValidEmail(email)) return json({ error: "valid email required" }, 400);

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

      const inviteUrl = `${url.origin}/portal/invite?t=${encodeURIComponent(token)}`;
      return json({ ok: true, businessCode: biz, email, role, canComment, inviteUrl, token });
    }

    // =====================================================================
    //  POST /api/portal/members/comment-permission
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/portal/members/comment-permission") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const email = normalizeEmail(body.email || "");
      const access = await requirePortalAccess(env, req, businessCode, true);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;
      if (!email || !isValidEmail(email)) return json({ error: "valid email required" }, 400);

      const memberKey = `portalMember:${biz}:${email}`;
      const member = await env.ENROLL_TOKENS.get(memberKey, "json");
      if (!member || member.active === false) return json({ error: "portal member not found" }, 404);

      const canComment = normalizeCommentPermission(body.canComment, true);
      member.canComment = canComment;
      await env.ENROLL_TOKENS.put(memberKey, JSON.stringify(member));
      return json({ ok: true, businessCode: biz, email, canComment });
    }

    // =====================================================================
    //  POST /api/portal/members/remove
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/portal/members/remove") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const email = normalizeEmail(body.email || "");
      const access = await requirePortalAccess(env, req, businessCode, true);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;
      if (!email || !isValidEmail(email)) return json({ error: "valid email required" }, 400);

      await env.ENROLL_TOKENS.delete(`portalMember:${biz}:${email}`);
      return json({ ok: true, businessCode: biz, email });
    }

    // =====================================================================
    //  POST /api/portal/cta-submit  (portal-authenticated CTA)
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/portal/cta-submit") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);

      const businessCode = slug(body.businessCode || "");
      const access = await requirePortalAccess(env, req, businessCode, false);
      if (!access.ok) return access.response;
      const biz = access.session.businessCode || businessCode;

      const resolvedBody = {
        ...body,
        businessCode: biz,
        requesterEmail: access.session.email || body.requesterEmail || "",
        requesterName: body.requesterName || access.session.email || "Portal user",
      };

      const result = await submitCtaRequest(env, ctx, req, resolvedBody);
      return result.response;
    }

    // =====================================================================
    //  POST /api/cta-request  (store CTA + send email via Resend)
    // =====================================================================
    if (req.method === "POST" && pathname === "/api/cta-request") {
      const body = await readJsonBody(req);
      if (!body) return json({ error: "Bad JSON" }, 400);
      const result = await submitCtaRequest(env, ctx, req, body);
      return result.response;
    }

    // =====================================================
    // GET /api/comments?uid=XXXX
    // Returns approved customer comments only for the UID
    // =====================================================
    if (req.method === "GET" && pathname === "/api/comments") {
      const uidInput = String(url.searchParams.get("uid") || "").trim();
      if (!uidInput) {
        return json({ error: "uid is required" }, 400);
      }

      const limit = Number(url.searchParams.get("limit") || "50");
      const result = await listApprovedCommentsForUid(env.REPORTS_KV, uidInput, limit);
      if (!result.resolved) {
        return json({ error: "Unknown UID" }, 404);
      }

      return json({
        ok: true,
        uid: result.resolved.uid,
        count: result.comments.length,
        comments: result.comments,
      });
    }

    // =====================================================
    // POST /api/customer-comment
    // Body: { uid, message, requesterName?, requesterEmail? }
      // Portal-auth comments are auto-approved (if member has comment permission).
      // Public comments remain pending for admin moderation.
    // =====================================================
    if (req.method === "POST" && pathname === "/api/customer-comment") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Bad JSON" }, 400);
      }

      const uidInput = String((body && body.uid) || "").trim();
      const message = sanitizeCommentMessage((body && body.message) || "", 2000);
      const requesterName = sanitizeOneLineText((body && body.requesterName) || "", 120);
      const requesterEmail = sanitizeOneLineText((body && body.requesterEmail) || "", 254).toLowerCase();

      if (!uidInput) {
        return json({ error: "uid is required" }, 400);
      }

      if (!message || message.length < 1 || message.length > 2000) {
        return json({ error: "message must be between 1 and 2000 characters" }, 400);
      }

      if (
        requesterEmail &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)
      ) {
        return json({ error: "requesterEmail is invalid" }, 400);
      }

      const resolved = await resolveCanonicalCommentUid(env.REPORTS_KV, uidInput);
      if (!resolved) {
        return json({ error: "Unknown UID" }, 404);
      }

      const portalSess = await getPortalSession(env, req);
      const isPortalAuth = !!(portalSess && portalSess.ok && !portalSess.superuser);
      if (isPortalAuth && portalSess.businessCode !== resolved.mapping.businessCode) {
        return json({ error: "Forbidden business scope" }, 403);
      }

      if (isPortalAuth && !normalizeCommentPermission(portalSess.member && portalSess.member.canComment, true)) {
        return json({ error: "Comment permission denied for this portal member" }, 403);
      }

      const createdAt = isoNow();
      const commentId = crypto.randomUUID();
      const commentKey = `comment:${resolved.uid}:${createdAt}:${commentId}`;
      const status = isPortalAuth ? "approved" : "pending";

      const effectiveRequesterEmail = isPortalAuth
        ? normalizeEmail(portalSess.email || requesterEmail || "")
        : requesterEmail || null;
      const effectiveRequesterName =
        requesterName ||
        (isPortalAuth ? normalizeEmail(portalSess.email || "") : "") ||
        null;

      const record = {
        commentId,
        uid: resolved.uid,
        status,
        message,
        createdAt,
        moderatedAt: isPortalAuth ? createdAt : null,
        moderationReason: isPortalAuth ? "portal-auth-auto-approved" : null,
        requesterName: effectiveRequesterName,
        requesterEmail: effectiveRequesterEmail,
        businessCode: resolved.mapping.businessCode,
        buildingCode: resolved.mapping.buildingCode,
        doorSlug: resolved.mapping.doorSlug,
        source: isPortalAuth ? "portal" : "public",
      };

      await env.REPORTS_KV.put(commentKey, JSON.stringify(record));

      return json(
        {
          ok: true,
          commentKey,
          commentId,
          uid: resolved.uid,
          status,
          createdAt,
          source: record.source,
        },
        201
      );
    }

    // Fallback 404
    return text("Not found", 404);
  },
};
