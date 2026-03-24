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

  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  const phone = String(body?.phone || "").trim();
  const company = String(body?.company || "").trim();
  const message = String(body?.message || "").trim();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !message || !emailRegex.test(email)) {
    return json({ error: "Valid name, email, and message are required" }, 400);
  }

  const resendApiKey = String(env?.CONTACT_RESEND_API_KEY || env?.RESEND_API_KEY || "").trim();
  const resendFrom = String(env?.CONTACT_RESEND_FROM || env?.RESEND_FROM || "").trim();
  const contactTo = String(env?.CONTACT_TO_EMAIL || env?.QUOTE_TO_EMAIL || "Cameron@castledoorandhardware.com").trim();

  if (!resendApiKey || !resendFrom || !contactTo) {
    return json(
      {
        error:
          "Contact email service is not configured (requires CONTACT_RESEND_API_KEY or RESEND_API_KEY, CONTACT_RESEND_FROM or RESEND_FROM, and CONTACT_TO_EMAIL/QUOTE_TO_EMAIL)",
      },
      500,
    );
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

  const subject = `[Contact Request] ${name}${company ? ` (${company})` : ""}`;

  const html = `
    <h2>New Website Contact Request</h2>
    <ul>
      <li><strong>Name:</strong> ${esc(name)}</li>
      <li><strong>Email:</strong> ${esc(email)}</li>
      <li><strong>Phone:</strong> ${esc(phone || "(not provided)")}</li>
      <li><strong>Company:</strong> ${esc(company || "(not provided)")}</li>
    </ul>
    <p><strong>Message:</strong></p>
    <p>${esc(message).replaceAll("\n", "<br/>")}</p>
    <hr />
    <p style="color:#64748b;font-size:12px;">Source host: ${esc(sourceHost)}</p>
  `;

  const text = [
    "New Website Contact Request",
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || "(not provided)"}`,
    `Company: ${company || "(not provided)"}`,
    "",
    "Message:",
    message,
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
        to: [contactTo],
        reply_to: email,
        subject,
        html,
        text,
      }),
    });

    if (!send.ok) {
      const errText = await send.text();
      return json({ error: "Resend rejected contact email", details: errText.slice(0, 500) }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    return json({ error: "Failed to send contact email", details: String(err?.message || err) }, 500);
  }
}

