// Liveadminworker.js  (PATCHED)
export default {
  async fetch(request, env) {
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
      // Simple cookie; you can harden later
      return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure`;
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

    const mapWithConcurrency = async (items, worker, chunkSize = 25) => {
      const out = [];
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const rows = await Promise.all(chunk.map(worker));
        out.push(...rows);
      }
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
              <input id="eventNotes" placeholder="Notes (required)" style="min-width:300px"/>
              <button class="btn primary" id="eventAdd">Add Event</button>
              <div class="muted" id="eventResult" style="margin-left:10px;"></div>
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
              <div class="muted">Security placeholder: enrollment/device policy controls will live here.</div>
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
        const panelComments = document.getElementById("panelComments");
        const panelBusiness = document.getElementById("panelBusiness");
        const panelSecurity = document.getElementById("panelSecurity");
      
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

        async function setTab(next){
          activeTab = next;

          tabComments.classList.toggle("active", next === "comments");
          tabBusiness.classList.toggle("active", next === "business");
          tabSecurity.classList.toggle("active", next === "security");

          panelComments.classList.toggle("active", next === "comments");
          panelBusiness.classList.toggle("active", next === "business");
          panelSecurity.classList.toggle("active", next === "security");

          if (next === "business" && !businessLoaded) {
            await load();
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
        };

        tabComments.onclick = () => setTab("comments");
        tabBusiness.onclick = () => setTab("business");
        tabSecurity.onclick = () => setTab("security");
        // ---------- UID Search (partial + multi results) ----------
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
        
            // Render result list with repair buttons when needed
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
        const eventAdd = document.getElementById("eventAdd");
        const eventResult = document.getElementById("eventResult");
        
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
          } catch (e) {
            eventResult.textContent = "Error: " + e.message;
          } finally {
            eventAdd.disabled = false;
          }
        };
        
        
        setTab("comments");
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

          const s = cfg.slug || (name.startsWith("bizcfg:") ? name.slice("bizcfg:".length) : "");
          return {
            slug: s,
            name: cfg.name || s,
            active: cfg.active !== false, // default true
            merged_into: cfg.merged_into || "",
          };
        },
        40
      );

      const businesses = rows.filter(Boolean);

      businesses.sort((a, b) =>
        (a.name || a.slug || "").localeCompare(b.name || b.slug || "")
      );

      return json(businesses);
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

  return json({ ok: true, moved });
}

// =====================================================
// GET /admin/search?q=XXXX
// Partial search across UID + door records
// Returns multiple matches
// =====================================================
if (request.method === "GET" && pathname === "/admin/search") {
  const authErr = requireAdmin();
  if (authErr) return authErr;

  const q = String(url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: true, q: "", matches: [] });

  const qNorm = safeDoorId(q).toLowerCase();

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
    matches.push({
      uid,
      source,
      businessCode: map?.businessCode || "",
      buildingCode: map?.buildingCode || "",
      doorSlug: map?.doorSlug || "",
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

  // ---------- 2) Deep fallback only when fast path finds nothing ----------
  // This catches missing doorIndex pointers, but avoids full-table scans on every search.
  if (!matches.length) {
    cursor = undefined;
    do {
      const list = await env.REPORTS_KV.list({ prefix: "door:", cursor, limit: 200 });
      for (const { name } of list.keys) {
        const rec = await env.REPORTS_KV.get(name, "json");
        if (!rec?.doorId) continue;

        const uid = safeDoorId(rec.doorId);
        const uidNorm = uid.toLowerCase();

        const label = String(rec.displayLabel || rec.doorLabel || "").toLowerCase();
        if (!uidNorm.includes(qNorm) && !label.includes(qNorm)) continue;

        const parts = name.split(":");
        const businessCode = parts[1] || "";
        const buildingCode = parts[2] || "";
        const doorSlug = parts.slice(3).join(":") || "";

        const doorIndex = await env.REPORTS_KV.get(`doorIndex:${uid}`, "json");

        matches.push({
          uid,
          source: "door_deep",
          businessCode,
          buildingCode,
          doorSlug,
          label: rec.displayLabel || rec.doorLabel || uid,
          hasDoorIndex: !!doorIndex,
        });

        if (matches.length >= 50) break;
      }
      cursor = list.cursor;
    } while (cursor && matches.length < 50);
  }

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

  const doorRec = await env.REPORTS_KV.get(doorKey, "json");
  if (!doorRec) {
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
  };

  if (normalizedStatus) {
    newEvent.status = normalizedStatus;
  }

  // Status updates should affect current door status immediately,
  // while admin notes remain history-only.
  const shouldMutateTopLevelStatus =
    Boolean(normalizedStatus) && eventType !== "admin_note";

  if (shouldMutateTopLevelStatus) {
    doorRec.status = normalizedStatus;
  }

  if (!Array.isArray(doorRec.eventHistory)) {
    doorRec.eventHistory = [];
  }

  doorRec.eventHistory.unshift(newEvent);

  // Save updated door record
  await env.REPORTS_KV.put(doorKey, JSON.stringify(doorRec));

  return json({
    ok: true,
    uid,
    event: newEvent,
  });
}

// =====================================================
// POST /admin/set-status
// Body: { uid, status? , severity? }
// Directly mutates door record fields (NO event created)
// - If status === "Flagged", it sets severity="Flagged" (common intent)
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

  const rec = await env.REPORTS_KV.get(doorKey, "json");
  if (!rec) return text("Door record missing", 404);

  const rawStatus = body.status != null ? String(body.status).trim() : "";
  const rawSeverity = body.severity != null ? String(body.severity).trim() : "";

  // If caller says "Flagged" as a status, treat it as severity intent.
  if (rawStatus && rawStatus.toLowerCase() === "flagged") {
    rec.severity = "Flagged";
  } else {
    if (rawStatus) rec.status = rawStatus;
    if (rawSeverity) rec.severity = rawSeverity;
  }

  await env.REPORTS_KV.put(doorKey, JSON.stringify(rec));

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
