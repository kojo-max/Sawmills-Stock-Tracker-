# Sawmills Stock

A separate app from the Sawmills Live dashboard. Own site, own login, own data.

Deliveries (signature and video of the note), riders and vouchers, stock counts, wastage, theoretical and actual GP, and a predicted order for the next show.

## Put it live (about 15 minutes)

1. **GitHub**: new private repo called `sawmills-stock`. Upload everything in this folder (keep the `netlify` and `public` folders as they are).
2. **Netlify**: Add new site, Import an existing project, pick `sawmills-stock`, leave the build settings, Deploy. Use a new site, not the dashboard's.
3. **Keys** (Site configuration, Environment variables):

| Key | Value |
|---|---|
| `SQUARE_ACCESS_TOKEN` | the same Square production token the dashboard uses |
| `ADMIN_EMAILS` | your email. Separate several with commas. |

Optional: `SQUARE_LOCATION_ID` if it ever picks the wrong location. Then Deploys, Trigger deploy.
4. **Sign-in**: Project configuration, Identity, Enable Identity. Registration: **Invite only**. Invite yourself from the Identity tab, click the email link, set a password.
5. Everyone else: **Team** tab in the app, invite by email.

## Who sees what

| Role | Can do |
|---|---|
| Stock team | Log deliveries, counts, wastage, riders. Read products and the published order. **Never sees costs, prices, forecasts or GP.** |
| Viewer | See everything, change nothing |
| Manager | Everything, plus products, costs, shows, GP |
| Admin | Also manages the team |

## First-time setup

1. **Shows** tab: add tonight's show and the next one (name, bar open and close, takings forecast inc VAT). Add a recent past show or two with their real times.
2. **Products** tab: add your lines. Quickest is to select a show and press **Add lines from this show's till**, then fill in the rest. Or paste from a sheet. Per product:
   - **Serves per unit**: how many till serves one gives (70cl spirit at 25ml = 28, a keg = pints in it, a can = 1)
   - **Pack size**: units per case, so orders round up properly
   - **Cost** per unit ex VAT, **price** per serve inc VAT
   - **Sales line**: the item name on the till (blank if same as the product name). One line, one product.
   - **Supplier** and **par** (the least you want on hand)
3. **Counts**: opening before doors, closing after close.
4. Open **GP** for each past show once. That saves what it sold, and the order learns the mix from the last three.

## Forecasts from the venue sheet

The Shows tab can pull each upcoming show's **Forecasted Bar** (inc VAT), tickets and times from "Sawmills Diary & Budgets", so nobody types forecasts in twice.

1. Open the venue sheet, Extensions > Apps Script, paste `google/forecast.gs`, change `SECRET`, Deploy > New deployment > Web app (run as you, anyone can access).
2. In Netlify add `FORECAST_SCRIPT_URL` (the web app URL) and `FORECAST_SECRET` (the same phrase). Redeploy.
3. Shows tab > "Pull forecasts from the venue sheet" > check the list > Apply. Shows you already have keep their name and times and only get the forecast. New ones are added. A forecast you type in by hand still works and replaces the sheet figure.

The script only reads. It finds each show's tab by its name in the Events SUMMARY tab, then reads the Forecasted Bar row, Open-Close and Tickets by their labels. A show whose tab has no Forecasted Bar row (for example SG Lewis, which uses a different layout) is listed as "No bar forecast in the sheet".

## How the numbers work

- Sales come from Square (units sold in the show's window). Revenue is serves × till price, ex VAT. Type Square's net takings into the GP tab to use the real figure.
- **Theoretical GP** = revenue minus the cost of what the till says went out.
- **Actual GP** = revenue minus the cost of what the counts say went out (opening + deliveries since the opening count − closing).
- **Missing** = actual used − should have used − wastage − delivered riders and redeemed vouchers. This is the number to chase.
- **Next order** = next show's forecast spread over what the last three shows sold, plus safety %, plus planned riders, minus on hand (latest count plus deliveries since), rounded up to pack size, grouped by supplier.

## Files

```
public/index.html, app.js      the page, sign-in, team
public/stock.js                all the stock screens
public/stock-calc.js           GP and order maths
public/match.js                matches till items to products
netlify/functions/stock.mjs    products, shows, deliveries, counts, wastage, riders, video
netlify/functions/square.mjs   reads units sold from Square (no money)
netlify/functions/team.mjs     invites (admins)
netlify/functions/auth.mjs     who's signed in
```

Data lives in Netlify Blobs on this site. Videos upload in 4MB parts, up to about 60MB each.
