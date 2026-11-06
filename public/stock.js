/* Sawmills Stock: deliveries, riders and vouchers, counts, wastage, GP and next-show orders.
   Uses the helpers in app.js and match.js. */
"use strict";
(function () {
  const C = window.StockCalc;
  const CATS = { beer: "Beer", cider: "Cider & seltzers", wine: "Wine & fizz", spirits: "Spirits & mixers", cocktails: "Cocktails & shots", soft: "Soft drinks", other: "Other" };
  const REASONS = ["Spillage", "Breakage", "Out of date", "Line cleaning / flat", "Over-pour / short pour", "Returned to supplier", "Stolen / missing", "Other"];
  // [key, title, staff only, subtitle for the More menu]
  const TABS = [["overview", "Tonight"], ["delivery", "Deliveries"], ["counts", "Counts"], ["waste", "Wastage"], ["riders", "Riders & vouchers"], ["order", "Next order"], ["gp", "GP", true], ["products", "Products", true], ["shows", "Shows", true]];
  const PRIMARY = ["overview", "delivery", "counts", "waste"];
  const ICON = {
    overview: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    delivery: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
    counts: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM8.5 13l2.2 2.2 4.3-4.6"/>',
    waste: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    riders: '<path d="M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.5 6.6 19.4l1.2-6L3.4 9.3l6-.7z"/>',
    order: '<path d="M6 6h15l-2 9H8zM6 6L5 3H2"/><circle cx="9" cy="19" r="1.5"/><circle cx="18" cy="19" r="1.5"/>',
    gp: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    products: '<path d="M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>',
    shows: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.3c2 .8 3.3 2.7 3.3 5.2"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ""}</svg>`;
  const SK = { palletPct: 80, tab: "overview", ev: null, cat: null, money: false, deliveries: null, show: null, recent: [], loaded: false, busy: false, gp: null, order: null, pending: {}, msg: {}, draft: { lines: 3 }, countType: "opening", countDraft: {}, buffer: 10, override: "" };
  try { const t = JSON.parse(localStorage.getItem("sawmills.skTab")); if (TABS.some((x) => x[0] === t)) SK.tab = t; const b = JSON.parse(localStorage.getItem("sawmills.skBuffer")); if (typeof b === "number" && b >= 0 && b <= 100) SK.buffer = b; const pp = JSON.parse(localStorage.getItem("sawmills.skPallet")); if (typeof pp === "number" && pp >= 0 && pp <= 100) SK.palletPct = pp; } catch {}

  const root = () => document.getElementById("sk-root");
  const staff = () => !limited();                              // managers, admins, viewers: costs and GP
  const writable = () => canEdit() || (limited() && can("stock"));
  const showKey = () => (SK.ev ? SK.ev.id : "");
  const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const fmtQ = (n) => (n == null ? "—" : Math.abs(n - Math.round(n)) < 0.005 ? fmtInt(n) : n.toFixed(2).replace(/0+$/, ""));
  const when = (ms) => `${dayLabel(ms)} ${hhmm(ms)}`;
  const who = (e) => (e ? String(e).split("@")[0] : "");
  const prodById = (id) => SK.cat?.items.find((p) => p.id === id);
  const pname = (id, fallback) => prodById(id)?.name || fallback || "Unknown product";
  const money = (n, dp = 2) => gbp(n, dp);

  /* ---------- network ---------- */
  async function rawPost(path, body, type) {
    const tok = await accessToken();
    const res = await fetch(path, { method: "POST", headers: { ...(tok ? { Authorization: "Bearer " + tok } : {}), "content-type": type || "application/octet-stream" }, body });
    let out = {}; try { out = await res.json(); } catch {}
    if (!res.ok) throw new Error(out.detail || out.error || "Upload failed (" + res.status + ")");
    return out;
  }
  const S = (action, extra = "") => `/api/stock?action=${action}${extra}`;
  const post = (action, body) => api(S(action), { method: "POST", body: JSON.stringify(body) });

  async function loadBase(force) {
    if (SK.loaded && !force) return;
    const [cat, del, recent, sh] = await Promise.all([api(S("catalogue")), api(S("deliveries")), api(S("recent_counts")), api(S("shows"))]);
    setShows(sh.shows || []);
    SK.cat = { items: cat.items || [] }; SK.money = !!cat.canSeeMoney;
    SK.deliveries = del.deliveries || []; SK.recent = recent.counts || [];
    SK.loaded = true;
  }
  async function loadShow(force) {
    const key = showKey(); if (!key) return;
    if (!force && SK.show?.show === key) return;
    SK.show = await api(S("show", "&show=" + encodeURIComponent(key)));
  }

  /* ---------- shows ---------- */
  function shows() { return stockShows(); }
  function pickDefaultShow() {
    if (SK.ev && state.shows.some((s) => s.id === SK.ev.id)) { SK.ev = state.shows.find((s) => s.id === SK.ev.id); return; }
    SK.ev = state.event || shows()[0] || null;
  }
  // Expected serves per product for a show. Managers: the forecast spread over what recent shows actually sold.
  // The stock team reads the plan a manager has published for that show.
  async function mixFor(ev) {
    if (!ev) return null;
    if (staff()) {
      const snaps = ((await api(S("snapshots"))).snapshots || []).filter((x) => x.show !== ev.id && x.start && x.start < ev.start).sort((a, b) => b.start - a.start).slice(0, 3);
      if (!snaps.length || !ev.forecast) return { lines: [], basis: null, forecast: ev.forecast || 0, why: !ev.forecast ? "forecast" : "history" };
      const price = Object.fromEntries(SK.cat.items.map((p) => [p.id, p.price || 0]));
      const acc = {}; let used = 0;
      for (const sn of snaps) {
        const rev = Object.entries(sn.serves).reduce((a, [id, n]) => a + n * (price[id] || 0), 0);
        if (!(rev > 0)) continue;
        used++;
        for (const [id, n] of Object.entries(sn.serves)) acc[id] = (acc[id] || 0) + n * (ev.forecast / rev);
      }
      if (!used) return { lines: [], basis: null, forecast: ev.forecast, why: "prices" };
      const lines = SK.cat.items.filter((p) => acc[p.id]).map((p) => ({ key: C.lineKeyOf(p), name: p.name, units: acc[p.id] / used }));
      const names = snaps.map((x) => (state.shows.find((s) => s.id === x.show) || {}).name).filter(Boolean).join(", ");
      const out = { lines, basis: `last ${used} show${used === 1 ? "" : "s"}${names ? " (" + names + ")" : ""}`, forecast: ev.forecast };
      if (canEdit() && lines.length) post("plan", { show: ev.id, basis: out.basis, lines: lines.map((l) => ({ key: l.key, name: l.name, units: Math.round(l.units) })) }).catch(() => {});
      return out;
    }
    try {
      const p = (await api(S("plan", "&show=" + encodeURIComponent(ev.id)))).plan;
      return p ? { lines: p.lines, basis: p.basis, forecast: 0 } : null;
    } catch { return null; }
  }

  /* ---------- render ---------- */
  function titleOf() { return (SK.tab === "team" ? "Team" : (TABS.find((x) => x[0] === SK.tab) || [0, "Stock"])[1]); }
  function render() {
    const el = root(); if (!el) return;
    renderBar();
    if (state.mode !== "live") { el.innerHTML = `<div class="empty">Stock works with live data.</div>`; return; }
    pickDefaultShow();
    const list = shows();
    const sel = list.length && SK.tab !== "order" ? `<div class="showpick"><select id="sk2-show" aria-label="Show">${list.map((e) => `<option value="${esc(e.id)}"${SK.ev && e.id === showKey() ? " selected" : ""}>${esc(dayLabel(e.start))} · ${esc(e.name)}</option>`).join("")}</select></div>` : "";
    el.innerHTML = `<h1 class="title">${esc(titleOf())}</h1>${sel}<div id="sk2-body">${SK.loaded ? "" : `<p class="sub">Loading…</p>`}</div>`;
    if (SK.loaded) renderTab();
  }
  // Bottom tab bar on phones, sidebar on wide screens (CSS decides). Four tabs plus More, never hidden or disabled.
  function renderBar() {
    const bar = document.getElementById("tabbar"); if (!bar) return;
    const all = TABS.filter((t) => !t[2] || staff());
    const btn = (k, l, cls = "") => `<button type="button" class="${cls}" data-go="${k}"${SK.tab === k ? ' aria-current="page"' : ""}>${svg(k)}<span>${esc(l)}</span></button>`;
    const prim = all.filter((t) => PRIMARY.includes(t[0])).map((t) => btn(t[0], t[1])).join("");
    const sec = all.filter((t) => !PRIMARY.includes(t[0])).map((t) => btn(t[0], t[1], "secondary")).join("");
    const team = state.me?.role === "admin" ? btn("team", "Team", "secondary") : "";
    const inMore = !PRIMARY.includes(SK.tab);
    bar.innerHTML = prim + `<div class="sep secondary"></div>` + sec + team +
      `<button type="button" class="more-btn" data-more${inMore ? ' aria-current="page"' : ""} aria-haspopup="dialog">${svg("more")}<span>More</span></button>` +
      `<button type="button" class="secondary signout-side" data-signout><span>Sign out</span></button>`;
    const menu = document.getElementById("more-menu");
    if (menu) menu.innerHTML = all.filter((t) => !PRIMARY.includes(t[0])).map((t) => `<button type="button" data-go="${t[0]}"><span>${esc(t[1])}</span>${SK.tab === t[0] ? "<small>Open</small>" : ""}</button>`).join("") +
      (team ? `<button type="button" data-go="team"><span>Team</span></button>` : "") + `<button type="button" data-signout><span>Sign out</span><small>${esc(state.me?.email || "")}</small></button>`;
  }
  function go(tab) {
    SK.tab = tab;
    try { if (tab !== "team") localStorage.setItem("sawmills.skTab", JSON.stringify(tab)); } catch {}
    const isTeam = tab === "team";
    document.getElementById("view-stock").hidden = isTeam; document.getElementById("view-team").hidden = !isTeam;
    renderBar();
    if (isTeam) { loadTeam(); return; }
    render(); ensureLoaded();
    window.scrollTo({ top: 0 });
  }
  document.addEventListener("click", (e) => {
    const g = e.target.closest?.("[data-go]");
    if (g && (document.getElementById("tabbar").contains(g) || document.getElementById("more").contains(g))) { document.getElementById("more").close?.(); go(g.dataset.go); return; }
    if (e.target.closest?.("[data-more]")) { document.getElementById("more").showModal?.(); return; }
    if (e.target.closest?.("[data-signout]")) { window.netlifyIdentity?.logout(); return; }
    if (e.target.id === "more") document.getElementById("more").close?.(); // tap outside the sheet
  });
  const body = () => document.getElementById("sk2-body");
  function setMsg(k, text, kind) { SK.msg[k] = { text, kind }; const e = document.getElementById("sk2-msg-" + k); if (e) { e.textContent = text; e.className = "statline" + (kind ? " " + kind : ""); } }
  const msgHtml = (k) => `<span class="statline${SK.msg[k]?.kind ? " " + SK.msg[k].kind : ""}" id="sk2-msg-${k}">${esc(SK.msg[k]?.text || "")}</span>`;

  function renderTab() {
    const b = body(); if (!b) return;
    if (!staff() && ["gp", "products", "shows"].includes(SK.tab)) SK.tab = "overview";
    if (!SK.ev && SK.tab !== "shows") { b.innerHTML = `<div class="empty">${staff() ? "No shows yet. Add one on the Shows tab." : "No shows set up yet. Ask a manager to add one."}</div>`; return; }
    const fn = { overview: tOverview, delivery: tDelivery, riders: tRiders, counts: tCounts, waste: tWaste, gp: tGP, order: tOrder, products: tProducts, shows: tShows }[SK.tab];
    b.innerHTML = fn();
    if (SK.tab === "delivery") initSig();
    if (SK.tab === "gp" && !SK.gp?.running && !SK.gp?.result && SK.gp?.key !== showKey()) runGP();
    if (SK.tab === "order" && !SK.order?.running && SK.order?.key !== showKey()) runOrder();
  }
  const needProducts = () => (SK.cat?.items.length ? "" : `<div class="empty">No products set up yet.${staff() && canEdit() ? " Go to the Products tab and add your lines first." : " Ask a manager to add the product list."}</div>`);

  /* ---------- overview ---------- */
  function showDeliveries() {
    const ev = SK.ev; if (!ev) return [];
    const lo = ev.start - 18 * HOUR, hi = (ev.end || ev.start + 8 * HOUR) + 12 * HOUR;
    return (SK.deliveries || []).filter((d) => d.show === showKey() || (!d.show && d.at >= lo && d.at <= hi));
  }
  function tOverview() {
    const sd = SK.show || { counts: [], waste: [], riders: [] };
    const opening = sd.counts.find((c) => c.type === "opening"), closing = sd.counts.find((c) => c.type === "closing");
    const dels = showDeliveries();
    const wasteU = sd.waste.length;
    const wasteVal = SK.money ? sd.waste.reduce((a, w) => a + w.qty * (prodById(w.productId)?.cost || 0), 0) : null;
    const riders = sd.riders.filter((r) => r.kind !== "voucher");
    const vouchers = sd.riders.filter((r) => r.kind === "voucher");
    const unsigned = dels.filter((d) => !d.hasSignature || (d.video && d.video.status !== "ready"));
    const todo = [
      [!!opening, "Opening count done", opening ? `${when(opening.at)} by ${who(opening.by)}` : "Before doors"],
      [dels.length > 0, "Deliveries logged", dels.length ? `${dels.length} for this show` : "Log each one with signature and video"],
      [!unsigned.length, "Every delivery signed and filmed", unsigned.length ? `${unsigned.length} missing a signature or video` : ""],
      [riders.length > 0 || vouchers.length > 0, "Riders and vouchers entered", `${riders.length} rider lines, ${vouchers.length} voucher lines`],
      [!!closing, "Closing count done", closing ? `${when(closing.at)} by ${who(closing.by)}` : "After close, before anyone leaves"],
    ];
    const g = SK.gp?.key === showKey() && SK.gp.result;
    const k = (a, v, s) => `<div class="sk2-kpi"><div class="k">${a}</div><b>${v}</b><small>${s || ""}</small></div>`;
    return `<div class="sk2-grid">
      ${k("Deliveries", fmtInt(dels.length), "this show")}
      ${k("Wastage entries", fmtInt(wasteU), wasteVal != null ? money(wasteVal, 0) + " at cost" : "")}
      ${k("Riders / comps", fmtInt(riders.length), `${vouchers.length} voucher lines`)}
      ${staff() ? k("Theoretical GP", g && g.theoPct != null ? (g.theoPct * 100).toFixed(1) + "%" : "—", g ? money(g.theoGP, 0) : "open the GP tab") : ""}
      ${staff() ? k("Actual GP", g && g.actualPct != null && g.complete ? (g.actualPct * 100).toFixed(1) + "%" : "—", g && g.complete ? money(g.actualGP, 0) : "needs both counts") : ""}
    </div>
    <ul class="sk2-todo">${todo.map(([d, t, s]) => `<li><span class="sk2-tick${d ? " done" : ""}">${d ? "✓" : ""}</span><span><b>${t}</b> <span class="sub">${esc(s)}</span></span></li>`).join("")}</ul>
    ${needProducts()}`;
  }

  /* ---------- deliveries ---------- */
  function productOptions(selected) {
    const groups = {};
    for (const p of SK.cat.items) (groups[p.cat] ||= []).push(p);
    return `<option value="">Choose product…</option>` + Object.keys(groups).map((c) => `<optgroup label="${esc(CATS[c] || c)}">${groups[c].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${esc(p.id)}"${p.id === selected ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`).join("");
  }
  function lineRow(i) {
    return `<div class="sk2-line${SK.money ? "" : " nomoney"}" data-line>
      <label>Product<select data-f="p">${productOptions("")}</select></label>
      <label>Qty<input data-f="q" type="number" inputmode="decimal" min="0" step="any" placeholder="0"></label>
      ${SK.money ? `<label>Unit cost £<input data-f="c" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00"></label>` : ""}
      <button type="button" class="btn small" data-rm-line aria-label="Remove line">✕</button></div>`;
  }
  function tDelivery() {
    if (!SK.cat.items.length) return needProducts();
    const suppliers = [...new Set([...SK.cat.items.map((p) => p.supplier), ...(SK.deliveries || []).map((d) => d.supplier)].filter(Boolean))];
    const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const me = state.me?.name || who(state.me?.email) || "";
    const form = writable() ? `<form class="sk2-form" id="dl-form" autocomplete="off">
      <div class="sk2-row2">
        <label>Supplier<input name="supplier" list="dl-sup" required><datalist id="dl-sup">${suppliers.map((s) => `<option value="${esc(s)}">`).join("")}</datalist></label>
        <label>Delivery note no.<input name="ref"></label>
        <label>Date and time<input name="at" type="datetime-local" value="${nowLocal}" data-initial="${nowLocal}"></label>
      </div>
      <div id="dl-lines" class="sk2-list">${[0, 1, 2].map(lineRow).join("")}</div>
      <div><button type="button" class="btn small" id="dl-add">+ Add line</button></div>
      <label>Received by (full name)<input name="receivedBy" value="${esc(me)}" required></label>
      <div><b style="font-size:13px">Signature of the person receiving</b><canvas id="dl-sig" class="sk2-sig"></canvas><button type="button" class="btn small" id="dl-sig-clear" style="margin-top:6px">Clear signature</button></div>
      <label>Film the delivery note and the goods<input name="video" type="file" accept="video/*" capture="environment"><span class="sub">Show the note, then pan the pallets. Under a minute.</span></label>
      <label>Notes (shorts, damages, substitutions)<textarea name="note" rows="2"></textarea></label>
      <div class="btns"><button class="btn primary" type="submit" id="dl-save">Save delivery</button>${msgHtml("dl")}</div>
      <div class="sk2-bar" id="dl-prog" hidden><i style="width:0%"></i></div>
    </form>` : "";
    const list = (SK.deliveries || []).slice(0, 60).map((d) => {
      const v = d.video;
      const badges = `<span class="chip ${d.hasSignature ? "good" : "warn"}">${d.hasSignature ? "Signed" : "No signature"}</span><span class="chip ${v ? (v.status === "ready" ? "good" : "warn") : "neutral"}">${v ? (v.status === "ready" ? "Video" : "Video unfinished") : "No video"}</span>`;
      const total = SK.money ? d.lines.reduce((a, l) => a + l.qty * (l.unitCost || 0), 0) : null;
      return `<div class="sk2-item" data-del="${esc(d.id)}"><header><h3>${esc(d.supplier || "Delivery")} ${d.ref ? `<span class="sub">#${esc(d.ref)}</span>` : ""}</h3><div class="sk2-badges">${badges}</div></header>
        <div class="sub">${when(d.at)} · received by ${esc(d.receivedBy)} · ${d.lines.length} line${d.lines.length === 1 ? "" : "s"}${total ? " · " + money(total) : ""}</div>
        <div id="dd-${esc(d.id)}"></div>
        <div class="btns" style="margin-top:8px"><button class="btn small" data-open-del="${esc(d.id)}">Open</button></div></div>`;
    }).join("");
    return form + `<div class="sk2-list">${list || `<div class="empty">No deliveries logged yet.</div>`}</div>`;
  }
  // Signature pad
  let sigInk = false;
  function initSig() {
    const cv = document.getElementById("dl-sig"); if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr) || 600; cv.height = Math.round(150 * dpr);
    const x = cv.getContext("2d"); x.scale(dpr, dpr); x.lineWidth = 2.2; x.lineCap = "round"; x.strokeStyle = "#111";
    sigInk = false;
    let down = false;
    const pos = (e) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    cv.onpointerdown = (e) => { down = true; cv.setPointerCapture(e.pointerId); const [a, b] = pos(e); x.beginPath(); x.moveTo(a, b); x.lineTo(a + 0.1, b + 0.1); x.stroke(); sigInk = true; e.preventDefault(); };
    cv.onpointermove = (e) => { if (!down) return; const [a, b] = pos(e); x.lineTo(a, b); x.stroke(); e.preventDefault(); };
    cv.onpointerup = cv.onpointercancel = () => { down = false; };
  }
  function clearSig() { const cv = document.getElementById("dl-sig"); if (!cv) return; cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); sigInk = false; initSig(); }

  async function saveDelivery(form) {
    const fd = new FormData(form);
    const lines = [...form.querySelectorAll("[data-line]")].map((r) => {
      const productId = r.querySelector('[data-f="p"]').value, qty = num(r.querySelector('[data-f="q"]').value);
      const costEl = r.querySelector('[data-f="c"]'), typed = costEl ? num(costEl.value) : null;
      return { productId, name: pname(productId), qty, unitCost: typed != null ? typed : prodById(productId)?.cost || 0 };
    }).filter((l) => l.productId && l.qty > 0);
    if (!lines.length) return setMsg("dl", "Add at least one product and quantity.", "bad");
    if (!String(fd.get("receivedBy") || "").trim()) return setMsg("dl", "Who received it? Add a name.", "bad");
    if (!sigInk) return setMsg("dl", "Get the receiver to sign first.", "bad");
    const file = form.querySelector('[name="video"]').files[0] || null;
    // Untouched means "now, to the second", so a count made a moment earlier never lands after it
    const atEl = form.querySelector('[name="at"]');
    const at = fd.get("at") && fd.get("at") !== atEl.dataset.initial ? new Date(fd.get("at")).getTime() : Date.now();
    const btn = document.getElementById("dl-save"); btn.disabled = true; setMsg("dl", "Saving…");
    try {
      const r = await post("delivery", {
        supplier: fd.get("supplier"), ref: fd.get("ref"), at, receivedBy: fd.get("receivedBy"), note: fd.get("note"), lines,
        signature: document.getElementById("dl-sig").toDataURL("image/png"), show: showKey(), hasVideo: !!file, videoType: file?.type || "",
      });
      if (file) { SK.pending[r.id] = file; await uploadVideo(r.id, file); }
      setMsg("dl", "Saved.", "ok");
      SK.draft = { lines: 3 };
      await loadBase(true); await loadShow(true); renderTab();
    } catch (e) { setMsg("dl", e.message, "bad"); btn.disabled = false; }
  }
  async function uploadVideo(id, file) {
    const SIZE = 4_000_000, n = Math.ceil(file.size / SIZE);
    if (n > 16) throw new Error("That video is too long (over about 60MB). Film a shorter one.");
    const prog = document.getElementById("dl-prog");
    for (let i = 0; i < n; i++) {
      if (prog) { prog.hidden = false; prog.firstElementChild.style.width = Math.round((i / n) * 100) + "%"; }
      setMsg("dl", `Uploading video ${i + 1} of ${n}…`);
      await rawPost(S("video_chunk", `&id=${id}&n=${i}`), await file.slice(i * SIZE, (i + 1) * SIZE).arrayBuffer());
    }
    await post("delivery_video_done", { id, chunks: n });
    delete SK.pending[id];
  }
  async function openDelivery(id) {
    const box = document.getElementById("dd-" + id); if (!box) return;
    if (box.dataset.open) { box.innerHTML = ""; delete box.dataset.open; return; }
    box.dataset.open = "1"; box.innerHTML = `<p class="sub">Loading…</p>`;
    try {
      const { delivery: d } = await api(S("delivery", "&id=" + id));
      box.innerHTML = `<div class="sk2-detail"><div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Qty</th>${SK.money ? `<th class="num">Unit £</th><th class="num">Line £</th>` : ""}</tr></thead><tbody>
        ${d.lines.map((l) => `<tr><td>${esc(pname(l.productId, l.name))}</td><td class="num">${fmtQ(l.qty)}</td>${SK.money ? `<td class="num">${money(l.unitCost || 0)}</td><td class="num">${money(l.qty * (l.unitCost || 0))}</td>` : ""}</tr>`).join("")}</tbody></table></div>
        ${d.note ? `<p>${esc(d.note)}</p>` : ""}
        <div><div class="sub">Signed by ${esc(d.receivedBy)}</div>${d.signature ? `<img class="sig" alt="Signature" src="${esc(d.signature)}">` : `<p class="sub">No signature saved.</p>`}</div>
        <div id="dv-${id}">${d.video ? (d.video.status === "ready" ? `<button class="btn small" data-play="${id}">Play video of the delivery note</button>` : (SK.pending[id] ? `<button class="btn small" data-retry-video="${id}">Finish uploading the video</button>` : `<span class="sub">The video didn't finish uploading from the phone it was filmed on.</span>`)) : `<span class="sub">No video.</span>`}</div>
        ${canEdit() ? `<div><button class="btn small danger" data-del-delivery="${id}">Delete delivery</button></div>` : ""}</div>`;
    } catch (e) { box.innerHTML = `<p class="statline bad">${esc(e.message)}</p>`; }
  }
  async function playVideo(id) {
    const box = document.getElementById("dv-" + id); if (!box) return;
    box.innerHTML = `<span class="sub">Loading video…</span>`;
    try {
      const tok = await accessToken();
      const res = await fetch(S("video", "&id=" + id), { headers: tok ? { Authorization: "Bearer " + tok } : {} });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Couldn't load the video");
      const url = URL.createObjectURL(await res.blob());
      box.innerHTML = `<video controls playsinline src="${url}"></video>`;
    } catch (e) { box.innerHTML = `<span class="statline bad">${esc(e.message)}</span>`; }
  }

  /* ---------- riders and vouchers ---------- */
  function tRiders() {
    if (!SK.cat.items.length) return needProducts();
    const rs = (SK.show?.riders || []).sort((a, b) => a.at - b.at);
    const form = writable() ? `<form class="sk2-form" id="rd-form" autocomplete="off">
      <div class="sk2-row2">
        <label>Type<select name="kind" id="rd-kind"><option value="rider">Rider (artist)</option><option value="voucher">Vouchers / tokens</option><option value="comp">Comp (promoter, guest list, staff)</option></select></label>
        <label>Who is it for<input name="label" placeholder="Artist, promoter or voucher batch" required></label>
      </div>
      <div class="sk2-row2" id="rd-stock">
        <label>Product<select name="productId">${productOptions("")}</select></label>
        <label id="rd-qty-l">Quantity (stock units)<input name="qty" type="number" min="0" step="any" inputmode="decimal"></label>
      </div>
      <div class="sk2-row2" id="rd-vouch" hidden>
        <label>Issued<input name="issued" type="number" min="0" step="1" inputmode="numeric"></label>
        <label>Redeemed<input name="redeemed" type="number" min="0" step="1" inputmode="numeric"></label>
        <label>Serves per voucher<input name="servesEach" type="number" min="0" step="any" value="1"></label>
        ${SK.money ? `<label>Value each £<input name="valueEach" type="number" min="0" step="any" inputmode="decimal"></label>` : ""}
      </div>
      <label>Note<input name="note" placeholder="e.g. 2 bottles of Don Julio, 24 bottled water, ice"></label>
      <div class="btns"><button class="btn primary" type="submit">Add</button>${msgHtml("rd")}</div>
      <p class="sub">Riders and comps go out at cost. Mark a line <b>Delivered</b> once it's in the dressing room.</p>
    </form>` : "";
    const row = (r) => {
      const isV = r.kind === "voucher";
      const detail = isV ? `${fmtInt(r.issued)} issued · ${fmtInt(r.redeemed)} redeemed${r.valueEach && SK.money ? ` · ${money(r.redeemed * r.valueEach, 0)} face value` : ""}${r.productId ? " · " + esc(pname(r.productId, r.name)) : ""}` : `${fmtQ(r.qty)} × ${esc(pname(r.productId, r.name))}`;
      return `<div class="sk2-item"><header><h3>${esc(r.label)} <span class="chip neutral">${r.kind}</span></h3><div class="sk2-badges">${isV ? "" : `<button class="btn small${r.status === "delivered" ? "" : " primary"}" data-rd-toggle="${esc(r.id)}">${r.status === "delivered" ? "Delivered ✓" : "Mark delivered"}</button>`}${canEdit() ? `<button class="btn small danger" data-rd-del="${esc(r.id)}">✕</button>` : ""}</div></header><div class="sub">${detail}${r.note ? " · " + esc(r.note) : ""}</div></div>`;
    };
    return form + `<div class="sk2-list">${rs.map(row).join("") || `<div class="empty">Nothing entered for this show.</div>`}</div>`;
  }

  /* ---------- counts ---------- */
  function tCounts() {
    if (!SK.cat.items.length) return needProducts();
    const sd = SK.show || { counts: [] };
    const saved = sd.counts.find((c) => c.type === SK.countType);
    const draft = SK.countDraft[showKey() + ":" + SK.countType] || {};
    const opening = sd.counts.find((c) => c.type === "opening");
    const seg = ["opening", "closing", "spot"].map((t) => `<button type="button" data-ctype="${t}" aria-pressed="${SK.countType === t}">${t === "spot" ? "Spot check" : t[0].toUpperCase() + t.slice(1)}</button>`).join("");
    const groups = {};
    for (const p of SK.cat.items) (groups[p.cat] ||= []).push(p);
    const rows = Object.keys(groups).map((c) => `<div class="sk2-cat">${esc(CATS[c] || c)}</div><div class="sk2-cntlist">` + groups[c].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const v = draft[p.id] ?? (saved?.type !== "spot" ? saved?.counts?.[p.id] : undefined) ?? "";
      const hint = SK.countType === "closing" && opening?.counts?.[p.id] != null ? `opened on ${fmtQ(opening.counts[p.id])}` : p.unit;
      return `<div class="sk2-cnt" data-name="${esc(p.name.toLowerCase())}"><div>${esc(p.name)}<small>${esc(hint)}</small></div><div class="stepper"><button type="button" class="step" data-step="-1" aria-label="One fewer ${esc(p.name)}">−</button><input class="sk2-in" data-cnt="${esc(p.id)}" aria-label="${esc(p.name)} count" type="number" inputmode="decimal" min="0" step="any" value="${esc(v)}" placeholder="0"><button type="button" class="step" data-step="1" aria-label="One more ${esc(p.name)}">+</button></div></div>`;
    }).join("") + `</div>`).join("");
    return `<div class="stock-top"><div class="seg" role="group" aria-label="Count type">${seg}</div></div>
      <p class="sub">${saved && SK.countType !== "spot" ? `Saved ${when(saved.at)} by ${esc(who(saved.by))}. Saving again replaces it.` : SK.countType === "opening" ? "Count bar and store before doors. Part bottles as decimals (0.5)." : SK.countType === "closing" ? "Count again after close. Actual GP uses this." : "Spot checks feed the next order."}</p>
      <input class="sk2-in" id="cnt-find" type="search" placeholder="Find a product" aria-label="Find a product">
      ${rows}
      <label class="sk-note" style="margin-top:18px"><b>Note</b><textarea id="cnt-note" rows="2">${esc(saved?.note || "")}</textarea></label>
      ${writable() ? `<div class="sk2-savebar"><button class="btn primary" id="cnt-save">Save ${SK.countType === "spot" ? "spot check" : SK.countType + " count"}</button>${msgHtml("cnt")}</div>` : ""}`;
  }

  /* ---------- wastage ---------- */
  function tWaste() {
    if (!SK.cat.items.length) return needProducts();
    const ws = (SK.show?.waste || []).sort((a, b) => b.at - a.at);
    const total = SK.money ? ws.reduce((a, w) => a + w.qty * (prodById(w.productId)?.cost || 0), 0) : null;
    const form = writable() ? `<form class="sk2-form" id="ws-form" autocomplete="off">
      <div class="sk2-row2">
        <label>Product<select name="productId">${productOptions("")}</select></label>
        <label>How much<input name="qty" type="number" min="0" step="any" inputmode="decimal" required></label>
        <label>In<select name="in"><option value="serves">Serves (pints, shots, glasses)</option><option value="units">Stock units (bottles, kegs, cases)</option></select></label>
        <label>Reason<select name="reason">${REASONS.map((r) => `<option>${r}</option>`).join("")}</select></label>
      </div>
      <label>Note<input name="note"></label>
      <div class="btns"><button class="btn primary" type="submit">Log wastage</button>${msgHtml("ws")}</div></form>` : "";
    return form + (total != null ? `<p class="sub">Logged this show: <b>${money(total)}</b> at cost across ${ws.length} entries.</p>` : "") + `<div class="sk2-list">${ws.map((w) => {
      const p = prodById(w.productId), serves = p ? Math.round(w.qty * p.serves) : null;
      return `<div class="sk2-item"><header><h3>${esc(pname(w.productId, w.name))}</h3><div class="sk2-badges"><span class="chip warn">${esc(w.reason)}</span>${canEdit() ? `<button class="btn small danger" data-ws-del="${esc(w.id)}">✕</button>` : ""}</div></header>
        <div class="sub">${fmtQ(w.qty)} ${esc(p?.unit || "unit")}${serves != null ? ` (${fmtInt(serves)} serves)` : ""}${SK.money && p ? " · " + money(w.qty * p.cost) : ""} · ${hhmm(w.at)} · ${esc(who(w.by))}${w.note ? " · " + esc(w.note) : ""}</div></div>`;
    }).join("") || `<div class="empty">No wastage logged for this show.</div>`}</div>`;
  }

  /* ---------- GP ---------- */
  async function pullUnits(ev) {
    const from = new Date(ev.start - HOUR).toISOString(), to = new Date(Math.min(Date.now(), ev.end + HOUR)).toISOString();
    const out = new Map();
    if (Date.parse(from) >= Date.parse(to)) return out;
    let cursor = null, guard = 0;
    do {
      const q = new URLSearchParams({ action: "units", from, to, keep_from: from, until: to });
      if (cursor) q.set("cursor", cursor);
      const r = await api("/api/square?" + q);
      for (const [n, x] of r.items || []) out.set(n, (out.get(n) || 0) + x);
      cursor = r.cursor;
    } while (cursor && ++guard < 60);
    return out;
  }
  async function soldByProduct(ev) {
    const units = await pullUnits(ev);
    const out = {};
    for (const p of SK.cat.items) { const name = p.line || p.name; out[p.id] = soldFor({ name, key: norm(name) }, units) || 0; }
    return { sold: out, units };
  }
  async function runGP() {
    const key = showKey(), ev = SK.ev;
    if (!ev) return;
    SK.gp = { key, running: true };
    if (SK.tab === "gp") renderTab();
    try {
      await loadShow(true);
      const { sold } = await soldByProduct(ev);
      const mix = null;
      if (canEdit() && Date.now() > ev.end && Object.values(sold).some((n) => n > 0)) post("snapshot", { show: ev.id, start: ev.start, serves: sold }).catch(() => {});
      const sd = SK.show;
      const closing = sd.counts.find((c) => c.type === "closing") || null;
      let opening = sd.counts.find((c) => c.type === "opening") || null, openNote = "";
      if (!opening) {
        const prev = SK.recent.filter((c) => c.type === "closing" && c.show !== key && c.at < ev.start).sort((a, b) => b.at - a.at)[0];
        if (prev) { opening = prev; openNote = `No opening count for this show, so it starts from the closing count on ${when(prev.at)}.`; }
      }
      const lo = opening ? opening.at : 0, hi = closing ? closing.at : Date.now();
      const dels = (SK.deliveries || []).filter((d) => d.at > lo && d.at <= hi).map((d) => ({ ...d, lines: d.lines }));
      const override = num(SK.override);
      const result = C.reconcile({ products: SK.cat.items, opening, closing, deliveries: dels, waste: sd.waste, riders: sd.riders, sold, override });
      SK.gp = { key, result: { ...result, openNote, delCount: dels.length, mixBasis: mix?.basis } };
    } catch (e) { SK.gp = { key, err: e.message }; }
    if (SK.tab === "gp" || SK.tab === "overview") renderTab();
  }
  const pc = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  function tGP() {
    const g = SK.gp;
    const top = `<div class="stock-top"><label class="sub">Net bar takings £ (optional) <input class="sk2-in" id="gp-override" type="number" step="any" min="0" value="${esc(SK.override)}" style="width:140px;display:inline-block" placeholder="from Square"></label><button class="btn small" id="gp-run">Recalculate</button></div>`;
    if (!g || g.running) return top + `<p class="sub">Pulling sales from Square and working it out…</p>`;
    if (g.err) return top + `<p class="statline bad">${esc(g.err)}</p>`;
    const r = g.result;
    if (!SK.cat.items.length) return needProducts();
    const kpi = (a, v, s) => `<div class="sk2-kpi"><div class="k">${a}</div><b>${v}</b><small>${s || ""}</small></div>`;
    const rows = [...r.rows].sort((a, b) => Math.abs(b.varCost || 0) - Math.abs(a.varCost || 0));
    const note = [
      g.result.openNote,
      !r.complete ? "Actual GP needs an opening and a closing count. Until then it assumes no stock went missing, so it matches theoretical." : "",
      r.uncounted ? `${r.uncounted} product${r.uncounted === 1 ? "" : "s"} sold or delivered without a count.` : "",
      r.usedOverride ? "Using the net takings you typed in." : "Revenue is each product's till price (ex VAT) × serves sold. Type in Square's net takings above to use the real figure.",
    ].filter(Boolean).map((x) => `<p class="sub">${esc(x)}</p>`).join("");
    return top + `<div class="sk2-grid">
      ${kpi("Net revenue", money(r.revenue, 0), r.usedOverride ? "typed in" : "from till prices")}
      ${kpi("Theoretical GP", pc(r.theoPct), money(r.theoGP, 0))}
      ${kpi("Actual GP", r.complete ? pc(r.actualPct) : "—", r.complete ? money(r.actualGP, 0) : "needs both counts")}
      ${kpi("GP lost", r.complete ? money(r.gapGP, 0) : "—", r.complete && r.revenue ? ((r.gapGP / r.revenue) * 100).toFixed(1) + " pts of revenue" : "")}
      ${kpi("Wastage logged", money(r.wasteCost, 0), "at cost")}
      ${kpi("Riders / comps", money(r.riderCost, 0), "at cost")}
      ${kpi("Unexplained", r.complete ? money(r.unexplained, 0) : "—", "after wastage and riders")}
    </div>${note}
    <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Open</th><th class="num">+ In</th><th class="num">− Close</th><th class="num">Used</th><th class="num">Should be</th><th class="num">Waste</th><th class="num">Riders</th><th class="num">Missing</th><th class="num">Missing £</th></tr></thead><tbody>
      ${rows.map((x) => {
        const bad = x.varCost != null && (Math.abs(x.varCost) >= 20 || Math.abs(x.varPct || 0) >= 0.1);
        return `<tr><td>${esc(x.name)}</td><td class="num">${fmtQ(x.opening)}</td><td class="num">${fmtQ(x.delivered)}</td><td class="num">${fmtQ(x.closing)}</td><td class="num">${fmtQ(x.actual)}</td><td class="num">${fmtQ(x.theo)}</td><td class="num">${fmtQ(x.waste)}</td><td class="num">${fmtQ(x.riders)}</td><td class="num${bad && x.variance > 0 ? " pos" : x.variance < 0 && bad ? " neg" : ""}">${fmtQ(x.variance)}</td><td class="num${bad && x.varCost > 0 ? " pos" : ""}">${x.varCost == null ? "—" : money(x.varCost, 0)}</td></tr>`;
      }).join("")}</tbody></table></div>
    <p class="sub">Missing = used − should be − wastage − riders. Positive means unexplained loss.</p>
    <div class="btns"><button class="btn small" id="gp-csv">Download CSV</button></div>`;
  }

  /* ---------- next order ---------- */
  async function runOrder() {
    const upcoming = shows().filter((e) => e.start > Date.now() - 6 * HOUR), future = upcoming.filter((e) => e.start > Date.now());
    const ev = SK.order?.forKey ? shows().find((e) => e.id === SK.order.forKey) : future[0] || upcoming[0] || SK.ev;
    const key = showKey();
    SK.order = { key, forKey: ev ? ev.id : null, running: true };
    if (SK.tab === "order") renderTab();
    try {
      const [mix, rec] = await Promise.all([mixFor(ev), api(S("recent_counts"))]);
      SK.recent = rec.counts || SK.recent;
      let planned = {}, edits = {};
      if (ev) {
        try { edits = (await api(S("order_edit", "&show=" + encodeURIComponent(ev.id)))).edit?.qty || {}; } catch {}
        const sd = await api(S("show", "&show=" + encodeURIComponent(ev.id)));
        for (const r of sd.riders) if (r.productId && r.kind !== "voucher" && r.status !== "delivered") planned[r.productId] = (planned[r.productId] || 0) + r.qty;
      }
      SK.order = { key, forKey: ev ? ev.id : null, ev, mix, planned, edits };
    } catch (e) { SK.order = { key, forKey: ev ? ev.id : null, err: e.message }; }
    if (SK.tab === "order") renderTab();
  }
  function orderCalc() {
    const o = SK.order; if (!o?.mix) return null;
    const onHand = C.onHandNow(SK.cat.items, SK.recent, SK.deliveries || []);
    const res = C.predictOrder({ products: SK.cat.items, mixLines: o.mix.lines, onHand, planned: o.planned, buffer: SK.buffer / 100, palletPct: SK.palletPct / 100 });
    // The manager's own quantities win. The suggestion stays visible next to them.
    const edits = o.edits || {};
    for (const r of res.rows) { r.suggested = r.orderUnits; if (edits[r.id] != null) applyEdit(r, edits[r.id]); }
    for (const [id, q] of Object.entries(edits)) {
      if (res.rows.some((r) => r.id === id)) continue;
      const p = SK.cat.items.find((x) => x.id === id); if (!p) continue;
      const pack = Math.max(1, Math.round(Number(p.packSize)) || 1);
      const r = { id, name: p.name, cat: p.cat, supplier: p.supplier || "", unit: p.unit, packSize: pack, forecastServes: 0, need: 0, rider: 0, pallet: p.pallet || 0, palletUp: 0, pallets: 0, onHand: onHand[id]?.qty, cost: Number(p.cost) || 0, suggested: 0, orderUnits: 0, added: true };
      applyEdit(r, q); res.rows.push(r);
    }
    res.rows.sort((a, b) => (a.supplier || "~").localeCompare(b.supplier || "~") || a.name.localeCompare(b.name));
    res.total = res.rows.reduce((a, x) => a + x.est, 0);
    return res;
  }
  function applyEdit(r, q) { r.edited = true; r.orderUnits = Number(q) || 0; r.palletUp = 0; r.pallets = r.pallet > 0 ? Math.floor(r.orderUnits / r.pallet) : 0; r.cases = r.orderUnits / r.packSize; r.est = r.orderUnits * (r.cost || 0); }
  function ordCell(x) {
    const chip = x.edited ? `<span class="chip neutral">${x.added ? "added" : "edited"}</span>` : x.palletUp ? `<span class="chip warn">full pallet, +${fmtQ(x.palletUp)}</span>` : x.pallets > 0 && x.orderUnits > 0 ? `<span class="chip neutral">${fmtQ(x.pallets)} pallet${x.pallets === 1 ? "" : "s"}</span>` : "";
    if (!canEdit()) return `<b>${fmtQ(x.orderUnits)}</b>${chip ? "<br>" + chip : ""}`;
    const sug = x.edited && x.suggested !== x.orderUnits ? `<br><small class="sub">suggested ${fmtQ(x.suggested)} · <a href="#" data-ord-reset="${esc(x.id)}">reset</a></small>` : x.edited ? `<br><small class="sub"><a href="#" data-ord-reset="${esc(x.id)}">reset</a></small>` : "";
    return `<input class="sk2-in ord-qty" type="number" inputmode="decimal" min="0" step="any" data-ord-qty="${esc(x.id)}" aria-label="Order quantity for ${esc(x.name)}" value="${esc(String(Math.round(x.orderUnits * 100) / 100))}" style="width:76px;text-align:right;min-height:44px">${chip ? "<br>" + chip : ""}${sug}`;
  }
  async function saveEdit(qty, reset) {
    const o = SK.order; if (!o?.forKey) return;
    try { const r = await post("order_edit", { show: o.forKey, qty, reset: !!reset }); o.edits = r.edit?.qty || {}; } catch (er) { setMsg("ord", er.message, "bad"); }
    renderTab();
  }
  function tOrder() {
    if (!SK.cat.items.length) return needProducts();
    const o = SK.order;
    const list = shows().filter((e) => e.start > Date.now() - 6 * HOUR);
    const sel = `<div class="showpick"><select id="ord-show" aria-label="Order for">${list.map((e) => `<option value="${esc(e.id)}"${o?.forKey === e.id ? " selected" : ""}>${esc(dayLabel(e.start))} · ${esc(e.name)}</option>`).join("")}</select></div>`;
    const top = `${sel}<div class="stock-top"><label class="sub">Safety stock % <input class="sk2-in" id="ord-buf" type="number" min="0" max="100" step="1" value="${SK.buffer}" style="width:80px;display:inline-block"></label><label class="sub">Round up to a pallet from % <input class="sk2-in" id="ord-pal" type="number" min="0" max="100" step="5" value="${SK.palletPct}" style="width:80px;display:inline-block" aria-describedby="ord-pal-h"></label></div><p class="sub" id="ord-pal-h">Orders at ${SK.palletPct}% of a pallet or more go up to the full pallet. 0 is off.</p>`;
    if (!o || o.running) return top + `<p class="sub">Working out the order…</p>`;
    if (o.err) return top + `<p class="statline bad">${esc(o.err)}</p>`;
    if (!o.mix || !o.mix.lines.length) return top + `<div class="empty">${staff() ? ({ forecast: "This show has no forecast. Add one on the Shows tab.", history: "No past show has sales saved yet. Add a past show on the Shows tab and open its GP tab once. That teaches the order what sells.", prices: "Add the till price per serve on the Products tab so the sales mix can be worked out." }[o.mix?.why] || "Nothing to build the order from yet.") : "A manager hasn't published the plan for this show yet."}</div>`;
    const res = orderCalc();
    const bySup = {};
    for (const r of res.rows) (bySup[r.supplier || "No supplier set"] ||= []).push(r);
    const blocks = Object.entries(bySup).map(([sup, rows]) => {
      const sub = rows.reduce((a, x) => a + x.est, 0);
      return `<div class="sk2-item" style="margin-bottom:10px"><header><h3>${esc(sup)}</h3><div class="sk2-badges">${SK.money ? `<span class="chip neutral">${money(sub, 0)}</span>` : ""}<button class="btn small" data-copy-order="${esc(sup)}">Copy order</button></div></header>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num hide-sm">Forecast serves</th><th class="num hide-sm">Need</th><th class="num">On hand</th><th class="num">Order</th><th class="num hide-sm">Cases</th>${SK.money ? `<th class="num hide-sm">Est £</th>` : ""}</tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${esc(x.name)}${x.rider ? ` <span class="sub">(+${fmtQ(x.rider)} rider)</span>` : ""}</td><td class="num hide-sm">${fmtInt(x.forecastServes)}</td><td class="num hide-sm">${fmtQ(x.need)}</td><td class="num">${x.onHand == null ? "no count" : fmtQ(x.onHand)}</td><td class="num">${ordCell(x)}</td><td class="num hide-sm">${x.packSize > 1 ? fmtQ(x.cases) : "—"}</td>${SK.money ? `<td class="num hide-sm">${money(x.est, 0)}</td>` : ""}</tr>`).join("")}
      </tbody></table></div></div>`;
    }).join("");
    const noCount = res.rows.filter((r) => r.onHand == null && r.need > 0).length;
    return top + `<p class="sub">Based on ${o.mix.basis ? "the " + esc(o.mix.basis) : "the expected sales mix"}${SK.money && o.mix.forecast ? " and a " + money(o.mix.forecast, 0) + " forecast" : ""}, plus ${SK.buffer}% safety stock, less current stock.</p>
      ${noCount ? `<p class="statline bad">${noCount} product${noCount === 1 ? " has" : "s have"} no stock count yet, so the order assumes none on hand. Do a spot check on the Counts tab first.</p>` : ""}
      ${SK.money ? `<div class="sk2-grid"><div class="sk2-kpi"><div class="k">Estimated order</div><b>${money(res.total, 0)}</b><small>at catalogue cost, ex VAT</small></div></div>` : ""}
      ${blocks || `<div class="empty">Nothing to order. Either stock covers the forecast or no products match the sales lines.</div>`}
      ${res.unmatched.length ? `<p class="sub"><b>Selling but not set up as a product:</b> ${res.unmatched.map((l) => `${esc(l.name)} (${fmtInt(l.units)} serves)`).join(", ")}. ${staff() ? "Add them on the Products tab so they're ordered." : "Ask a manager to add them."}</p>` : ""}
      ${canEdit() ? `<div class="stock-top" style="margin-top:14px"><label class="sub">Add a product to this order <span class="showpick" style="display:inline-block"><select id="ord-add" aria-label="Add a product to this order"><option value="">Choose…</option>${SK.cat.items.filter((p) => p.id && !res.rows.some((r) => r.id === p.id)).sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></span></label></div>` : ""}
      <div class="btns"><button class="btn small" id="ord-csv">Download CSV</button>${canEdit() && Object.keys(SK.order.edits || {}).length ? `<button class="btn small" id="ord-reset-all">Reset all to suggested</button>` : ""}${msgHtml("ord")}</div>`;
  }
  function orderText(sup) {
    const res = orderCalc(); if (!res) return "";
    const rows = res.rows.filter((r) => (r.supplier || "No supplier set") === sup && r.orderUnits > 0);
    return `Order for ${SK.order.ev ? SK.order.ev.name + " " + dayLabel(SK.order.ev.start) : "next show"} – ${sup}\n` + rows.map((r) => `- ${r.name}: ${fmtQ(r.orderUnits)} ${r.unit}${r.packSize > 1 ? ` (${fmtQ(r.cases)} case${r.cases === 1 ? "" : "s"} of ${r.packSize})` : ""}${r.palletUp ? ` – rounded up to a full pallet (+${fmtQ(r.palletUp)})` : ""}${r.edited ? ` – edited (suggested ${fmtQ(r.suggested)})` : ""}`).join("\n");
  }

  /* ---------- products ---------- */
  function prodRow(p, i) {
    return `<tr data-prod="${i}"><td><input data-k="name" value="${esc(p.name)}"></td>
      <td><select data-k="cat">${Object.entries(CATS).map(([k, l]) => `<option value="${k}"${p.cat === k ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><input data-k="unit" value="${esc(p.unit)}" list="pr-units"></td>
      <td><input data-k="serves" type="number" step="any" min="0" value="${p.serves}"></td>
      <td><input data-k="packSize" type="number" step="1" min="1" value="${p.packSize}"></td>
      <td><input data-k="cost" type="number" step="any" min="0" value="${p.cost || ""}"></td>
      <td><input data-k="price" type="number" step="any" min="0" value="${p.price || ""}"></td>
      <td><input data-k="line" value="${esc(p.line)}" placeholder="${esc(p.name)}"></td>
      <td><input data-k="supplier" value="${esc(p.supplier)}"></td>
      <td><input data-k="par" type="number" step="any" min="0" value="${p.par || ""}"></td>
      <td><input data-k="pallet" type="number" step="1" min="0" value="${p.pallet || ""}"></td>
      <td><button class="btn small danger" data-pr-del="${i}" aria-label="Remove">✕</button></td></tr>`;
  }
  function tProducts() {
    if (!canEdit()) return `<p class="sub">Only managers can change the product list.</p>`;
    const items = SK.cat.items;
    return `<p class="sub">Serves per unit: 70cl spirit = 28, can = 1. Cost is ex VAT per unit, price is inc VAT per serve. Pallet is units per pallet, blank if none.</p>
      <div class="btns" style="margin-bottom:10px"><button class="btn small" id="pr-add">+ Add product</button><button class="btn small" id="pr-mix">Add lines from this show's till</button><button class="btn small" id="pr-paste-toggle">Paste from a spreadsheet</button><button class="btn primary" id="pr-save">Save products</button>${msgHtml("pr")}</div>
      <div id="pr-paste" hidden class="sk2-form"><label>Columns, in order: name, category, unit, serves per unit, pack size, cost, price per serve, sales line, supplier, par, pallet size<textarea id="pr-paste-text" rows="5" placeholder="Absolut Vodka 70cl&#9;spirits&#9;bottle&#9;28&#9;6&#9;14.50&#9;4.50&#9;Vodka&#9;Bibendum&#9;4"></textarea></label><div class="btns"><button class="btn small" id="pr-paste-go">Add these rows</button></div></div>
      <datalist id="pr-units"><option>bottle</option><option>keg</option><option>case</option><option>can</option><option>box</option><option>cask</option><option>bag-in-box</option></datalist>
      <div class="table-wrap"><table class="sk2-prodtbl"><thead><tr><th>Name</th><th>Category</th><th>Unit</th><th>Serves / unit</th><th>Pack size</th><th>Cost £</th><th>Price £</th><th>Sales line</th><th>Supplier</th><th>Par</th><th>Pallet (units)</th><th></th></tr></thead><tbody id="pr-body">${items.map(prodRow).join("")}</tbody></table></div>`;
  }
  function readProducts() {
    const rows = [...document.querySelectorAll("#pr-body tr")];
    return rows.map((tr, i) => {
      const o = { ...(SK.cat.items[i] || {}) };
      tr.querySelectorAll("[data-k]").forEach((el) => { o[el.dataset.k] = el.type === "number" ? (el.value === "" ? 0 : Number(el.value)) : el.value.trim(); });
      return o;
    });
  }

  /* ---------- shows ---------- */
  const localInput = (ms) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
  function tShows() {
    if (!canEdit()) return `<p class="sub">Only managers can set up shows.</p>`;
    const e = SK.editShow || {};
    const list = [...state.shows].sort((a, b) => b.start - a.start);
    return pullPanel() + `<form class="sk2-form" id="sh-form" autocomplete="off"><input type="hidden" name="showid" value="${esc(e.id || "")}">
      <div class="sk2-row2">
        <label>Show name<input name="name" value="${esc(e.name || "")}" required></label>
        <label>Bar opens<input name="start" type="datetime-local" value="${localInput(e.start)}" required></label>
        <label>Bar closes<input name="end" type="datetime-local" value="${localInput(e.end)}" required></label>
        <label>Takings forecast £ (inc VAT)<input name="forecast" type="number" min="0" step="any" value="${e.forecast || ""}"></label>
      </div>
      <div class="btns"><button class="btn primary" type="submit">${e.id ? "Save changes" : "Add show"}</button>${e.id ? `<button class="btn" type="button" id="sh-cancel">Cancel</button>` : ""}${msgHtml("sh")}</div>
      <p class="sub">The forecast drives the next order.</p></form>
      <div class="sk2-list">${list.map((s) => `<div class="sk2-item"><header><h3>${esc(s.name)}</h3><div class="sk2-badges"><button class="btn small" data-sh-edit="${esc(s.id)}">Edit</button><button class="btn small danger" data-sh-del="${esc(s.id)}">✕</button></div></header><div class="sub">${dayLabel(s.start)} ${hhmm(s.start)}–${hhmm(s.end)}${s.forecast ? " · forecast " + money(s.forecast, 0) : " · no forecast"}${s.src === "sheet" ? " · from the venue sheet" : ""}</div></div>`).join("") || `<div class="empty">No shows yet.</div>`}</div>`;
  }

  /* ---------- forecasts from the venue sheet ---------- */
  const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const clock = (s) => { const m = String(s || "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i); if (!m) return null; let h = +m[1]; const mi = +(m[2] || 0), ap = (m[3] || "").toLowerCase(); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; return h * 60 + mi; };
  const showName = (t) => String(t || "").replace(/^\s*\d{1,2}(st|nd|rd|th)?\s+[A-Za-z]+\s*[-–]\s*/, "").trim() || t;
  function planPull(events) {
    return events.map((ev) => {
      const match = state.shows.find((s) => ymd(s.start) === ev.date) || null;
      const bar = Math.round(Number(ev.barGross) || 0);
      let start = null, end = null;
      if (!match) {
        const [y, mo, d] = ev.date.split("-").map(Number), o = clock(ev.open) ?? 20 * 60, c = clock(ev.close) ?? (3 * 60);
        start = new Date(y, mo - 1, d, 0, o).getTime(); end = new Date(y, mo - 1, d, 0, c + (c <= o ? 24 * 60 : 0)).getTime();
      }
      return { ev, match, bar, start, end, skip: !bar ? "No bar forecast in the sheet" : match && match.forecast === bar ? "Already up to date" : "" };
    });
  }
  function pullPanel() {
    const P = SK.pull;
    const btn = `<div class="btns" style="margin-bottom:12px"><button class="btn" id="sh-pull"${P?.busy ? " disabled" : ""}>${P?.busy ? "Reading the venue sheet…" : "Pull forecasts from the venue sheet"}</button>${msgHtml("pull")}</div>`;
    if (!P?.plan) return btn;
    const todo = P.plan.filter((x) => !x.skip);
    return btn + `<div class="sk2-item" style="margin-bottom:14px"><header><h3>From the venue sheet</h3><div class="sk2-badges"><button class="btn primary small" id="sh-pull-apply"${todo.length ? "" : " disabled"}>Apply ${todo.length}</button><button class="btn small" id="sh-pull-close">Close</button></div></header>
      <div class="sk2-list">${P.plan.map((x) => `<div class="sk2-item"><header><h3>${esc(showName(x.ev.title))}</h3><div class="sk2-badges">${x.skip ? `<span class="chip neutral">${esc(x.skip)}</span>` : x.match ? `<span class="chip warn">updates forecast</span>` : `<span class="chip good">new show</span>`}</div></header><div class="sub">${esc(x.ev.date.split("-").reverse().join("/"))} · bar forecast ${x.bar ? money(x.bar, 0) : "none"}${x.match && x.match.forecast ? " (now " + money(x.match.forecast, 0) + ")" : ""}${x.ev.tickets ? " · " + fmtInt(x.ev.tickets) + " tickets" : ""}</div></div>`).join("") || `<div class="empty">No upcoming shows found in the sheet.</div>`}</div>
      <p class="sub">Reads Forecasted Bar (inc VAT) from each show's tab. Existing shows only get a new forecast.</p></div>`;
  }
  async function pullForecasts() {
    SK.pull = { busy: true }; renderTab();
    try { const r = await api("/api/forecast"); SK.pull = { plan: planPull((r.events || []).filter((e) => e.date)) }; }
    catch (er) { SK.pull = null; renderTab(); setMsg("pull", er.message, "bad"); return; }
    renderTab();
  }
  async function applyPull() {
    const todo = (SK.pull?.plan || []).filter((x) => !x.skip); let upd = 0, add = 0;
    try {
      for (const x of todo) {
        if (x.match) { await post("show_save", { id: x.match.id, name: x.match.name, start: x.match.start, end: x.match.end, forecast: x.bar, src: "sheet", srcTitle: x.ev.title }); upd++; }
        else { await post("show_save", { name: showName(x.ev.title), start: x.start, end: x.end, forecast: x.bar, src: "sheet", srcTitle: x.ev.title }); add++; }
      }
    } catch (er) { setMsg("pull", er.message, "bad"); }
    const sh = await api(S("shows")); setShows(sh.shows || []); SK.pull = null; SK.order = null; render(); await ensureLoaded();
    setMsg("pull", `Done: ${upd} forecast${upd === 1 ? "" : "s"} updated, ${add} show${add === 1 ? "" : "s"} added.`);
  }

  /* ---------- csv ---------- */
  const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  function download(name, rows) {
    const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- events ---------- */
  document.addEventListener("click", async (e) => {
    const el = root(); if (!el || !el.contains(e.target)) return;
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) { go(tab.dataset.tab); return; }
    if (t.closest("#dl-add")) { document.getElementById("dl-lines").insertAdjacentHTML("beforeend", lineRow()); return; }
    if (t.closest("[data-rm-line]")) { const rows = document.querySelectorAll("[data-line]"); if (rows.length > 1) t.closest("[data-line]").remove(); return; }
    if (t.closest("#dl-sig-clear")) return clearSig();
    const she = t.closest("[data-sh-edit]"); if (she) { SK.editShow = state.shows.find((s) => s.id === she.dataset.shEdit); renderTab(); return; }
    if (t.closest("#sh-cancel")) { SK.editShow = null; renderTab(); return; }
    const shd = t.closest("[data-sh-del]");
    if (shd && confirm("Remove this show? Counts and deliveries stay saved.")) { await post("show_delete", { id: shd.dataset.shDel }); const sh = await api(S("shows")); setShows(sh.shows || []); if (SK.ev?.id === shd.dataset.shDel) SK.ev = null; render(); await ensureLoaded(); return; }
    const orr = t.closest("[data-ord-reset]"); if (orr) { e.preventDefault(); await saveEdit({ [orr.dataset.ordReset]: null }); return; }
    if (t.closest("#ord-reset-all")) { await saveEdit({}, true); return; }
    if (t.closest("#sh-pull")) return pullForecasts();
    if (t.closest("#sh-pull-apply")) return applyPull();
    if (t.closest("#sh-pull-close")) { SK.pull = null; renderTab(); return; }
    const st = t.closest("[data-step]");
    if (st) { const inp = st.parentElement.querySelector("input"); inp.value = Math.max(0, Math.round(((Number(inp.value) || 0) + Number(st.dataset.step)) * 100) / 100); inp.dispatchEvent(new Event("input", { bubbles: true })); return; }
    const od = t.closest("[data-open-del]"); if (od) return openDelivery(od.dataset.openDel);
    const pl = t.closest("[data-play]"); if (pl) return playVideo(pl.dataset.play);
    const rv = t.closest("[data-retry-video]");
    if (rv) { const id = rv.dataset.retryVideo; try { rv.disabled = true; await uploadVideo(id, SK.pending[id]); await loadBase(true); renderTab(); } catch (er) { rv.disabled = false; rv.textContent = "Failed: " + er.message; } return; }
    const dd = t.closest("[data-del-delivery]");
    if (dd && confirm("Delete this delivery and its video? This can't be undone.")) { await post("delete", { kind: "delivery", id: dd.dataset.delDelivery }); await loadBase(true); renderTab(); return; }
    const tg = t.closest("[data-rd-toggle]");
    if (tg) { const r = SK.show.riders.find((x) => x.id === tg.dataset.rdToggle); await post("rider", { ...r, status: r.status === "delivered" ? "planned" : "delivered" }); await loadShow(true); renderTab(); return; }
    const rd = t.closest("[data-rd-del]"); if (rd && confirm("Remove this line?")) { await post("delete", { kind: "rider", show: showKey(), id: rd.dataset.rdDel }); await loadShow(true); renderTab(); return; }
    const wd = t.closest("[data-ws-del]"); if (wd && confirm("Remove this wastage entry?")) { await post("delete", { kind: "waste", show: showKey(), id: wd.dataset.wsDel }); await loadShow(true); renderTab(); return; }
    const ct = t.closest("[data-ctype]"); if (ct) { SK.countType = ct.dataset.ctype; renderTab(); return; }
    if (t.closest("#cnt-save")) return saveCount();
    if (t.closest("#gp-run")) { SK.override = document.getElementById("gp-override").value; return runGP(); }
    if (t.closest("#gp-csv")) { const r = SK.gp?.result; if (r) download("stock-gp-" + showKey() + ".csv", [["Product", "Opening", "Delivered", "Closing", "Used", "Should be", "Waste", "Riders", "Missing", "Missing £"], ...r.rows.map((x) => [x.name, x.opening, x.delivered, x.closing, x.actual, x.theo?.toFixed(2), x.waste, x.riders, x.variance?.toFixed(2), x.varCost?.toFixed(2)])]); return; }
    const cp = t.closest("[data-copy-order]");
    if (cp) { const txt = orderText(cp.dataset.copyOrder); try { await navigator.clipboard.writeText(txt); cp.textContent = "Copied ✓"; } catch { prompt("Copy this order", txt); } return; }
    if (t.closest("#ord-csv")) { const res = orderCalc(); if (res) download("order-" + (SK.order.forKey || "next") + ".csv", [["Supplier", "Product", "Unit", "Pack size", "Need", "On hand", "Order units", "Suggested", "Of which pallet top-up", "Cases", "Est £"], ...res.rows.filter((r) => r.orderUnits > 0).map((r) => [r.supplier, r.name, r.unit, r.packSize, r.need.toFixed(2), r.onHand ?? "", r.orderUnits, r.suggested ?? "", r.palletUp || 0, r.cases, r.est.toFixed(2)])]); return; }
    if (t.closest("#pr-add")) { SK.cat.items = readProducts(); SK.cat.items.push({ id: "", name: "", cat: "spirits", unit: "bottle", serves: 1, packSize: 1, cost: 0, price: 0, line: "", supplier: "", par: 0, pallet: 0 }); renderTab(); return; }
    const pd = t.closest("[data-pr-del]"); if (pd) { SK.cat.items = readProducts(); SK.cat.items.splice(+pd.dataset.prDel, 1); renderTab(); return; }
    if (t.closest("#pr-paste-toggle")) { const p = document.getElementById("pr-paste"); p.hidden = !p.hidden; return; }
    if (t.closest("#pr-paste-go")) { const add = C.parsePaste(document.getElementById("pr-paste-text").value); SK.cat.items = [...readProducts(), ...add.map((p) => ({ id: "", ...p, cat: CATS[p.cat] ? p.cat : "other" }))]; renderTab(); setMsg("pr", `${add.length} rows added. Check them and save.`); return; }
    if (t.closest("#pr-mix")) return addFromMix();
    if (t.closest("#pr-save")) return saveProducts();
  });
  async function ensureLoaded() {
    try {
      await loadBase();
      pickDefaultShow();
      if (!SK.ev && staff() && canEdit() && SK.tab !== "shows") { SK.tab = "shows"; render(); }
      await loadShow(SK.tab !== "overview" ? false : true);
      if (SK.tab === "overview" && staff() && SK.gp?.key !== showKey() && !SK.gp?.running) runGP();
      renderTab();
      const sub = document.getElementById("sk2-sub"); if (sub && SK.ev) sub.textContent = SK.ev.start ? `${dayLabel(SK.ev.start)} ${hhmm(SK.ev.start)}` : "";
    } catch (er) { const b = body(); if (b) b.innerHTML = `<p class="statline bad">${esc(er.message)}</p>`; }
  }
  document.addEventListener("change", async (e) => {
    const el = root(); if (!el || !el.contains(e.target)) return;
    const t = e.target;
    if (t.id === "sk2-show") { SK.ev = shows().find((x) => x.id === t.value) || SK.ev; SK.show = null; SK.gp = null; SK.order = null; render(); await ensureLoaded(); return; }
    if (t.id === "ord-show") { SK.order = { forKey: t.value }; runOrder(); return; }
    if (t.dataset?.ordQty) { const v = t.value === "" ? null : Number(t.value); await saveEdit({ [t.dataset.ordQty]: v }); return; }
    if (t.id === "ord-add") { if (t.value) await saveEdit({ [t.value]: 1 }); return; }
    if (t.id === "ord-pal") { SK.palletPct = Math.max(0, Math.min(100, Number(t.value) || 0)); try { localStorage.setItem("sawmills.skPallet", JSON.stringify(SK.palletPct)); } catch {} renderTab(); return; }
    if (t.id === "ord-buf") { SK.buffer = Math.max(0, Math.min(100, Number(t.value) || 0)); try { localStorage.setItem("sawmills.skBuffer", JSON.stringify(SK.buffer)); } catch {} renderTab(); return; }
    if (t.id === "rd-kind") { const v = t.value === "voucher"; document.getElementById("rd-vouch").hidden = !v; document.getElementById("rd-qty-l").hidden = v; return; }
    if (t.dataset.f === "p") { // delivery line: prefill the catalogue cost
      const c = t.closest("[data-line]").querySelector('[data-f="c"]'); const p = prodById(t.value); if (c && p && !c.value) c.value = p.cost || "";
    }
  });
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.matches?.("[data-cnt]")) { (SK.countDraft[showKey() + ":" + SK.countType] ||= {})[t.dataset.cnt] = t.value; }
    if (t.id === "cnt-find") { const q = t.value.toLowerCase(); document.querySelectorAll(".sk2-cnt").forEach((r) => (r.hidden = !!q && !r.dataset.name.includes(q))); }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target; if (!root()?.contains(f)) return;
    e.preventDefault();
    if (f.id === "sh-form") {
      const fd = new FormData(f);
      try {
        const r = await post("show_save", { id: fd.get("showid") || undefined, name: fd.get("name"), start: new Date(fd.get("start")).getTime(), end: new Date(fd.get("end")).getTime(), forecast: num(fd.get("forecast")) || 0 });
        SK.editShow = null; SK.ev = r.show; SK.show = null; SK.gp = null; SK.order = null;
        const sh = await api(S("shows")); setShows(sh.shows || []); render(); await ensureLoaded();
      } catch (er) { setMsg("sh", er.message, "bad"); }
      return;
    }
    if (f.id === "dl-form") return saveDelivery(f);
    if (f.id === "rd-form") {
      const fd = new FormData(f), kind = fd.get("kind"), p = prodById(fd.get("productId"));
      try {
        await post("rider", { show: showKey(), kind, label: fd.get("label"), productId: fd.get("productId"), name: p?.name || "", qty: num(fd.get("qty")) || 0, issued: num(fd.get("issued")) || 0, redeemed: num(fd.get("redeemed")) || 0, servesEach: num(fd.get("servesEach")) || 1, valueEach: num(fd.get("valueEach")) || 0, note: fd.get("note"), status: "planned" });
        await loadShow(true); renderTab(); setMsg("rd", "Added.", "ok");
      } catch (er) { setMsg("rd", er.message, "bad"); }
      return;
    }
    if (f.id === "ws-form") {
      const fd = new FormData(f), p = prodById(fd.get("productId"));
      if (!p) return setMsg("ws", "Pick a product.", "bad");
      const raw = num(fd.get("qty")) || 0, qty = fd.get("in") === "serves" ? raw / (p.serves || 1) : raw;
      try {
        await post("waste", { show: showKey(), productId: p.id, name: p.name, qty, reason: fd.get("reason"), note: fd.get("note"), valueEach: p.cost || 0 });
        await loadShow(true); SK.gp = null; renderTab(); setMsg("ws", "Logged.", "ok");
      } catch (er) { setMsg("ws", er.message, "bad"); }
    }
  });
  async function saveCount() {
    const counts = {};
    document.querySelectorAll("[data-cnt]").forEach((i) => { if (i.value !== "") counts[i.dataset.cnt] = Number(i.value); });
    if (!Object.keys(counts).length) return setMsg("cnt", "Enter at least one count.", "bad");
    const btn = document.getElementById("cnt-save"); btn.disabled = true; setMsg("cnt", "Saving…");
    try {
      await post("count", { show: showKey(), type: SK.countType, counts, note: document.getElementById("cnt-note").value });
      delete SK.countDraft[showKey() + ":" + SK.countType];
      await loadShow(true); const rec = await api(S("recent_counts")); SK.recent = rec.counts || []; SK.gp = null;
      renderTab(); setMsg("cnt", `Saved ${Object.keys(counts).length} lines.`, "ok");
    } catch (er) { setMsg("cnt", er.message, "bad"); btn.disabled = false; }
  }
  async function addFromMix() {
    setMsg("pr", "Reading the till for this show…");
    try {
      const units = await pullUnits(SK.ev);
      const have = new Set(readProducts().map((p) => C.lineKeyOf(p)));
      const sing = [...units.keys()].filter((x) => !bundleOf(x) && !isOpenPrice(x));
      const seen = new Set(), add = [];
      for (const n of units.keys()) {
        if (isOpenPrice(n)) continue;
        const L = lineOf(n, sing);
        if (have.has(L.key) || seen.has(L.key)) continue;
        seen.add(L.key);
        add.push({ id: "", name: L.name, cat: mixCat(L.name), unit: "bottle", serves: 1, packSize: 1, cost: 0, price: 0, line: L.name, supplier: "", par: 0 });
      }
      SK.cat.items = [...readProducts(), ...add]; renderTab();
      setMsg("pr", add.length ? `${add.length} lines added from the till. Fill in serves per unit, cost and price, then save.` : "Nothing new to add.");
    } catch (er) { setMsg("pr", er.message, "bad"); }
  }
  async function saveProducts() {
    const items = readProducts().filter((p) => p.name);
    const seen = new Set();
    for (const p of items) { const k = C.lineKeyOf(p); if (seen.has(k)) return setMsg("pr", `Two products share the sales line "${p.line || p.name}". Give each its own, or sales get counted twice.`, "bad"); seen.add(k); }
    setMsg("pr", "Saving…");
    try { const r = await post("catalogue", { items }); SK.cat.items = r.items; setMsg("pr", `Saved ${r.items.length} products.`, "ok"); renderTab(); setMsg("pr", `Saved ${r.items.length} products.`, "ok"); }
    catch (er) { setMsg("pr", er.message, "bad"); }
  }

  /* ---------- entry point, called by the main page when the tab opens ---------- */
  window.openStockHub = async function () { go(SK.tab === "team" ? "overview" : SK.tab); };
  window.__stockHub = SK;
})();
