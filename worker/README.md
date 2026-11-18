# Industry partner sign-in service

Haulers, growers and poultry businesses sign in with a 6-digit code sent to their email or phone. They don't need an ArcGIS account. MDA staff keep signing in with ArcGIS.

The service runs free on Cloudflare Workers.

## What it checks when someone registers

| Check | How |
|---|---|
| Email (and mobile) belong to them | A 6-digit code |
| Hauling company | USDOT number checked against FMCSA records. It looks at the legal name, whether the carrier is allowed to operate, and out-of-service orders. |
| Grower, breeder or seller | Maryland premises registration number and NPIP number matched to MDA's premises registry. It compares the name, operator and county. |
| Address | Found on the map and inside the region |
| Phone line | Mobile, landline or internet (VoIP) number, through Twilio Lookup (optional) |
| Work email | Whether the domain matches the company name, or it's a personal address |
| Duplicates and history | The same email, phone, USDOT or registration number on another request, plus any earlier denial or stop |
| Sponsored staff | Added by an active company administrator |

MDA then works through a checklist in the app (MDA menu → Reviews → Access requests). The checklist covers:
- Calling back on an official number
- Documents match
- The business is in good standing
- Premises registration, NPIP, USDOT, employer and licence, depending on the type of business
- Company administrator rights

The decision gets a note, which tools the person can use, and an end date (one year by default). MDA can approve, deny, or ask for more information; the applicant answers through a link and can add documents. Every step goes to the audit log.

## Set it up (about 30 minutes)

1. **Cloudflare**: create a free account at dash.cloudflare.com. On your computer, in this `worker` folder:
   ```
   npm install -g wrangler
   wrangler login
   wrangler kv namespace create KV        # paste the id into wrangler.toml
   ```
2. **Secrets.** Add each one with `wrangler secret put NAME`:
   - `SESSION_SECRET`: any long random text (40+ characters).
   - `ARCGIS_USERNAME` / `ARCGIS_PASSWORD`: an ArcGIS account that can edit the MD_HPAI layers. A separate "service" user is best; the layer owner also works.
   - `RESEND_API_KEY`: from resend.com (free for 3,000 emails a month). Verify your sending domain, then set `MAIL_FROM` in wrangler.toml.
   - Optional, for text codes: `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` (twilio.com; US numbers need A2P 10DLC registration).
   - Optional, for automatic USDOT checks: `FMCSA_WEBKEY`. Request one at mobile.fmcsa.dot.gov/QCDevsite; it needs a Login.gov account. Without it, MDA gets a link to the FMCSA record to check by hand.
3. **Settings in wrangler.toml**:
   - `APP_URL` and `APP_ORIGINS`: where the map is published.
   - `MDA_NOTIFY_EMAIL`: inbox told about new requests.
   - `SPONSOR_AUTO_APPROVE`: whether people a company administrator adds get access straight away.
4. **Publish**: `wrangler deploy`. Then copy the address it prints (https://md-hpai-signin.….workers.dev) into `js/config.js` → `auth.url`.
5. **Check**: open that address. It shows which parts are connected (email, sms, usdot, arcgis).

## Premises registration matching

Matching works best when MDA's premises registration list is in the registry (MDA menu → Premises → Registry → Import file). Fill the `md_reg_no` column with the registration number, and `npip_id` with the NPIP number. Without them, MDA checks the numbers by hand.

## Test

`node tests/worker.test.mjs` runs the whole flow (codes, registration, checks, approval, sign-in, own-records-only access, company administrators, stopping access) against fake services.
