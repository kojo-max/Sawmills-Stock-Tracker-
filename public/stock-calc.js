/* Stock maths: no page code in here, so it can be tested on its own.
   All quantities are in stock units (a bottle, a keg, a case...). Sales are in serves, and each product
   says how many serves one unit gives (a 70cl spirit at 25ml is 28; a 330ml can is 1).
   Prices on the till are gross (inc VAT); costs are ex VAT; GP is worked on net revenue. */
(function (root) {
  const VAT = 1.2;
  const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const lineKeyOf = (p) => norm(p.line || p.name);

  /* Reconcile one show.
     products   catalogue items
     opening    { at, counts: {id: units} } or null
     closing    same
     deliveries [{ at, lines: [{productId, qty, unitCost}] }] already limited to the window
     waste      [{ productId, qty (units) }]
     riders     [{ kind, productId, qty, status, redeemed, servesEach }]
     sold       { productId: serves sold }
     override   net takings £ typed in (optional)
  */
  function reconcile({ products, opening, closing, deliveries = [], waste = [], riders = [], sold = {}, override = null }) {
    const del = {}, wst = {}, rid = {};
    for (const d of deliveries) for (const l of d.lines || []) del[l.productId] = (del[l.productId] || 0) + n0(l.qty);
    for (const w of waste) wst[w.productId] = (wst[w.productId] || 0) + n0(w.qty);
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    for (const r of riders) {
      if (!r.productId || !byId[r.productId]) continue;
      let u = 0;
      if (r.kind === "voucher") u = (n0(r.redeemed) * (n0(r.servesEach) || 1)) / (n0(byId[r.productId].serves) || 1);
      else if (r.status === "delivered") u = n0(r.qty);
      rid[r.productId] = (rid[r.productId] || 0) + u;
    }
    const rows = [];
    let revenueCalc = 0, uncounted = 0;
    for (const p of products) {
      const serves = n0(p.serves) || 1, cost = n0(p.cost), price = n0(p.price);
      const soldServes = n0(sold[p.id]);
      const theo = soldServes / serves;
      const o = opening?.counts?.[p.id], c = closing?.counts?.[p.id];
      const d = del[p.id] || 0, w = wst[p.id] || 0, r = rid[p.id] || 0;
      const counted = o != null && c != null;
      const actual = counted ? n0(o) + d - n0(c) : null;
      const used = actual != null ? actual : theo + w + r;      // no count: assume no variance
      const variance = actual != null ? actual - theo - w - r : null; // + = stock missing
      const rev = (soldServes * price) / VAT;
      revenueCalc += rev;
      if (!counted && (soldServes > 0 || d > 0)) uncounted++;
      if (soldServes === 0 && !counted && !d && !w && !r) continue;
      rows.push({
        id: p.id, name: p.name, cat: p.cat, unit: p.unit, opening: o ?? null, delivered: d, closing: c ?? null, actual, theo, waste: w, riders: r,
        variance, varCost: variance != null ? variance * cost : null, varPct: variance != null && theo > 0 ? variance / theo : null,
        soldServes, rev, theoCost: theo * cost, actualCost: used * cost, wasteCost: w * cost, riderCost: r * cost, cost,
      });
    }
    const revenue = override != null && override > 0 ? override : revenueCalc;
    const sum = (k) => rows.reduce((a, x) => a + (x[k] || 0), 0);
    const theoCost = sum("theoCost"), actualCost = sum("actualCost");
    const theoGP = revenue - theoCost, actualGP = revenue - actualCost;
    return {
      rows, revenue, revenueCalc, usedOverride: override != null && override > 0,
      theoCost, actualCost, theoGP, actualGP,
      theoPct: revenue > 0 ? theoGP / revenue : null, actualPct: revenue > 0 ? actualGP / revenue : null,
      gapGP: theoGP - actualGP, wasteCost: sum("wasteCost"), riderCost: sum("riderCost"),
      unexplained: rows.reduce((a, x) => a + (x.varCost || 0), 0), uncounted,
      complete: !!opening && !!closing,
    };
  }

  /* On hand now: latest count that includes the product, plus anything delivered since that count. */
  function onHandNow(products, counts, deliveries) {
    const out = {};
    const sorted = [...counts].sort((a, b) => b.at - a.at);
    for (const p of products) {
      const c = sorted.find((x) => x.counts && x.counts[p.id] != null);
      if (!c) { out[p.id] = { qty: null, at: null }; continue; }
      let q = n0(c.counts[p.id]);
      for (const d of deliveries) if (d.at > c.at) for (const l of d.lines || []) if (l.productId === p.id) q += n0(l.qty);
      out[p.id] = { qty: q, at: c.at };
    }
    return out;
  }

  /* Order for the next show.
     mixLines  [{ key, name, units }]  expected serves per sales line from the forecast and sales mix
     onHand    from onHandNow
     planned   { productId: units } rider/comp stock planned for that show
     buffer    0.1 = 10% safety
  */
  function predictOrder({ products, mixLines, onHand = {}, planned = {}, buffer = 0.1, palletPct = 0.8 }) {
    const lineBy = new Map(mixLines.map((l) => [l.key, l]));
    const out = [], matched = new Set();
    for (const p of products) {
      const serves = n0(p.serves) || 1, pack = Math.max(1, Math.round(n0(p.packSize)) || 1);
      const line = lineBy.get(lineKeyOf(p));
      if (line) matched.add(line.key);
      // Serves from the expected mix. If the till prices haven't been learnt yet, fall back to the line's £ share over this product's price.
      const fSrv = !line ? 0 : line.units != null ? n0(line.units) : n0(line.v) > 0 && n0(p.price) > 0 ? n0(line.v) / n0(p.price) : 0;
      const base = fSrv / serves;
      const rider = n0(planned[p.id]);
      let need = base * (1 + buffer) + rider;
      const par = n0(p.par);
      if (par > need) need = par;
      if (need <= 0) continue;
      const oh = onHand[p.id]?.qty;
      const have = oh == null ? 0 : oh;
      const short = Math.max(0, need - have);
      let orderUnits = short > 0 ? Math.ceil(short / pack - 1e-9) * pack : 0;
      // Round up to a full pallet once the order is within reach of one (palletPct = share of a pallet that triggers it).
      const pallet = Math.max(0, Math.round(n0(p.pallet))); let palletUp = 0, pallets = 0;
      if (pallet > 0 && orderUnits > 0 && palletPct > 0 && palletPct <= 1) {
        pallets = Math.floor(orderUnits / pallet); const rem = orderUnits - pallets * pallet;
        if (rem > 1e-9 && rem >= palletPct * pallet - 1e-9) { palletUp = (pallets + 1) * pallet - orderUnits; orderUnits += palletUp; pallets += 1; }
        else if (rem <= 1e-9) pallets = orderUnits / pallet; else pallets = 0;
      }
      out.push({
        id: p.id, name: p.name, cat: p.cat, supplier: p.supplier || "", unit: p.unit, packSize: pack, forecastServes: fSrv, base, rider, need, pallet, palletUp, pallets,
        onHand: oh, countedAt: onHand[p.id]?.at || null, short, orderUnits, cases: orderUnits / pack, cost: n0(p.cost), est: orderUnits * n0(p.cost),
      });
    }
    const unmatched = mixLines.filter((l) => !matched.has(l.key) && n0(l.units) > 0);
    out.sort((a, b) => (a.supplier || "~").localeCompare(b.supplier || "~") || a.name.localeCompare(b.name));
    return { rows: out, unmatched, total: out.reduce((a, x) => a + x.est, 0) };
  }

  /* Paste from a spreadsheet: name, category, unit, serves per unit, pack size, cost, price per serve, sales line, supplier, par, pallet size */
  function parsePaste(text) {
    const rows = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (const r of rows) {
      const cells = r.includes("\t") ? r.split("\t") : r.split(",");
      const c = cells.map((x) => x.trim().replace(/^"|"$/g, ""));
      if (!c[0] || /^(name|product)$/i.test(c[0])) continue;
      const money = (v) => n0(String(v || "").replace(/[£,\s]/g, ""));
      out.push({ name: c[0], cat: (c[1] || "other").toLowerCase(), unit: c[2] || "bottle", serves: n0(c[3]) || 1, packSize: Math.round(n0(c[4])) || 1, cost: money(c[5]), price: money(c[6]), line: c[7] || "", supplier: c[8] || "", par: n0(c[9]), pallet: Math.max(0, Math.round(n0(c[10]))) });
    }
    return out;
  }

  root.StockCalc = { VAT, reconcile, onHandNow, predictOrder, parsePaste, lineKeyOf, norm };
  if (typeof module !== "undefined" && module.exports) module.exports = root.StockCalc;
})(typeof window !== "undefined" ? window : globalThis);
