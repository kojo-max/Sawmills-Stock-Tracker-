/* Sawmills Stock: forecast feed.
   Reads the venue sheet "Sawmills Diary & Budgets" and hands the stock app each upcoming show's date, times,
   tickets and Forecasted Bar (gross, inc VAT). It only reads. Nothing in the sheet is changed.

   Setup (5 minutes):
   1. Open the venue sheet, Extensions > Apps Script. Paste this whole file over the empty script. Save.
   2. Change SECRET below to a long random phrase.
   3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy, then copy the Web app URL.
   4. In Netlify for the stock site, add two environment variables: FORECAST_SCRIPT_URL (that URL) and FORECAST_SECRET (the same phrase).
   5. Redeploy the stock site. The Shows tab now has "Pull forecasts from the venue sheet".
*/
var SECRET = "CHANGE-ME";
var SHEET_ID = ""; // leave empty if this script is attached to the venue sheet (Extensions > Apps Script)
var SUMMARY_TAB = "Events SUMMARY";
var LOOK_BACK_DAYS = 1, LOOK_AHEAD_DAYS = 150;

function money_(v) {
  var s = String(v == null ? "" : v).trim();
  if (!s) return null;
  var neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /\(.*\)/.test(s);
  var n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : (neg ? -n : n);
}
function dmy_(s) { // "07/11/2026" -> "2026-11-07"
  var m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2) : null;
}
function nextFilled_(row, from) { for (var i = from; i < row.length; i++) if (String(row[i]).trim() !== "") return i; return -1; }

// Rows of the Events SUMMARY tab (display values) -> [{title, code, date, tickets, hours, totalGross}]
function parseSummary_(rows) {
  var h = -1;
  for (var i = 0; i < rows.length && h < 0; i++) for (var j = 0; j < rows[i].length; j++) if (String(rows[i][j]).trim().toLowerCase() === "event title") { h = i; break; }
  if (h < 0) return [];
  var col = {}; rows[h].forEach(function (c, j) { col[String(c).trim().toLowerCase()] = j; });
  var out = [];
  for (var r = h + 1; r < rows.length; r++) {
    var row = rows[r], date = dmy_(row[col["event date"]]);
    if (!date || !String(row[col["event title"]]).trim()) continue;
    out.push({
      title: String(row[col["event title"]]).trim(), code: String(row[col["event code"]] || "").trim(), date: date,
      tickets: money_(row[col["# tickets"]]), hours: money_(row[col["running hours"]]), totalGross: money_(row[col["forecasted gross revenue"]]),
    });
  }
  return out;
}

// Rows of one event tab (display values) -> the forecast bits, found by their labels so small layout changes don't break it
function parseEvent_(rows) {
  var o = { open: null, close: null, tickets: null, barGross: null, barNet: null, ticketsGross: null, totalGross: null };
  rows.forEach(function (row) {
    for (var c = 0; c < row.length; c++) {
      var label = String(row[c]).trim().toLowerCase().replace(/:$/, "");
      if (!label) continue;
      if (label === "open-close") { var a = nextFilled_(row, c + 1), b = a < 0 ? -1 : nextFilled_(row, a + 1); if (a >= 0) o.open = String(row[a]).trim(); if (b >= 0) o.close = String(row[b]).trim(); }
      else if (label === "tickets/dropoff") { var t = nextFilled_(row, c + 1); if (t >= 0) o.tickets = money_(row[t]); }
      else if (label === "forecasted bar" || label === "forecasted tickets" || label === "forecasted total") {
        var g = nextFilled_(row, c + 1), n = g < 0 ? -1 : nextFilled_(row, g + 1);
        var key = label === "forecasted bar" ? "bar" : label === "forecasted tickets" ? "tickets" : "total";
        var gross = g >= 0 ? money_(row[g]) : null, net = n >= 0 ? money_(row[n]) : null;
        if (key === "bar") { o.barGross = gross; o.barNet = net; } else if (key === "tickets") o.ticketsGross = gross; else o.totalGross = gross;
      }
    }
  });
  return o;
}

function build_() {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  var summary = ss.getSheetByName(SUMMARY_TAB);
  if (!summary) return { error: "no_summary", detail: 'No tab called "' + SUMMARY_TAB + '" in that sheet.' };
  var list = parseSummary_(summary.getDataRange().getDisplayValues());
  var now = new Date(), lo = new Date(now.getTime() - LOOK_BACK_DAYS * 864e5), hi = new Date(now.getTime() + LOOK_AHEAD_DAYS * 864e5);
  var events = [];
  list.forEach(function (ev) {
    var d = new Date(ev.date + "T12:00:00");
    if (d < lo || d > hi) return;
    var tab = ss.getSheetByName(ev.title), p = { open: null, close: null, tickets: ev.tickets, barGross: null, barNet: null, ticketsGross: null, totalGross: ev.totalGross };
    if (tab) { var got = parseEvent_(tab.getRange(1, 1, Math.min(40, tab.getMaxRows()), Math.min(12, tab.getMaxColumns())).getDisplayValues()); for (var k in got) if (got[k] != null) p[k] = got[k]; }
    events.push({ title: ev.title, code: ev.code, date: ev.date, hours: ev.hours, open: p.open, close: p.close, tickets: p.tickets, barGross: p.barGross, barNet: p.barNet, ticketsGross: p.ticketsGross, totalGross: p.totalGross, hasTab: !!tab });
  });
  events.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return { events: events, at: new Date().toISOString() };
}

function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    out = body.secret !== SECRET || SECRET === "CHANGE-ME" ? { error: "secret" } : build_();
  } catch (err) { out = { error: "script", detail: String(err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return ContentService.createTextOutput(JSON.stringify({ ok: true, note: "POST with the secret to read forecasts." })).setMimeType(ContentService.MimeType.JSON); }
