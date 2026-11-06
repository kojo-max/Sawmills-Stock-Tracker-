// Team: invite people by email, change what they can do, remove them. Admins only.
// Netlify gives functions a short-lived Identity admin token in globalThis.netlifyIdentityContext
// (the same one its own @netlify/identity package uses).
import { roleOf, whoIs, scopeOf, PANELS, DEFAULT_PANELS, identityUrl } from "../lib/common.mjs";

const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const ROLES = ["limited", "viewer", "manager", "admin"];
// Clean up what the page sends for a limited person: shows and panels.
function cleanScope(sc) {
  const events = sc?.events === "all" ? "all" : (Array.isArray(sc?.events) ? sc.events : []).slice(0, 50).map((e) => ({
    id: String(e.id), name: String(e.name || "Show").slice(0, 120), start: Number(e.start) || null, end: Number(e.end) || null,
  })).filter((e) => e.id);
  const panels = (Array.isArray(sc?.panels) ? sc.panels : DEFAULT_PANELS).filter((p) => PANELS.includes(p));
  return { events, panels: panels.length ? panels : DEFAULT_PANELS };
}

export default async (req) => {
  const ctx = globalThis.netlifyIdentityContext;
  const identity = process.env.IDENTITY_ADMIN_TOKEN
    ? { url: process.env.IDENTITY_URL, token: process.env.IDENTITY_ADMIN_TOKEN } // local testing only
    : { url: ctx?.url || identityUrl(req), token: ctx?.token };
  if (!identity?.url || !identity?.token) return out(503, { error: "identity_off", detail: "Sign-in isn't switched on for this site yet (Netlify Identity)." });

  // who's asking
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const who = await whoIs(req, token);
  if (who.error) return out(who.error.status, await who.error.json());
  const me = who.user;
  if (roleOf(me) !== "admin") return out(403, { error: "forbidden", detail: "Only admins can manage the team." });

  const admin = async (path, init = {}) => {
    const res = await fetch(identity.url + path, { ...init, headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" } });
    const text = await res.text();    if (!res.ok) console.error("identity call failed", init.method || "GET", identity.url + path, res.status, text.slice(0, 300));
    let body; try { body = JSON.parse(text); } catch { body = { msg: text }; }
    if (!res.ok) { const e = new Error(body.msg || body.error_description || body.error || `Identity ${res.status}`); e.status = res.status; throw e; }
    return body;
  };
  const shape = (u) => ({
    id: u.id,
    email: u.email,
    name: u.user_metadata?.full_name || null,
    role: roleOf(u),
    status: u.confirmed_at ? "active" : "invited",
    invited_at: u.invited_at || null,
    last_sign_in: u.last_sign_in_at || null,
    you: (u.email || "").toLowerCase() === (me.email || "").toLowerCase(),
    scope: roleOf(u) === "limited" ? scopeOf(u, "limited") : null,
  });
  const setRole = (id, role, scope) => admin(`/admin/users/${id}`, { method: "PUT", body: JSON.stringify({ app_metadata: { roles: role === "viewer" ? [] : [role], scope: null } }) });

  try {
    let body = {};
    if (req.method !== "GET") { try { body = await req.json(); } catch {} }
    switch (req.method) {
      case "GET": {
        const r = await admin("/admin/users?per_page=500");
        return out(200, { users: (r.users || []).map(shape).sort((a, b) => (a.email || "").localeCompare(b.email || "")) });
      }
      case "POST": {
        const email = String(body.email || "").trim().toLowerCase();
        const role = ROLES.includes(body.role) ? body.role : "viewer";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return out(400, { error: "bad_request", detail: "That doesn't look like an email address." });
        const invited = await admin("/invite", { method: "POST", body: JSON.stringify({ email }) });
        if (invited?.id && role !== "viewer") await setRole(invited.id, role, body.scope);
        return out(200, { ok: true, user: invited?.id ? shape({ ...invited, app_metadata: { roles: role === "viewer" ? [] : [role], scope: null } }) : null });
      }
      case "PUT": {
        if (!body.id || !ROLES.includes(body.role)) return out(400, { error: "bad_request", detail: "Pick a person and a role." });
        if (body.id === me.id) return out(400, { error: "bad_request", detail: "You can't change your own role." });
        await setRole(body.id, body.role, body.scope);
        return out(200, { ok: true });
      }
      case "DELETE": {
        if (!body.id) return out(400, { error: "bad_request", detail: "Pick a person to remove." });
        if (body.id === me.id) return out(400, { error: "bad_request", detail: "You can't remove yourself." });
        await admin(`/admin/users/${body.id}`, { method: "DELETE" });
        return out(200, { ok: true });
      }
      default:
        return out(405, { error: "method" });
    }
  } catch (err) {
    const msg = /already been registered|already registered|exists/i.test(err.message) ? "That email already has an account." : err.message;
    return out(err.status && err.status < 500 ? err.status : 502, { error: "identity", detail: msg });
  }
};

export const config = { path: "/api/team" };
