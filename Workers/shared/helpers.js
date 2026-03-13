export const slug = (s = "") =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";

export const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();

export const isValidEmail = (value = "") =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

export const normalizePortalRole = (value = "") => {
  const role = String(value || "").trim().toLowerCase();
  return role === "manager" ? "manager" : "member";
};

export const splitEmailList = (value = "", options = {}) => {
  const { validate = true, validator = isValidEmail } = options;
  const seen = new Set();
  const out = [];
  for (const raw of String(value || "").split(",")) {
    const email = String(raw || "").trim().toLowerCase();
    if (!email) continue;
    if (validate && !validator(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
};

export const parseCookies = (header, options = {}) => {
  const { decode = true } = options;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    if (!decode) {
      out[k] = v;
      return;
    }
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  });
  return out;
};

export const getCookieValues = (header, name, options = {}) => {
  const { decode = true } = options;
  if (!header || !name) return [];
  const values = [];
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    if (k !== name) return;
    const v = part.slice(idx + 1).trim();
    if (!v) return;
    if (!decode) {
      values.push(v);
      return;
    }
    try {
      values.push(decodeURIComponent(v));
    } catch {
      values.push(v);
    }
  });
  return values;
};

export const setCookie = (name, value, options = {}) => {
  const parts = [`${name}=${encodeURIComponent(String(value || ""))}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  else parts.push("SameSite=Lax");
  if (options.secure !== false) parts.push("Secure");
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
};

export const readJsonBody = async (request, options = {}) => {
  const { requireJsonContentType = false } = options;
  if (requireJsonContentType) {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return null;
  }
  try {
    return await request.json();
  } catch {
    return null;
  }
};
