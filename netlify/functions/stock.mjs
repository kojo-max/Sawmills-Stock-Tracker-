// Stock system: product catalogue, deliveries (with signature and video of the delivery note),
// counts, wastage and riders/vouchers. Stored in its own Netlify Blobs store.
//
// Access:
//   managers and admins   everything, including costs
//   viewers               read everything
//   limited + Stock panel the stock team: can add deliveries, counts, wastage and riders, and read the
//                         catalogue and past records, but never sees costs or prices
import { getStore } from "@netlify/blobs";
import { json, guard, canPanel, showFor } from "../lib/common.mjs";

const ID = /^[a-z0-9]{6,40}$/i;
const SHOW = /^[a-z0-9_\-.]{1,60}$/i;
const CHUNK_MAX = 5_000_000;      // raw bytes per video chunk (Netlify caps a request at about 6MB)
const VIDEO_MAX_CHUNKS = 16;      // about 80MB of video per delivery
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);

function store() {
  try { return getStore({ name: "sawmills-stock", consistency: "strong" }); }
  catch { return getStore("sawmills-stock"); }
}
async function listKeys(s, prefix) {
  const out = [];
  const r = await s.list({ prefix });
  for (const b of r.blobs || []) out.push(b.key);
  return out;
}
async function readAll(s, prefix, limit = 400) {
  const keys = (await listKeys(s, prefix)).slice(-limit * 2);
  const docs = await Promise.all(keys.map((k) => s.get(k, { type: "json" }).catch(() => null)));
  return docs.filter(Boolean);
}

export default async (req) => {
  const g = await guard(req, { need: "limited" });
  if (g instanceof Response) return g;
  const isStaff = g.role !== "limited";
  const canSeeMoney = isStaff;                       // costs and prices
  const canWrite = g.role === "manager" || g.role === "admin" || (g.role === "limited" && canPanel(g, "stock"));
  const canRead = isStaff || canPanel(g, "stock");
  if (!canRead) return json({ error: "forbidden", detail: "Your access doesn't include stock." }, 403);

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  let s;
  try { s = store(); } catch { return json({ error: "storage", detail: "Shared storage isn't available on this deploy." }, 503); }

  // Limited people can only touch shows they've been given
  const showOk = (show) => {
    if (!SHOW.test(show || "")) return false;
    if (g.scope.all || g.scope.events === "all") return true;
    return show.startsWith("tt_") && showFor(g, show.slice(3)).ok;
  };
  const clean = (x) => {
    if (canSeeMoney) return x;
    const { cost, price, unitCost, valueEach, ...rest } = x;
    return rest;
  };

  try {
    /* ---------------- reads ---------------- */
    if (req.method === "GET") {
      switch (action) {
        case "shows": {
          const docs = await readAll(s, "showdef:", 400);
          docs.sort((a, b) => (a.start || 0) - (b.start || 0));
          return json({ shows: docs.map((d) => (isStaff ? d : { ...d, forecast: undefined })), canSeeMoney });
        }
        case "snapshots": {
          // What each past show sold, in serves per product. Used to learn the sales mix for the order.
          if (!isStaff) return json({ error: "forbidden", detail: "Managers only." }, 403);
          return json({ snapshots: await readAll(s, "sales:", 60) });
        }
        case "order_edit": {
          const show = url.searchParams.get("show") || "";
          if (!SHOW.test(show)) return json({ error: "bad_request", detail: "Bad show" }, 400);
          return json({ edit: (await s.get("orderedit:" + show, { type: "json" })) || null });
        }
        case "plan": {
          const show = url.searchParams.get("show") || "";
          if (!SHOW.test(show)) return json({ error: "bad_request", detail: "Bad show" }, 400);
          return json({ plan: (await s.get("plan:" + show, { type: "json" })) || null });
        }
        case "catalogue": {
          const c = await s.get("catalogue", { type: "json" });
          const items = (c?.items || []).map(clean);
          return json({ items, saved_at: c?.saved_at || null, canSeeMoney });
        }
        case "deliveries": {
          const docs = await readAll(s, "delivery:", 300);
          docs.sort((a, b) => (b.at || 0) - (a.at || 0));
          const list = docs.slice(0, 200).map(({ signature, ...d }) => ({ ...clean(d), lines: (d.lines || []).map(clean), hasSignature: !!signature }));
          return json({ deliveries: list, canSeeMoney });
        }
        case "delivery": {
          const id = url.searchParams.get("id") || "";
          if (!ID.test(id)) return json({ error: "bad_request", detail: "Bad id" }, 400);
          const d = await s.get("delivery:" + id, { type: "json" });
          if (!d) return json({ error: "not_found", detail: "Delivery not found" }, 404);
          return json({ delivery: { ...clean(d), lines: (d.lines || []).map(clean) } });
        }
        case "video": {
          // Returns the whole video. The page fetches it with its sign-in and plays it from a blob URL.
          const id = url.searchParams.get("id") || "";
          if (!ID.test(id)) return json({ error: "bad_request", detail: "Bad id" }, 400);
          const d = await s.get("delivery:" + id, { type: "json" });
          if (!d?.video) return json({ error: "not_found", detail: "No video for this delivery" }, 404);
          const parts = [];
          for (let n = 0; n < d.video.chunks; n++) {
            const buf = await s.get(`vid:${id}:${n}`, { type: "arrayBuffer" });
            if (!buf) return json({ error: "not_found", detail: "Part of the video is missing" }, 404);
            parts.push(Buffer.from(buf));
          }
          return new Response(Buffer.concat(parts), { headers: { "content-type": d.video.type || "video/mp4", "cache-control": "private, max-age=3600" } });
        }
        case "show": {
          const show = url.searchParams.get("show") || "";
          if (!showOk(show)) return json({ error: "forbidden", detail: "This show isn't shared with you." }, 403);
          const [counts, waste, riders] = await Promise.all([readAll(s, `count:${show}:`), readAll(s, `waste:${show}:`), readAll(s, `rider:${show}:`)]);
          return json({ show, counts, waste: waste.map(clean), riders: riders.map(clean), canSeeMoney });
        }
        case "recent_counts": {
          // The latest few counts across all shows, so a show with no opening count can start from the last closing count
          const docs = await readAll(s, "count:", 120);
          docs.sort((a, b) => (b.at || 0) - (a.at || 0));
          return json({ counts: docs.slice(0, 30) });
        }
        case "range": {
          // Waste, riders and deliveries between two times, for reconciling a show window
          if (!isStaff) return json({ error: "forbidden", detail: "Managers only." }, 403);
          const from = num(url.searchParams.get("from")), to = num(url.searchParams.get("to"));
          const docs = await readAll(s, "delivery:", 400);
          return json({ deliveries: docs.filter((d) => d.at >= from && d.at <= to).map(({ signature, ...d }) => d) });
        }
        default: return json({ error: "bad_request", detail: "Unknown action" }, 400);
      }
    }

    /* ---------------- writes ---------------- */
    if (req.method === "POST") {
      if (!canWrite) return json({ error: "forbidden", detail: "You need manager access or the Stock panel to add to this." }, 403);
      const by = g.user.email || null;

      // Video chunks are raw bytes, everything else is JSON
      if (action === "video_chunk") {
        const id = url.searchParams.get("id") || "", n = num(url.searchParams.get("n"), -1);
        if (!ID.test(id) || n < 0 || n >= VIDEO_MAX_CHUNKS) return json({ error: "bad_request", detail: "Bad chunk" }, 400);
        const d = await s.get("delivery:" + id, { type: "json" });
        if (!d) return json({ error: "not_found", detail: "Save the delivery first" }, 404);
        if (!isStaff && d.by !== by) return json({ error: "forbidden", detail: "That isn't your delivery." }, 403);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > CHUNK_MAX) return json({ error: "too_large", detail: "Video part is too big" }, 413);
        await s.set(`vid:${id}:${n}`, buf);
        return json({ ok: true, n });
      }

      let body;
      try { body = await req.json(); } catch { return json({ error: "bad_request", detail: "Body must be JSON" }, 400); }
      const text = JSON.stringify(body || null);
      if (text.length > 400000) return json({ error: "too_large", detail: "That's too much to save in one go." }, 413);

      switch (action) {
        case "show_save": {
          if (!isStaff || g.role === "viewer") return json({ error: "forbidden", detail: "Only managers can set up shows." }, 403);
          const id = SHOW.test(body.id || "") ? body.id : "s_" + newId();
          const start = num(body.start), end = num(body.end);
          if (!str(body.name) || !start || !end || end <= start) return json({ error: "bad_request", detail: "A show needs a name, a start and a later finish." }, 400);
          const doc = { id, name: str(body.name, 100), start, end, forecast: Math.max(0, num(body.forecast)), src: body.src === "sheet" ? "sheet" : "", srcTitle: str(body.srcTitle, 120), by };
          await s.setJSON("showdef:" + id, doc);
          return json({ ok: true, show: doc });
        }
        case "show_delete": {
          if (!isStaff || g.role === "viewer") return json({ error: "forbidden", detail: "Only managers can remove shows." }, 403);
          if (!SHOW.test(body.id || "")) return json({ error: "bad_request", detail: "Bad show" }, 400);
          await s.delete("showdef:" + body.id);
          return json({ ok: true });
        }
        case "snapshot": {
          if (!isStaff || g.role === "viewer") return json({ error: "forbidden", detail: "Managers only." }, 403);
          if (!SHOW.test(body.show || "")) return json({ error: "bad_request", detail: "Bad show" }, 400);
          const serves = {};
          for (const [k, v] of Object.entries(body.serves || {})) if (ID.test(k) && num(v) > 0) serves[k] = num(v);
          await s.setJSON("sales:" + body.show, { show: body.show, start: num(body.start), serves, at: Date.now() });
          return json({ ok: true });
        }
        case "order_edit": { // manager's own quantities on the next order, kept per show
          if (!isStaff || g.role === "viewer") return json({ error: "forbidden", detail: "Managers only." }, 403);
          if (!SHOW.test(body.show || "")) return json({ error: "bad_request", detail: "Bad show" }, 400);
          const cur = body.reset ? {} : ((await s.get("orderedit:" + body.show, { type: "json" }))?.qty || {});
          for (const [k, v] of Object.entries(body.qty || {})) {
            if (!ID.test(k)) continue;
            if (v === null || v === "" || !Number.isFinite(Number(v))) delete cur[k]; else cur[k] = Math.max(0, Math.round(Number(v) * 100) / 100);
          }
          const doc = { show: body.show, qty: cur, at: Date.now(), by };
          await s.setJSON("orderedit:" + body.show, doc);
          return json({ ok: true, edit: doc });
        }
        case "plan": {
          if (!isStaff || g.role === "viewer") return json({ error: "forbidden", detail: "Managers only." }, 403);
          if (!SHOW.test(body.show || "")) return json({ error: "bad_request", detail: "Bad show" }, 400);
          const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 400).map((l) => ({ key: str(l.key, 80), name: str(l.name, 80), units: num(l.units) }));
          await s.setJSON("plan:" + body.show, { show: body.show, basis: str(body.basis, 120), lines, at: Date.now() });
          return json({ ok: true });
        }
        case "catalogue": {
          if (!isStaff) return json({ error: "forbidden", detail: "Only managers can change the product list." }, 403);
          const items = (Array.isArray(body.items) ? body.items : []).slice(0, 600).map((p) => ({
            id: ID.test(p.id || "") ? p.id : newId(),
            name: str(p.name, 80), cat: str(p.cat, 20) || "other", unit: str(p.unit, 20) || "bottle",
            serves: Math.max(0.01, num(p.serves, 1)), packSize: Math.max(1, Math.round(num(p.packSize, 1))),
            cost: Math.max(0, num(p.cost)), price: Math.max(0, num(p.price)),
            line: str(p.line, 80), supplier: str(p.supplier, 60), par: Math.max(0, num(p.par)), pallet: Math.max(0, Math.round(num(p.pallet))),
          })).filter((p) => p.name);
          await s.setJSON("catalogue", { items, saved_at: new Date().toISOString(), saved_by: by });
          return json({ ok: true, items });
        }
        case "delivery": {
          const id = newId();
          const sig = typeof body.signature === "string" && body.signature.startsWith("data:image/png;base64,") && body.signature.length < 150000 ? body.signature : null;
          const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 80).map((l) => ({
            productId: str(l.productId, 40), name: str(l.name, 80), qty: num(l.qty), unitCost: canSeeMoney ? Math.max(0, num(l.unitCost)) : 0, note: str(l.note, 80),
          })).filter((l) => l.productId && l.qty > 0);
          if (!lines.length) return json({ error: "bad_request", detail: "Add at least one line." }, 400);
          if (!str(body.receivedBy)) return json({ error: "bad_request", detail: "Who received it? Add a name." }, 400);
          const doc = {
            id, at: num(body.at, Date.now()), supplier: str(body.supplier, 80), ref: str(body.ref, 60), receivedBy: str(body.receivedBy, 60),
            lines, note: str(body.note, 400), signature: sig, show: SHOW.test(body.show || "") ? body.show : "",
            video: body.hasVideo ? { chunks: 0, type: str(body.videoType, 40) || "video/mp4", status: "uploading" } : null,
            by, created_at: new Date().toISOString(),
          };
          await s.setJSON("delivery:" + id, doc);
          return json({ ok: true, id });
        }
        case "delivery_video_done": {
          const id = str(body.id, 40);
          if (!ID.test(id)) return json({ error: "bad_request", detail: "Bad id" }, 400);
          const d = await s.get("delivery:" + id, { type: "json" });
          if (!d?.video) return json({ error: "not_found", detail: "No video expected for this delivery" }, 404);
          if (!isStaff && d.by !== by) return json({ error: "forbidden", detail: "That isn't your delivery." }, 403);
          d.video = { ...d.video, chunks: Math.min(VIDEO_MAX_CHUNKS, Math.max(1, Math.round(num(body.chunks, 1)))), status: "ready" };
          await s.setJSON("delivery:" + id, d);
          return json({ ok: true });
        }
        case "count": {
          const show = str(body.show, 60);
          if (!showOk(show)) return json({ error: "forbidden", detail: "This show isn't shared with you." }, 403);
          const type = ["opening", "closing", "spot"].includes(body.type) ? body.type : "spot";
          const counts = {};
          for (const [k, v] of Object.entries(body.counts || {})) if (ID.test(k) && Number.isFinite(Number(v)) && v !== "") counts[k] = Math.max(0, Number(v));
          const at = Date.now();
          const key = type === "spot" ? `count:${show}:spot-${at.toString(36)}` : `count:${show}:${type}`;
          await s.setJSON(key, { show, type, at, counts, note: str(body.note, 300), by });
          return json({ ok: true, at });
        }
        case "waste": {
          const show = str(body.show, 60);
          if (!showOk(show)) return json({ error: "forbidden", detail: "This show isn't shared with you." }, 403);
          const qty = num(body.qty);
          if (!ID.test(body.productId || "") || !(qty > 0)) return json({ error: "bad_request", detail: "Pick a product and a quantity." }, 400);
          const id = newId();
          await s.setJSON(`waste:${show}:${id}`, { id, show, at: Date.now(), productId: body.productId, name: str(body.name, 80), qty, reason: str(body.reason, 40) || "Other", note: str(body.note, 200), valueEach: canSeeMoney ? num(body.valueEach) : 0, by });
          return json({ ok: true, id });
        }
        case "rider": {
          const show = str(body.show, 60);
          if (!showOk(show)) return json({ error: "forbidden", detail: "This show isn't shared with you." }, 403);
          const kind = ["rider", "voucher", "comp"].includes(body.kind) ? body.kind : "rider";
          const id = ID.test(body.id || "") ? body.id : newId();
          await s.setJSON(`rider:${show}:${id}`, {
            id, show, kind, label: str(body.label, 80), productId: ID.test(body.productId || "") ? body.productId : "", name: str(body.name, 80),
            qty: Math.max(0, num(body.qty)), issued: Math.max(0, num(body.issued)), redeemed: Math.max(0, num(body.redeemed)),
            servesEach: Math.max(0, num(body.servesEach, 1)), valueEach: canSeeMoney ? Math.max(0, num(body.valueEach)) : 0,
            status: body.status === "delivered" ? "delivered" : "planned", note: str(body.note, 200), at: num(body.at, Date.now()), by,
          });
          return json({ ok: true, id });
        }
        case "delete": {
          if (!isStaff) return json({ error: "forbidden", detail: "Only managers can delete records." }, 403);
          const kind = str(body.kind, 12), show = str(body.show, 60), id = str(body.id, 40);
          if (!ID.test(id)) return json({ error: "bad_request", detail: "Bad id" }, 400);
          if (kind === "delivery") {
            const d = await s.get("delivery:" + id, { type: "json" });
            for (let n = 0; n < (d?.video?.chunks || 0); n++) await s.delete(`vid:${id}:${n}`);
            await s.delete("delivery:" + id);
          } else if ((kind === "waste" || kind === "rider") && SHOW.test(show)) await s.delete(`${kind}:${show}:${id}`);
          else return json({ error: "bad_request", detail: "Can't delete that" }, 400);
          return json({ ok: true });
        }
        default: return json({ error: "bad_request", detail: "Unknown action" }, 400);
      }
    }
    return json({ error: "method" }, 405);
  } catch (err) {
    return json({ error: "storage", detail: err.message || String(err) }, 500);
  }
};

export const config = { path: "/api/stock" };
