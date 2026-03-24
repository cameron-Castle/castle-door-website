export async function onRequestPost(context) {
  const { request, env } = context;

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const mode = String(body?.mode || "guided").trim().toLowerCase() === "custom" ? "custom" : "guided";
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  const phone = String(body?.phone || "").trim();
  const company = String(body?.company || "").trim();
  const doorType = String(body?.doorType || "").trim();
  const woodSpecies = String(body?.woodSpecies || "").trim();
  const frameType = String(body?.frameType || "").trim();
  const fireRated = Boolean(body?.fireRated);
  const frameDepth = String(body?.frameDepth || "").trim();
  const wallTypeDetails = String(body?.wallTypeDetails || "").trim();
  const needsVisionKitReference = Boolean(body?.needsVisionKitReference);
  const timeline = String(body?.timeline || "").trim();
  const guidedNotes = String(body?.guidedNotes || "").trim();
  const customScope = String(body?.customScope || "").trim();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !emailRegex.test(email)) {
    return json({ error: "Valid name and email are required" }, 400);
  }

  if (mode === "custom" && !customScope) {
    return json({ error: "Custom scope is required for custom quote mode" }, 400);
  }

  const resendApiKey = String(env?.RESEND_API_KEY || "").trim();
  const resendFrom = String(env?.RESEND_FROM || "").trim();
  const quoteTo = String(env?.QUOTE_TO_EMAIL || "Cameron@castledoorandhardware.com").trim();

  if (!resendApiKey || !resendFrom || !quoteTo) {
    return json({ error: "Quote email service is not configured" }, 500);
  }

  const esc = (v) =>
    String(v || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const sourceHost = (() => {
    try {
      return new URL(request.url).host;
    } catch {
      return "unknown-host";
    }
  })();

  const subject =
    mode === "guided"
      ? `[Quote Request] Guided build - ${name}${company ? ` (${company})` : ""}`
      : `[Quote Request] Custom request - ${name}${company ? ` (${company})` : ""}`;

  const guidedHtml = `
    <h3>Guided Build Selections</h3>
    <ul>
      <li><strong>Door Type:</strong> ${esc(doorType || "(not specified)")}</li>
      <li><strong>Wood Species:</strong> ${esc(woodSpecies || "(not specified)")}</li>
      <li><strong>Frame Type:</strong> ${esc(frameType || "(not specified)")}</li>
      <li><strong>Fire Rated:</strong> ${esc(fireRated ? "Yes" : "No / not specified")}</li>
      <li><strong>Frame Depth:</strong> ${esc(frameDepth || "(not specified)")}</li>
      <li><strong>Wall Type / Opening Details:</strong> ${esc(wallTypeDetails || "(not specified)")}</li>
      <li><strong>Vision Kit Chart Requested:</strong> ${esc(needsVisionKitReference ? "Yes" : "No")}</li>
      <li><strong>Timeline:</strong> ${esc(timeline || "(not specified)")}</li>
    </ul>
    <p><strong>Project Notes:</strong><br/>${esc(guidedNotes || "(none)")}</p>
  `;

  const customHtml = `
    <h3>Custom Quote Scope</h3>
    <p>${esc(customScope || "(none)")}</p>
  `;

  const html = `
    <h2>New Website Quote Request</h2>
    <p><strong>Mode:</strong> ${esc(mode)}</p>
    <hr />
    <h3>Customer Contact</h3>
    <ul>
      <li><strong>Name:</strong> ${esc(name)}</li>
      <li><strong>Email:</strong> ${esc(email)}</li>
      <li><strong>Phone:</strong> ${esc(phone || "(not provided)")}</li>
      <li><strong>Company:</strong> ${esc(company || "(not provided)")}</li>
    </ul>
    <hr />
    ${mode === "guided" ? guidedHtml : customHtml}
    <hr />
    <p style="color:#64748b;font-size:12px;">Source host: ${esc(sourceHost)}</p>
  `;

  const text = [
    "New Website Quote Request",
    `Mode: ${mode}`,
    "",
    "Customer Contact",
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || "(not provided)"}`,
    `Company: ${company || "(not provided)"}`,
    "",
    mode === "guided" ? "Guided Build Selections" : "Custom Quote Scope",
    mode === "guided"
      ? [
          `Door Type: ${doorType || "(not specified)"}`,
          `Wood Species: ${woodSpecies || "(not specified)"}`,
          `Frame Type: ${frameType || "(not specified)"}`,
          `Fire Rated: ${fireRated ? "Yes" : "No / not specified"}`,
          `Frame Depth: ${frameDepth || "(not specified)"}`,
          `Wall Type / Opening Details: ${wallTypeDetails || "(not specified)"}`,
          `Vision Kit Chart Requested: ${needsVisionKitReference ? "Yes" : "No"}`,
          `Timeline: ${timeline || "(not specified)"}`,
          `Project Notes: ${guidedNotes || "(none)"}`,
        ].join("\n")
      : `Scope: ${customScope || "(none)"}`,
    "",
    `Source host: ${sourceHost}`,
  ].join("\n");

  try {
    const send = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [quoteTo],
        reply_to: email,
        subject,
        html,
        text,
      }),
    });

    if (!send.ok) {
      const errText = await send.text();
      return json({ error: "Resend rejected quote email", details: errText.slice(0, 500) }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    return json({ error: "Failed to send quote email", details: String(err?.message || err) }, 500);
  }
}

