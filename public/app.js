/* App shell for Sawmills Stock: sign-in (Netlify Identity), shows, tabs, team. */
"use strict";
const TZ = "Europe/London";
const HOUR = 3600000;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => Math.round(n).toLocaleString("en-GB");
const gbp = (n, dp = 0) => (n < 0 ? "−£" : "£") + Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const hhmm = (ms) => timeFmt.format(new Date(ms));
const dayLabel = (ms) => dateFmt.format(new Date(ms));

const state = { mode: null, me: null, shows: [], event: null, view: "stock" };
// "limited" = the stock team. Managers and admins can change things and see costs. Viewers can look.
const canEdit = () => state.me?.role === "manager" || state.me?.role === "admin";
const limited = () => state.me?.role === "limited";
const can = () => true;

function setShows(list) {
  state.shows = (list || []).map((s) => ({ ...s }));
  const n = Date.now();
  state.event = state.shows.find((s) => s.start - 2 * HOUR <= n && n <= s.end + 4 * HOUR)
    || state.shows.filter((s) => s.start > n).sort((a, b) => a.start - b.start)[0]
    || [...state.shows].sort((a, b) => b.start - a.start)[0] || null;
}
// Recent shows and everything coming up, oldest first
function stockShows() {
  const n = Date.now();
  return state.shows.filter((s) => s.end > n - 14 * 24 * HOUR).sort((a, b) => a.start - b.start);
}

async function accessToken() {
  const u = window.netlifyIdentity?.currentUser();
  if (!u) return null;
  try { return await u.jwt(); } catch { return null; }
}
async function api(path, opts = {}) {
  const headers = {};
  const tok = await accessToken();
  if (tok) headers.Authorization = "Bearer " + tok;
  if (opts.body) headers["content-type"] = "application/json";
  let res;
  try { res = await fetch(path, { ...opts, headers, cache: "no-store" }); }
  catch { throw new Error("Can't reach the server. Check your signal and try again."); }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("The server didn't answer properly.");
  const body = await res.json();
  if (!res.ok) {
    if (body.error === "auth") { signedOut(); }
    const err = new Error(body.detail || body.error || "HTTP " + res.status); err.status = res.status; throw err;
  }
  return body;
}

/* ---------- sign-in ---------- */
function showSignin(on) { $("#signin").hidden = !on; $("#app").hidden = on; }
function signedOut() { state.me = null; showSignin(true); }
async function start(user) {
  if (!user) return showSignin(true);
  try { state.me = await api("/api/auth"); }
  catch (e) { showSignin(true); $("#signin-msg").textContent = e.message; return; }
  showSignin(false);
  $("#who").textContent = state.me.role === "limited" ? "Stock team" : state.me.role[0].toUpperCase() + state.me.role.slice(1);
  state.mode = "live";
  if (window.openStockHub) window.openStockHub();
}
function boot() {
  const ni = window.netlifyIdentity;
  if (!ni) { $("#signin-msg").textContent = "The sign-in service didn't load. Check your connection and refresh."; return; }
  ni.on("init", (u) => start(u));
  ni.on("login", (u) => { ni.close(); start(u); });
  ni.on("logout", () => signedOut());
  ni.init();
}
$("#signin-btn").addEventListener("click", () => netlifyIdentity.open("login"));

/* ---------- team (admins) ---------- */
const ROLE_NAME = { limited: "Stock team", viewer: "Viewer", manager: "Manager", admin: "Admin" };
async function loadTeam() {
  const box = $("#team-body");
  box.innerHTML = `<p class="sub">Loading…</p>`;
  try {
    const { users } = await api("/api/team");
    box.innerHTML = `
      <form class="sk2-form" id="team-invite"><div class="sk2-row2">
        <label>Email<input name="email" type="email" required></label>
        <label>What they can do<select name="role"><option value="limited">Stock team: log deliveries, counts, wastage. No costs.</option><option value="viewer">Viewer: see everything, change nothing</option><option value="manager">Manager: costs, GP, products, shows</option><option value="admin">Admin: also manages the team</option></select></label></div>
        <div class="btns"><button class="btn primary" type="submit">Send invite</button><span class="statline" id="team-msg"></span></div></form>
      <div class="sk2-list">${users.map((u) => `<div class="sk2-item"><header><h3>${esc(u.email)} ${u.you ? `<span class="sub">(you)</span>` : ""}</h3><div class="sk2-badges"><span class="chip neutral">${u.status}</span>
        ${u.you ? `<span class="chip good">${ROLE_NAME[u.role]}</span>` : `<select data-team-role="${esc(u.id)}">${Object.entries(ROLE_NAME).map(([k, l]) => `<option value="${k}"${u.role === k ? " selected" : ""}>${l}</option>`).join("")}</select><button class="btn small danger" data-team-del="${esc(u.id)}">Remove</button>`}</div></header></div>`).join("")}</div>`;
  } catch (e) { box.innerHTML = `<p class="statline bad">${esc(e.message)}</p>`; }
}
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "team-invite") return;
  e.preventDefault();
  const fd = new FormData(e.target), msg = $("#team-msg");
  msg.textContent = "Sending…";
  try { await api("/api/team", { method: "POST", body: JSON.stringify({ email: fd.get("email"), role: fd.get("role") }) }); await loadTeam(); $("#team-msg").textContent = "Invite sent."; }
  catch (er) { msg.textContent = er.message; msg.className = "statline bad"; }
});
document.addEventListener("change", async (e) => {
  const r = e.target.closest?.("[data-team-role]");
  if (!r) return;
  try { await api("/api/team", { method: "PUT", body: JSON.stringify({ id: r.dataset.teamRole, role: r.value }) }); } catch (er) { alert(er.message); loadTeam(); }
});
document.addEventListener("click", async (e) => {
  const d = e.target.closest?.("[data-team-del]");
  if (!d || !confirm("Remove this person?")) return;
  try { await api("/api/team", { method: "DELETE", body: JSON.stringify({ id: d.dataset.teamDel }) }); loadTeam(); } catch (er) { alert(er.message); }
});

window.addEventListener("load", boot);
