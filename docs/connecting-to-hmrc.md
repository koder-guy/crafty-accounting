# Connecting to HMRC

The app can talk to HMRC's Making Tax Digital APIs directly, but all of this stays hidden until `HMRC_CLIENT_ID` and `HMRC_CLIENT_SECRET` are set. Without them, the app exports each quarter's figures for bridging software, and **Settings → HMRC**, the **Final declaration** tab and `/api/hmrc` (apart from its status) don't appear.

## Setting it up

The app talks to HMRC as its own application, registered on HMRC's Developer Hub. For now that's the sandbox, HMRC's test service with made-up taxpayers; using the live service needs HMRC's approval for the application.

1. At [developer.service.hmrc.gov.uk](https://developer.service.hmrc.gov.uk), add a sandbox application and subscribe it to **Business Details (MTD)** 2.0, **Obligations (MTD)** 3.0, **Self Employment Business (MTD)** 5.0, **Individual Calculations (MTD)** 8.0 and **Test Fraud Prevention Headers** 1.0.
2. Put the client ID and a client secret in `.env` as `HMRC_CLIENT_ID` and `HMRC_CLIENT_SECRET`, and restart the app.
3. Add the redirect URI shown in **Settings → HMRC** to the application (the app's address followed by `/api/hmrc/callback`).
4. Create an **Individual** with HMRC's [Create test user](https://developer.service.hmrc.gov.uk/api-test-user) service. In **Settings → HMRC**, enter its National Insurance number, choose **Connect to HMRC**, sign in as it, then choose **Find my business**.

| Variable | Default | Purpose |
|---|---|---|
| `HMRC_CLIENT_ID` / `HMRC_CLIENT_SECRET` | *(none)* | Your application's credentials from HMRC |
| `HMRC_ENV` | `sandbox` | `sandbox` (HMRC's test service) or `production` |
| `HMRC_REDIRECT_URI` | worked out | Only if Settings → HMRC shows the wrong redirect URI |

In the sandbox, HMRC answers with test data (a made-up business, obligations and calculations), not your own figures. Updates sent to the sandbox don't count once the app uses the live service.

The connection lasts 18 months. **Disconnect** makes the app forget it; to withdraw the authority at HMRC too, do it in your HMRC online account. Backups don't include the connection, so a restore keeps it as it is. Removing the credentials hides the connection but keeps it, along with the National Insurance number and business, for when they're set again.

HMRC also requires fraud prevention details about the browser, device and network with every call. The app sends what it truthfully knows and leaves out the rest; **Settings → HMRC → Check with HMRC** lists anything HMRC says is missing.

## What it adds

- **Quarterly updates**: **Send to HMRC** shows the figures to confirm first, and HMRC takes an update from 10 days before its quarter ends. The page shows what HMRC expects and has received, and warns when a later change affects a quarter already sent.
- **HMRC's tax calculation** for the year so far appears on the Quarterly updates page, next to the app's own estimate.
- **Final declaration**: after the tax year ends and once HMRC has all four updates, ask HMRC to calculate. Check its figures, including the band-by-band workings, and agree to HMRC's declaration. This replaces the Self Assessment return and is due by 31 January. Report any other income in your HMRC online account first, because the app only covers the business.
- **Amendments**: until 12 months after the 31 January deadline, correct your books, send the corrected year's figures, and agree to HMRC's new calculation.

The app records who sent each update, declaration and amendment, when, and HMRC's reference. These records are kept in backups and can't be changed by hand, and stay visible if the credentials are removed. It refuses to send if the figures have changed since you checked them.
