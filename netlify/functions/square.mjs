// Square: units sold per till item for a time window (no money in the answer).
// Env: SQUARE_ACCESS_TOKEN (required), SQUARE_LOCATION_ID (optional), SQUARE_LOCATION_NAME (optional, default "sawmill")
import { json, guard, fail, deadline, toMs } from "../lib/common.mjs";

const BASE = process.env.SQUARE_BASE_URL || "https://connect.squareup.com";

// Line items that are not bar sales. Lockers are counted separately; tickets are ignored.
const LOCKER = /locker/i;
const NOT_BAR = /ticket/i;

async function sq(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const e = new Error(`Square returned ${res.status}`);
    e.status = res.status === 401 ? 401 : 502;
    e.code = res.status === 401 ? "square_auth" : "square";
    const first = body?.errors?.[0];
    e.detail = res.status === 401
      ? "Square rejected the access token. Check SQUARE_ACCESS_TOKEN in Netlify."
      : `Square ${res.status}: ${first?.detail || first?.code || text.slice(0, 200)}`;
    throw e;
  }
  return body || {};
}

let cachedLocation = null;
async function getLocation() {
  if (cachedLocation) return cachedLocation;
  const { locations = [] } = await sq("/v2/locations");
  const id = process.env.SQUARE_LOCATION_ID;
  const want = (process.env.SQUARE_LOCATION_NAME || "sawmill").toLowerCase();
  const loc = id ? locations.find((l) => l.id === id) : locations.find((l) => (l.name || "").toLowerCase().includes(want));
  if (!loc) {
    const e = new Error("Location not found");
    e.status = 404; e.code = "square_location";
    e.detail = `No Square location matching "${id || want}". Locations on this account: ${locations.map((l) => l.name).join(", ") || "none"}.`;
    throw e;
  }
  cachedLocation = { id: loc.id, name: loc.name, timezone: loc.timezone };
  return cachedLocation;
}

function lineLabel(li) {
  const name = (li.name || "Custom amount").trim();
  const v = (li.variation_name || "").trim();
  return v && !/^regular$/i.test(v) ? `${name} (${v})` : name;
}

// Compact an order to what the dashboard needs: time, bar pence, locker pence, items.
// Amounts are line totals after discounts, including VAT (matches Square's "Gross Sales" in item exports).
// Compact an order to what the dashboard needs. v = gross (inc VAT, after discounts, matching "Gross Sales"
// in Square's item export); n = net (the same less VAT). Items carry both.
function compactOrder(o) {
  let bar = 0, net = 0, lockers = 0, lockerQty = 0;
  const items = [];
  const add = (li, sign) => {
    const label = lineLabel(li);
    const pence = sign * (li.total_money?.amount ?? 0);
    const tax = sign * (li.total_tax_money?.amount ?? 0);
    const qty = sign * parseFloat(li.quantity || "1");
    if (LOCKER.test(label)) { lockers += pence; lockerQty += qty; return; }
    if (NOT_BAR.test(label)) return;
    bar += pence; net += pence - tax;
    items.push([label, qty, pence, pence - tax]);
  };
  for (const li of o.line_items || []) add(li, 1);
  for (const r of o.returns || []) for (const li of r.return_line_items || []) add(li, -1);
  return {
    id: o.id,
    t: toMs(o.closed_at || o.created_at),
    u: toMs(o.updated_at),
    v: bar,
    n: net,
    lk: lockers,
    lq: lockerQty,
    items,
  };
}

async function units(url, more) {
  const loc = await getLocation();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to") || new Date().toISOString();
  const keepFrom = toMs(url.searchParams.get("keep_from")) || 0;
  const until = toMs(url.searchParams.get("until")) || Infinity;
  if (!from) return json({ error: "bad_request", detail: "from is required" }, 400);
  if (Date.parse(from) >= Date.parse(to)) return json({ items: [], orders: 0, cursor: null });
  let cursor = url.searchParams.get("cursor") || undefined;
  const qty = new Map();
  let n = 0;
  do {
    const body = {
      location_ids: [loc.id],
      query: {
        filter: {
          date_time_filter: { updated_at: { start_at: from, end_at: to } },
          state_filter: { states: ["COMPLETED"] },
        },
        sort: { sort_field: "UPDATED_AT", sort_order: "ASC" },
      },
      limit: 500,
      return_entries: false,
      cursor,
    };
    const page = await sq("/v2/orders/search", { method: "POST", body: JSON.stringify(body) });
    for (const o of page.orders || []) {
      const c = compactOrder(o);
      if (!c.t || c.t < keepFrom || c.t > until) continue;
      n++;
      for (const [label, q] of c.items) qty.set(label, (qty.get(label) || 0) + q);
    }
    cursor = page.cursor;
  } while (cursor && more());
  return json({ items: [...qty].map(([k, q]) => [k, Math.round(q * 100) / 100]), orders: n, cursor: cursor || null });
}

export default async (req) => {
  const g = await guard(req, { need: "limited" });
  if (g instanceof Response) return g;
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    return json({ error: "not_configured", detail: "SQUARE_ACCESS_TOKEN is not set in Netlify yet." }, 503);
  }
  const url = new URL(req.url);
  const more = deadline();
  try {
    switch (url.searchParams.get("action")) {
      case "ping": {
        const loc = await getLocation();
        return json({ ok: true, location: loc.name, location_id: loc.id, timezone: loc.timezone });
      }
      case "units": {
        // Units sold per till item for a show window, with no money in it (for the Bar stock tab)
        return await units(url, more);
      }
      default: return json({ error: "bad_request", detail: "Unknown action" }, 400);
    }
  } catch (err) {
    return fail(err);
  }
};

export const config = { path: "/api/square" };
