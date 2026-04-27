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
  const phoneOptOut = Boolean(body?.phoneOptOut);
  const company = String(body?.company || "").trim();
  const frameWidthIn = Number.isFinite(Number(body?.frameWidthIn)) ? Number(body.frameWidthIn) : null;
  const frameHeightIn = Number.isFinite(Number(body?.frameHeightIn)) ? Number(body.frameHeightIn) : null;
  const sizeWidthIn = Number.isFinite(Number(body?.sizeWidthIn)) ? Number(body.sizeWidthIn) : null;
  const sizeHeightIn = Number.isFinite(Number(body?.sizeHeightIn)) ? Number(body.sizeHeightIn) : null;
  const doorHeightIn = Number.isFinite(Number(body?.doorHeightIn)) ? Number(body.doorHeightIn) : null;
  const sizeAssumed = Boolean(body?.sizeAssumed);
  const doorType = String(body?.doorType || "").trim();
  const woodSpecies = String(body?.woodSpecies || "").trim();
  const frameType = String(body?.frameType || "").trim();
  const fireRated = Boolean(body?.fireRated);
  const frameDepth = String(body?.frameDepth || "").trim();
  const wallTypeDetails = String(body?.wallTypeDetails || "").trim();
  const needsVisionKitReference = Boolean(body?.needsVisionKitReference);
  const quoteRep = String(body?.quoteRep || "").trim().toLowerCase();
  const timeline = String(body?.timeline || "").trim();
  const guidedNotes = String(body?.guidedNotes || "").trim();
  const customScope = String(body?.customScope || "").trim();
  const chatTranscript = Array.isArray(body?.chatTranscript) ? body.chatTranscript : [];
  const cleanedTranscript = chatTranscript
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const roleRaw = String(entry.role || "").toLowerCase();
      const role = roleRaw === "user" ? "User" : roleRaw === "assistant" ? "Assistant" : "Unknown";
      const text = String(entry.text || "").trim();
      if (!text) return null;
      const at = String(entry.at || "").trim();
      return {
        role,
        text: text.slice(0, 2000),
        at: at.slice(0, 80),
      };
    })
    .filter(Boolean)
    .slice(-250);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !emailRegex.test(email)) {
    return json({ error: "Valid name and email are required" }, 400);
  }

  if (mode === "custom" && !customScope) {
    return json({ error: "Custom scope is required for custom quote mode" }, 400);
  }

  const resendApiKey = String(env?.RESEND_API_KEY || "").trim();
  const resendFrom = String(env?.RESEND_FROM || "").trim();
  const quoteTo = "Cameron@castledoorandhardware.com";
  const quoteRepName = "Cameron";

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

  const sourceOrigin = (() => {
    try {
      return new URL(request.url).origin;
    } catch {
      return "";
    }
  })();

  const visionKitImageUrl = sourceOrigin ? `${sourceOrigin}/assets/vision-kit-reference.png` : "";
  let visionKitHtmlSection = "";
  let visionKitTextLine = "";
  let attachments = [];

  if (mode === "guided" && needsVisionKitReference && visionKitImageUrl) {
    try {
      const imgRes = await fetch(visionKitImageUrl);
      if (imgRes.ok) {
        const bytes = new Uint8Array(await imgRes.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);

        attachments.push({
          filename: "vision-kit-reference.png",
          content: base64,
          contentType: "image/png",
          content_id: "vision-kit-reference",
        });

        visionKitHtmlSection = `
          <p><strong>Vision Kit Reference:</strong></p>
          <p><img src="cid:vision-kit-reference" alt="Vision kit style chart A-H" style="max-width:100%;height:auto;border:1px solid #dbe5f1;border-radius:8px;" /></p>
          <p><a href="${esc(visionKitImageUrl)}">Open full-size vision kit image</a></p>
        `;
        visionKitTextLine = `Vision Kit Image URL: ${visionKitImageUrl}`;
      } else {
        visionKitHtmlSection = `
          <p><strong>Vision Kit Reference:</strong></p>
          <p><a href="${esc(visionKitImageUrl)}">Open full-size vision kit image</a></p>
        `;
        visionKitTextLine = `Vision Kit Image URL: ${visionKitImageUrl}`;
      }
    } catch {
      visionKitHtmlSection = `
        <p><strong>Vision Kit Reference:</strong></p>
        <p><a href="${esc(visionKitImageUrl)}">Open full-size vision kit image</a></p>
      `;
      visionKitTextLine = `Vision Kit Image URL: ${visionKitImageUrl}`;
    }
  }

  const subject =
    mode === "guided"
      ? `[Quote Request] Guided build - ${name}${company ? ` (${company})` : ""} [Rep: ${quoteRepName}]`
      : `[Quote Request] Custom request - ${name}${company ? ` (${company})` : ""} [Rep: ${quoteRepName}]`;

  const guidedHtml = `
    <h3>Guided Build Selections</h3>
    <ul>
      <li><strong>Frame Size (W x H):</strong> ${esc(Number.isFinite(frameWidthIn) && Number.isFinite(frameHeightIn) ? `${frameWidthIn} x ${frameHeightIn}` : "(not specified)")}</li>
      <li><strong>Opening Size (W x H):</strong> ${esc(Number.isFinite(sizeWidthIn) && Number.isFinite(sizeHeightIn) ? `${sizeWidthIn} x ${sizeHeightIn}` : "(not specified)")}</li>
      <li><strong>Door Height:</strong> ${esc(Number.isFinite(doorHeightIn) ? `${doorHeightIn} in` : "(not specified)")}</li>
      <li><strong>Size Assumed:</strong> ${esc(sizeAssumed ? "Yes" : "No")}</li>
      <li><strong>Door Type:</strong> ${esc(doorType || "(not specified)")}</li>
      <li><strong>Wood Species:</strong> ${esc(woodSpecies || "(not specified)")}</li>
      <li><strong>Frame Type:</strong> ${esc(frameType || "(not specified)")}</li>
      <li><strong>Fire Rated:</strong> ${esc(fireRated ? "Yes" : "No / not specified")}</li>
      <li><strong>Frame Depth:</strong> ${esc(frameDepth || "(not specified)")}</li>
      <li><strong>Wall Type / Opening Details:</strong> ${esc(wallTypeDetails || "(not specified)")}</li>
      <li><strong>Vision Kit Chart Requested:</strong> ${esc(needsVisionKitReference ? "Yes" : "No")}</li>
      <li><strong>Timeline:</strong> ${esc(timeline || "(not specified)")}</li>
      <li><strong>Assigned Rep:</strong> ${esc(quoteRepName)}</li>
    </ul>
    <p><strong>Project Notes:</strong><br/>${esc(guidedNotes || "(none)")}</p>
    ${visionKitHtmlSection}
  `;

  const customHtml = `
    <h3>Custom Quote Scope</h3>
    <p><strong>Opening Size (W x H):</strong> ${esc(Number.isFinite(sizeWidthIn) && Number.isFinite(sizeHeightIn) ? `${sizeWidthIn} x ${sizeHeightIn}` : "(not specified)")}</p>
    <p>${esc(customScope || "(none)")}</p>
  `;

  const transcriptHtml = cleanedTranscript.length
    ? `
      <hr />
      <h3>Chat Transcript</h3>
      <ol>
        ${cleanedTranscript
          .map((entry) => `<li><strong>${esc(entry.role)}:</strong> ${esc(entry.text)}${entry.at ? ` <span style="color:#64748b">(${esc(entry.at)})</span>` : ""}</li>`)
          .join("")}
      </ol>
    `
    : "";

  const html = `
    <h2>New Website Quote Request</h2>
    <p><strong>Mode:</strong> ${esc(mode)}</p>
    <hr />
    <h3>Customer Contact</h3>
    <ul>
      <li><strong>Name:</strong> ${esc(name)}</li>
      <li><strong>Email:</strong> ${esc(email)}</li>
      <li><strong>Phone:</strong> ${esc(phone || (phoneOptOut ? "(customer opted out)" : "(not provided)"))}</li>
      <li><strong>Company:</strong> ${esc(company || "(not provided)")}</li>
    </ul>
    <hr />
    ${mode === "guided" ? guidedHtml : customHtml}
    ${transcriptHtml}
    <hr />
    <p style="color:#64748b;font-size:12px;">Source host: ${esc(sourceHost)}</p>
  `;

  const transcriptTextBlock = cleanedTranscript.length
    ? [
        "",
        "Chat Transcript",
        ...cleanedTranscript.map((entry) => `- ${entry.role}: ${entry.text}${entry.at ? ` (${entry.at})` : ""}`),
      ].join("\n")
    : "";

  const text = [
    "New Website Quote Request",
    `Mode: ${mode}`,
    "",
    "Customer Contact",
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || (phoneOptOut ? "(customer opted out)" : "(not provided)")}`,
    `Company: ${company || "(not provided)"}`,
    "",
    mode === "guided" ? "Guided Build Selections" : "Custom Quote Scope",
    mode === "guided"
      ? [
          `Frame Size (W x H): ${Number.isFinite(frameWidthIn) && Number.isFinite(frameHeightIn) ? `${frameWidthIn} x ${frameHeightIn}` : "(not specified)"}`,
          `Opening Size (W x H): ${Number.isFinite(sizeWidthIn) && Number.isFinite(sizeHeightIn) ? `${sizeWidthIn} x ${sizeHeightIn}` : "(not specified)"}`,
          `Door Height: ${Number.isFinite(doorHeightIn) ? `${doorHeightIn} in` : "(not specified)"}`,
          `Size Assumed: ${sizeAssumed ? "Yes" : "No"}`,
          `Door Type: ${doorType || "(not specified)"}`,
          `Wood Species: ${woodSpecies || "(not specified)"}`,
          `Frame Type: ${frameType || "(not specified)"}`,
          `Fire Rated: ${fireRated ? "Yes" : "No / not specified"}`,
          `Frame Depth: ${frameDepth || "(not specified)"}`,
          `Wall Type / Opening Details: ${wallTypeDetails || "(not specified)"}`,
          `Vision Kit Chart Requested: ${needsVisionKitReference ? "Yes" : "No"}`,
          ...(visionKitTextLine ? [visionKitTextLine] : []),
          `Timeline: ${timeline || "(not specified)"}`,
          `Assigned Rep: ${quoteRepName}`,
          `Project Notes: ${guidedNotes || "(none)"}`,
        ].join("\n")
      : [`Opening Size (W x H): ${Number.isFinite(sizeWidthIn) && Number.isFinite(sizeHeightIn) ? `${sizeWidthIn} x ${sizeHeightIn}` : "(not specified)"}`, `Scope: ${customScope || "(none)"}`].join("\n"),
    transcriptTextBlock,
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
        ...(attachments.length ? { attachments } : {}),
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

