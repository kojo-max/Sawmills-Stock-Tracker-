/* Till item matching, copied from the dashboard so sales line up with products the same way. */
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const MIX_CATS = [
  { k: "beer", name: "Beer", c: "#eda100" },
  { k: "cider", name: "Cider & seltzers", c: "#1baf7a" },
  { k: "wine", name: "Wine & fizz", c: "#e87ba4" },
  { k: "spirits", name: "Spirits & mixers", c: "#2a78d6" },
  { k: "cocktails", name: "Cocktails & shots", c: "#eb6834" },
  { k: "soft", name: "Soft drinks", c: "#6250d6" },
  { k: "other", name: "Other", c: "#c9cdd3" },
];
const MIX_CAT = Object.fromEntries(MIX_CATS.map((c) => [c.k, c]));
function mixCat(name) {
  const n = String(name || "").toLowerCase();
  if (/custom amount|deposit|\bcup\b|token|wristband|cloak|merch|ticket|locker/.test(n)) return "other";
  if (/cocktail|margarita|mojito|martini|spritz|daiquiri|negroni|bomb|\bshots?\b|\bjug\b|pornstar|paloma|\bsour\b|punch|tequila rose|sambuca|jager/.test(n)) return "cocktails";
  if (/white claw|seltzer|cider|thatchers|appleshed|kopparberg|rekorderlig|strongbow|orchard pig|old mout/.test(n)) return "cider";
  if (/vodka|\brum\b|\bgin\b|tequila|whisk|bourbon|brandy|cognac|liqueur|amaretto|baileys|triple b|spirit|\bdouble\b|\bsingle\b|\bbdc\b|disaronno|jack daniel|smirnoff|gordon|bacardi|captain|hanks/.test(n)) return "spirits";
  if (/wine|\brose\b|rosé|prosecco|champagne|cava|\bfizz\b|headliner|merlot|sauvignon|pinot|malbec|chardonnay|\bwhite\b|\bred\b(?! stripe)/.test(n)) return "wine";
  if (/beer|lager|\bale\b|\bipa\b|stout|pils|stripe|amstel|heineken|peroni|guinness|camden|lost and grounded|wiper|butty|jubel|sesh|moretti|corona|craft|\bpint\b|madri|neck oil|hells|\bpale\b/.test(n)) return "beer";
  if (/water|coke|cola|lemonade|juice|\bsoft\b|red ?bull|monster|tonic|soda|j2o|fanta|sprite|squash|energy/.test(n)) return "soft";
  return "other";
}
// "5 Red Stripe for 20", "4 Craft Beers £20": several of one line in one sale
function bundleOf(name) {
  const m = String(name || "").match(/^\s*(\d{1,2})\s*x?\s+(.+?)\s+(?:for\s+)?£?\d+(?:\.\d+)?\s*$/i);
  return m && +m[1] >= 2 ? { n: +m[1], base: m[2].trim() } : null;
}
// The stock line a till item draws from, and how many of that line one sale uses
function lineOf(name, singles) {
  const b = bundleOf(name);
  if (b) {
    const nb = norm(b.base).replace(/s$/, "");
    const hit = nb.length >= 4 ? singles.find((x) => norm(x).includes(nb)) : null;
    return hit ? { key: norm(hit), name: hit, mult: b.n } : { key: norm(b.base), name: b.base, mult: b.n };
  }
  const m = String(name).match(/^(.*?)\s*\((single|double|regular)\)\s*$/i);
  if (m) return { key: norm(m[1]), name: m[1].trim(), mult: /double/i.test(m[2]) ? 2 : 1 };
  return { key: norm(name), name: String(name).trim(), mult: 1 };
}
const isOpenPrice = (n) => /custom amount/i.test(n || "");


function soldFor(line, units) {
  if (!units) return null;
  let n = 0;
  const sing = [...units.keys()].filter((x) => !bundleOf(x));
  for (const [name, q] of units) { const L = lineOf(name, [line.name, ...sing]); if (L.key === line.key) n += q * L.mult; }
  return n;
}
