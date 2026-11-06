// Venue forecast: asks the Google Apps Script attached to "Sawmills Diary & Budgets" (google/forecast.gs)
// for each upcoming show's date, times, tickets and Forecasted Bar. Managers and admins only.
// Env: FORECAST_SCRIPT_URL (the script's web app URL), FORECAST_SECRET (matches SECRET in the script).
import { json, guard } from "../lib/common.mjs";

export default async (req) => {
  const g = await guard(req, { need: "manager" });
  if (g instanceof Response) return g;
  if (!process.env.FORECAST_SCRIPT_URL || !process.env.FORECAST_SECRET) {
    return json({ error: "not_configured", detail: "The venue sheet isn't linked yet. Add FORECAST_SCRIPT_URL and FORECAST_SECRET in Netlify (steps are at the top of google/forecast.gs)." }, 503);
  }
  let res;
  try {
    res = await fetch(process.env.FORECAST_SCRIPT_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: process.env.FORECAST_SECRET }), redirect: "follow" });
  } catch {
    return json({ error: "forecast", detail: "Couldn't reach the Google script. Check FORECAST_SCRIPT_URL in Netlify." }, 502);
  }
  const text = await res.text();
  let out; try { out = JSON.parse(text); } catch { out = null; }
  if (!res.ok || !out) return json({ error: "forecast", detail: "The Google script didn't answer properly. Re-deploy it as a web app that anyone can run, then try again." }, 502);
  if (out.error === "secret") return json({ error: "forecast", detail: "The Google script turned down the secret. FORECAST_SECRET in Netlify must match SECRET in the script." }, 502);
  if (out.error) return json({ error: "forecast", detail: out.detail || "The Google script reported a problem." }, 502);
  return json({ events: Array.isArray(out.events) ? out.events.slice(0, 200) : [], at: out.at || null });
};
export const config = { path: "/api/forecast" };
