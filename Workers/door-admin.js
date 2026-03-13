import {
  slug,
  isValidEmail,
  normalizePortalRole,
  splitEmailList,
  parseCookies,
  setCookie as setCookieShared,
  readJsonBody as readJsonBodyShared,
} from "./shared/helpers.js";

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

    const requireAdmin = () => {
      const cookies = parseCookies(request.headers.get("Cookie"));
      if (cookies["admin_auth"] === "ok") return null;
      const loginUrl = new URL("/admin/login", url.origin);
      return Response.redirect(loginUrl.toString(), 302);
    };

    const setCookie = (name, value) =>
      setCookieShared(name, value, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: true,
      });

    const readJsonBody = async () =>
      readJsonBodyShared(request, { requireJsonContentType: true });

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
          ? `Castle Door dashboard access (${bizCode})`
          : `Castle Door portal invite (${bizCode})`,
        html:
          `<p>You were ${isDirect ? "granted" : "invited to"} Castle Door customer portal access for <strong>${esc(bizCode)}</strong>.</p>` +
          `<p>Role: <strong>${esc(roleLabel)}</strong></p>` +
          `<p><a href="${esc(ctaUrl)}">${isDirect ? "Sign in to dashboard" : "Accept portal invite"}</a></p>` +
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
      if (!key || key !== env.ADMIN_KEY) return text("Unauthorized", 401);

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
            <button class="tabbtn active" id="tabComments" data-tab="comments">Comments</button>
            <button class="tabbtn" id="tabBusiness" data-tab="business">Business</button>
            <button class="tabbtn" id="tabSecurity" data-tab="security">Security</button>
            <button class="tabbtn" id="tabPortal" data-tab="portal">Portal</button>
          </div>

          <div class="tabpanel active" id="panelComments">
            <div class="bar">
              <div class="muted">Find a door by UID (QR repair tool)</div>
              <input id="uidSearch" placeholder="Enter UID…"/>
              <button class="btn primary" id="uidGo">Find</button>
              <div class="muted" id="uidResult" style="margin-left:10px;"></div>
            </div>

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
        const tbody = document.getElementById("tbody");
        const status = document.getElementById("status");
        const q = document.getElementById("q");
        const refresh = document.getElementById("refresh");

        const tabComments = document.getElementById("tabComments");
        const tabBusiness = document.getElementById("tabBusiness");
        const tabSecurity = document.getElementById("tabSecurity");
        const tabPortal = document.getElementById("tabPortal");
        const panelComments = document.getElementById("panelComments");
        const panelBusiness = document.getElementById("panelBusiness");
        const panelSecurity = document.getElementById("panelSecurity");
        const panelPortal = document.getElementById("panelPortal");
        const secBiz = document.getElementById("secBiz");
        const secMode = document.getElementById("secMode");
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
        let activeTab = "comments";
        let securityLoaded = false;
        let portalLoaded = false;
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
            const fullName = cfg.name || cfg.slug || "";
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
     
          // Keep ONLY opaque (6-char) business codes; suppress mime garbage
          let visible = all.filter(cfg => {
            const name = (cfg.name || "").toLowerCase();
            const isMimeGarbage =
              name.startsWith("=?utf-8?") ||
              name.includes("?b?") ||
              name.includes("?=");
            return (cfg.slug || "").length === 6 && !isMimeGarbage;
          });

      
          if (s) {
            visible = visible.filter(cfg => {
              const n = (cfg.name || "").toLowerCase();
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

        function looksMimeGarbage(name){
          const n = String(name || "").toLowerCase();
          return n.startsWith("=?utf-8?") || n.includes("?b?") || n.includes("?=");
        }

        function displayBizLabel(cfg){
          const code = String(cfg && cfg.slug ? cfg.slug : "").trim();
          const rawName = String(cfg && cfg.name ? cfg.name : "").trim();
          const cleanName = rawName && !looksMimeGarbage(rawName) ? rawName : "";
          const base = cleanName || code || "Unknown business";
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
            .sort((a, b) => (a.name || a.slug || "").localeCompare(b.name || b.slug || ""));

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
          activeTab = next;

          tabComments.classList.toggle("active", next === "comments");
          tabBusiness.classList.toggle("active", next === "business");
          tabSecurity.classList.toggle("active", next === "security");
          tabPortal.classList.toggle("active", next === "portal");

          panelComments.classList.toggle("active", next === "comments");
          panelBusiness.classList.toggle("active", next === "business");
          panelSecurity.classList.toggle("active", next === "security");
          panelPortal.classList.toggle("active", next === "portal");

          if (next === "business" && !businessLoaded) {
            await load();
          }
          if (next === "security" && !securityLoaded) {
            await loadSecurity();
          }
          if (next === "portal" && !portalLoaded) {
            await loadPortal();
          }
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
      
          confirm.disabled = true;
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
            confirm.disabled = false;
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
          bldBiz = cfg.slug;
      
          bldTitle.textContent = "Manage buildings: " + (cfg.name || cfg.slug) + " — " + cfg.slug;
      
          bldMerge.disabled = true;
          bldCancel.disabled = true;
      
          try {
            bldList = await api("/admin/business/" + encodeURIComponent(cfg.slug) + "/buildings");
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
              const buildingCode = (bldRenameWhich.value || "").trim();
              const name = (bldRenameName.value || "").trim();
              if (!buildingCode) { bldMsg.textContent = "Pick a building to rename."; return; }
              if (!name) { bldMsg.textContent = "Enter a name."; return; }

              bldRenameSave.disabled = true;
              try {
                await api("/admin/building-name", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ biz: bldBiz, buildingCode, name })
                });
                bldMsg.textContent = "Saved.";
                // refresh buildings list so labels update
                bldList = await api("/admin/business/" + encodeURIComponent(bldBiz) + "/buildings");
                if(!Array.isArray(bldList)) bldList = [];
                // re-open in place (simple repaint)
                closeBuildings();
                await openBuildings({ slug: bldBiz, name: bldBiz, active: true });
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
            
        q.addEventListener("input", applyFilter);
        refresh.onclick = async () => {
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

        tabComments.onclick = () => setTab("comments");
        tabBusiness.onclick = () => setTab("business");
        tabSecurity.onclick = () => setTab("security");
        tabPortal.onclick = () => setTab("portal");

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
              body: JSON.stringify({ biz, mode }),
            });

            const row = all.find(x => x.slug === biz);
            if (row) row.mode = mode;
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
        
        uidGo.onclick = async () => {
          uidResult.innerHTML = "Searching…";
          const q = (uidSearch.value || "").trim();
          if (!q) {
            uidResult.textContent = "Enter at least 2 characters.";
            return;
          }
        
          try {
            const res = await api("/admin/search?q=" + encodeURIComponent(q));
        
            const matches = (res && res.matches) ? res.matches : [];
            if (!matches.length) {
              uidResult.textContent = "No matches.";
              return;
            }
        
            // Render result list with open-admin-report links + repair buttons when needed
            uidResult.innerHTML = "";
            const wrap = document.createElement("div");
            wrap.style.display = "grid";
            wrap.style.gap = "8px";
            wrap.style.marginTop = "6px";
        
            matches.forEach(m => {
              const row = document.createElement("div");
              row.style.border = "1px solid #334155";
              row.style.borderRadius = "10px";
              row.style.padding = "8px";
              row.style.background = "#0b1220";
        
              const title = document.createElement("div");
              title.style.fontWeight = "600";
              title.textContent = m.uid + (m.hasDoorIndex ? " (QR OK)" : " (QR BROKEN)");
              row.appendChild(title);
        
              const meta = document.createElement("div");
              meta.className = "mono";
              meta.style.opacity = "0.85";
              meta.style.marginTop = "2px";
              meta.textContent = (m.businessCode || "?") + " / " + (m.buildingCode || "?") + " / " + (m.doorSlug || "?");
              row.appendChild(meta);
        
              if (m.label) {
                const lab = document.createElement("div");
                lab.style.opacity = "0.85";
                lab.style.marginTop = "2px";
                lab.textContent = m.label;
                row.appendChild(lab);
              }

              const open = document.createElement("a");
              open.className = "btn primary";
              open.style.display = "inline-block";
              open.style.marginTop = "6px";
              open.style.textDecoration = "none";
              open.href = "https://r.castledoorict.com/admin/reports/" + encodeURIComponent(m.uid);
              open.target = "_blank";
              open.rel = "noopener noreferrer";
              open.textContent = "Open Admin Report";
              row.appendChild(open);

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
        
              wrap.appendChild(row);
            });
        
            uidResult.appendChild(wrap);
          } catch (e) {
            uidResult.textContent = "Error: " + e.message;
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

        const commentUidFilter = document.getElementById("commentUidFilter");
        const commentStatusFilter = document.getElementById("commentStatusFilter");
        const commentsLoad = document.getElementById("commentsLoad");
        const commentsModerationBody = document.getElementById("commentsModerationBody");
        const commentsModerationResult = document.getElementById("commentsModerationResult");

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
        const initialTab = (tabParam === "business" || tabParam === "security" || tabParam === "portal" || tabParam === "comments")
          ? tabParam
          : "comments";
        setTab(initialTab);
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

      const snap = await env.ENROLL_TOKENS.get(ADMIN_BIZ_SNAPSHOT_KEY, "json");
      if (snap && Array.isArray(snap.businesses)) {
        return json(snap.businesses);
      }

      const rebuilt = await refreshBusinessesSnapshot();
      return json(rebuilt);
    }

    // ===========================
    // POST /admin/security-mode
    // Body: { biz, mode }
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

      await env.ENROLL_TOKENS.put(key, JSON.stringify(cfg));
      refreshBusinessesSnapshotInBackground();

      return json({ ok: true, biz, mode });
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
// Final fallback: unnamed buildings are "Main"
if (!displayName) {
  displayName = "Main";
}



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
        
          // Seed bldcfg so admin shows proper name going forward
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

    const map = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");
    let label = "";
    let doorSlug = map?.doorSlug || "";

    if (map?.businessCode && map?.buildingCode && map?.doorSlug) {
      const key = `door:${map.businessCode}:${map.buildingCode}:${map.doorSlug}`;
      const rec = await env.REPORTS_KV.get(key, "json");
      if (rec) {
        label = rec.displayLabel || rec.doorLabel || "";
        if (!doorSlug && rec.doorSlug) doorSlug = String(rec.doorSlug);
      }
    }

    matches.push({
      uid,
      source,
      businessCode: map?.businessCode || "",
      buildingCode: map?.buildingCode || "",
      doorSlug,
      label,
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
  do {
    const list = await env.REPORTS_KV.list({ prefix: "door:", cursor, limit: 200 });
    for (const { name } of list.keys) {
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

      const doorIndex = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");

      matches.push({
        uid,
        source: "door_deep",
        businessCode,
        buildingCode,
        doorSlug,
        label: labelRaw,
        hasDoorIndex: !!doorIndex,
      });
      seenUid.add(uidNorm);

      if (matches.length >= 50) break;
    }
    cursor = list.cursor;
  } while (cursor && matches.length < 50);

  return json({ ok: true, q, matches });
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
