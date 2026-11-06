// Shared helpers for the dashboard functions.

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ---------- sign-in (Netlify Identity) ----------
   Every request carries the signed-in person's token. We check it with Netlify Identity
   and work out their role:
     admin   – everything, plus inviting and removing people
     manager – can change forecasts, labour targets and pull door history
     viewer  – can look at everything, can't change anything
     limited – the stock team: logs deliveries, counts, wastage and riders, never sees costs or GP
   Roles are set on the Team tab (stored in Identity as app_metadata.roles).
   Anyone listed in ADMIN_EMAILS is always an admin, so the first person can get in. */

const RANK = { limited: 0, viewer: 1, manager: 2, admin: 3 };
export const PANELS = ["stock"];
export const DEFAULT_PANELS = ["stock"];
const seen = new Map();

export function identityUrl(req) {
  return process.env.IDENTITY_URL || globalThis.netlifyIdentityContext?.url || new URL(req.url).origin + "/.netlify/identity";
}
// Every address the sign-in service might answer on from inside a function, best first.
function identityUrls(req) {
  const list = [process.env.IDENTITY_URL, globalThis.netlifyIdentityContext?.url, new URL(req.url).origin + "/.netlify/identity", process.env.URL && process.env.URL + "/.netlify/identity"];
  return [...new Set(list.filter(Boolean).map((u) => u.replace(/\/+$/, "")))];
}
function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return null; }
}
const fromClaims = (c) => ({ id: c.sub, email: c.email, app_metadata: c.app_metadata || {}, user_metadata: c.user_metadata || {} });
const fromRecord = (u) => ({ id: u.id, email: u.email, app_metadata: u.app_metadata || {}, user_metadata: u.user_metadata || {} });
const timeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

export function roleOf(user) {
  const admins = (process.env.ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (admins.includes(String(user?.email || "").toLowerCase())) return "admin";
  const roles = user?.app_metadata?.roles || [];
  if (roles.includes("admin")) return "admin";
  if (roles.includes("manager")) return "manager";
  if (roles.includes("limited")) return "limited";
  return "viewer";
}

// What a limited person can see. Everyone else sees everything.
//   events: "all" or a list of { id, name, start, end } shows
//   panels: which parts of the Tonight screen
// In this app a "limited" login is the stock team: all shows, stock panel, no costs.
export function scopeOf(user, role) {
  if (role !== "limited") return { all: true };
  return { all: false, events: "all", panels: ["stock"] };
}
export const canPanel = (g, ...ps) => g.scope.all || ps.some((p) => g.scope.panels.includes(p));
export function showFor(g, id) {
  if (g.scope.all || g.scope.events === "all") return { ok: true, ev: null };
  const ev = g.scope.events.find((e) => String(e.id) === String(id));
  return { ok: !!ev, ev };
}
// For someone limited to particular shows: refuse other shows, and pull from/to inside that show's window.
export function clampToShow(g, url) {
  if (g.scope.all || g.scope.events === "all") return null;
  const { ok, ev } = showFor(g, url.searchParams.get("event_id"));
  if (!ok) return json({ error: "forbidden", detail: "This show isn't shared with you." }, 403);
  const lo = (ev.start || 0) - 3 * 3600e3, hi = (ev.end || (ev.start || 0) + 12 * 3600e3) + 5 * 3600e3;
  const from = Date.parse(url.searchParams.get("from") || "");
  url.searchParams.set("from", new Date(Math.max(Number.isNaN(from) ? lo : from, lo)).toISOString());
  const keep = Date.parse(url.searchParams.get("keep_from") || "");
  url.searchParams.set("keep_from", new Date(Math.max(Number.isNaN(keep) ? lo : keep, lo)).toISOString());
  const to = Date.parse(url.searchParams.get("to") || new Date().toISOString());
  url.searchParams.set("to", new Date(Math.min(to, hi)).toISOString());
  return null;
}

const remember = (k, v) => { if (seen.size > 500) seen.clear(); seen.set(k, { ...v, exp: Date.now() + 60000 }); };

// Netlify's edge checks the sign-in token (Authorization header or nf_jwt cookie) and hands this request
// the verified details. We then look the person up with the admin token so role changes and removals
// apply within a minute, not when their token next refreshes.
async function fromNetlify(claims) {
  const ctx = globalThis.netlifyIdentityContext;
  if (!claims.sub || !ctx?.url || !ctx?.token) return { user: fromClaims(claims) };
  const hit = seen.get("id:" + claims.sub);
  if (hit && hit.exp > Date.now()) return hit.gone ? { error: removed() } : { user: hit.user };
  try {
    const res = await fetch(`${ctx.url.replace(/\/+$/, "")}/admin/users/${encodeURIComponent(claims.sub)}`, { headers: { Authorization: `Bearer ${ctx.token}` }, signal: timeout(3000) });
    if (res.ok) { const user = fromRecord(await res.json()); remember("id:" + claims.sub, { user }); return { user }; }
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}));
      if (/not found/i.test(body.msg || body.message || "")) { remember("id:" + claims.sub, { gone: true }); return { error: removed() }; }
    }
  } catch {}
  return { user: fromClaims(claims) }; // lookup unavailable: the verified token details are still good
}
const removed = () => json({ error: "auth", detail: "This account has been removed. Ask an admin if that's a mistake." }, 401);

export async function whoIs(req, token) {
  // 1. Verified details from Netlify for this request
  const ctx = globalThis.netlifyIdentityContext;
  const claims = ctx?.user;
  if (claims && (claims.email || claims.sub)) return fromNetlify(claims);
  if (!token) return { error: json({ error: "auth", detail: "Please sign in." }, 401) };

  // 2. Otherwise ask the sign-in service who this token belongs to, trying each address it might answer on
  const hit = seen.get(token);
  if (hit && hit.exp > Date.now()) return { user: hit.user };
  const urls = identityUrls(req), said = [];
  let off = 0;
  for (const base of urls) {
    let res;
    try { res = await fetch(base + "/user", { headers: { Authorization: `Bearer ${token}` }, signal: timeout(4000) }); }
    catch { said.push("no answer"); continue; }
    if (res.ok) { const user = fromRecord(await res.json()); remember(token, { user }); return { user }; }
    if (res.status === 404) off++;
    said.push(String(res.status));
  }
  if (urls.length && off === urls.length) return { error: json({ error: "identity_off", detail: "Sign-in isn't switched on for this site yet (Netlify Identity)." }, 503) };
  const exp = tokenClaims(token)?.exp;
  if (exp && exp * 1000 < Date.now()) return { error: json({ error: "auth", detail: "Your sign-in has expired. Please sign in again." }, 401) };
  // Short code so a screenshot tells us exactly which step failed
  const code = `ctx ${ctx ? (ctx.url ? "y" : "n") : "0"}, svc ${said.join("/") || "none"}`;
  return { error: json({ error: "auth", detail: `The server couldn't confirm your sign-in [${code}].` }, 401) };
}

export async function guard(req, { need = "viewer" } = {}) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const { user, error } = await whoIs(req, token);
  if (error) return error;
  const role = roleOf(user);
  if (RANK[role] < RANK[need]) {
    return json({ error: "forbidden", detail: need === "admin" ? "Only admins can do that." : need === "manager" ? "You need manager access to change this." : "Your access doesn't include this." }, 403);
  }
  return { user, role, scope: scopeOf(user, role) };
}

export function fail(err) {
  const status = err.status && err.status >= 400 ? err.status : 502;
  return json({ error: err.code || "upstream", detail: err.detail || err.message || String(err) }, status);
}

// Keep each call well inside Netlify's 10 second function limit.
// When time runs out the function returns a cursor and the page asks for the rest.
export function deadline(ms = 6500) {
  const end = Date.now() + ms;
  return () => Date.now() < end;
}

export function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return toMs(Number(v));
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  if (typeof v === "object") {
    return toMs(v.iso ?? v.unixtime ?? v.unix ?? v.timestamp ?? v.utc ?? null);
  }
  return null;
}
