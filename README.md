# LUMI by Digimuse

Internal social media planning tool for the Digimuse team.

**LUMI** is Digimuse's internal content tool, and **Lumi** is its built-in intelligence: it researches, plans, writes and designs, always from each client's Brand Brain. Under the hood it runs on Gemini (or Claude) through the keys set in Vercel.

- **Brand Brain** for every client: products (auto-imported from the brand website), rules, references, reply bank, brand kit
- **Monthly plans by Lumi**: web-researched trends and competitors, a creative reference board of real campaigns (Pinterest, Behance, other brands), strategy on your chosen content pillars, your exact content mix and product focus, and a creative director review that rewrites weak posts
- **Content deck** with brand-coloured previews, hooks, captions, carousel slides and reel scripts
- **Design briefs** for designers, creative versions, publish checklist
- **Workflow**: board, due dates, My tasks, client review, feedback routed back to writer or designer
- **Competitor benchmarking**: track or let Lumi scout competitors, pull their last 30–90 days of Instagram and LinkedIn posts, compare cadence, formats, pillars and top posts, find gaps and ideas to adapt
- **Reports**: monthly client reports with KPIs, top posts, pillar and format learnings, competitor watch and next-month actions, downloadable as PowerPoint
- **Performance**: log results, charts and a monthly report written by Lumi
- **Client deck**: research, strategy and post-by-post slides built from each plan. Present in the app, download PowerPoint, or save as PDF. Presets for full plan, research, strategy or content decks.
- **Exports**: Excel workbook, CSV, Markdown document, design briefs

## Features

- **Brand Brain** per client: industry-aware products (projects, loans, courses…), must-include lines (RERA, disclaimers), rules, references, hashtag & CTA bank, logo
- **Monthly plans**: research, strategy, topical days (tick to include), content mix or weekly schedule, regional language versions, creative-director review
- **Posts**: caption moods and versions, reel shot lists, language versions, version history, design references with thumbnails
- **Decks**: client deck (4 themes), designer deck (one table slide per post), research, brief, pitch and report decks; platform filter on exports
- **Research lab** + **weekly trend alert** (Mondays 9 am IST) feeding the Ideas bank; one-click write from any idea
- **Briefs** (upload PDF / Word / text, Lumi plans the response and tasks) and **Pitch mode** (sample plan and pitch deck for prospects, convert to client)
- **Competitors**, **Instagram results import**, **monthly reports**, **retainer tracker**
- **Lumi creatives** (optional): Lumi art-directs and designs every post uniquely — visual style (photo, still life, flat lay, lifestyle, macro, collage, illustration, 3D, graphic, paper-cut), layout family, text placement and width, type scale, font pairing, emphasis and decoration — and avoids repeating the brand's recent creatives. The image is generated for that design; the tool sets the exact text, logo and must-include line where the image is calm, with contrast-safe colours. **Design editor** with live preview: position (9 spots or auto), width, size, align, fonts, caps, text and panel colours, highlight words, label, CTA style, decoration, logo position, show/hide parts, per carousel slide. **Change the image**: use your own photo (no image cost) or regenerate with a note. **Carousels**: text slides in the same design (free) or an AI image on every slide as one visual series. **Size**: auto from platform and format, or 1:1, 4:5, 9:16, 16:9 per post. Language versions keep the design; exports offer images or copy only.
- **Chat with Lumi** (lite model, lean context, daily limit per person set by admins; from anywhere: sidebar or the button at the bottom right): knows the client, plan and post you have open; brainstorms, writes, critiques, researches (optional web search with sources) and explains the tool. Ideas save to the Ideas bank in one click; rewritten captions, hooks, headlines and hashtags apply straight to the open post.
- **Team**: personal logins, activity log, Lumi usage and cost per client (admins only), search everything (Ctrl/⌘ K), light and dark mode

## Deploy on Vercel

1. **Import**: vercel.com → Add New → Project → import this repo → Framework preset **Other** → Deploy.
2. **Database**: in the project, go to **Storage** → Create Database → **Upstash (Redis)** → connect it to this project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Environment variables** (Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | From aistudio.google.com/apikey |
   | `TEAM_PASSWORD` | Owner password. Sign in with username `owner` and this password, then create a personal login for each person on the Team page. |
   | `GEMINI_MODEL` *(optional)* | Leave empty to use Google's latest Flash model. If Google retires a model, the app switches to the replacement automatically. |
   | `META_ACCESS_TOKEN` + `META_IG_USER_ID` *(optional, free)* | Real Instagram competitor data (followers, likes, comments, views) through Instagram's official Business Discovery API. Setup below. |
| `APIFY_TOKEN` *(optional, paid)* | Only if you later want automated LinkedIn posts. Not needed: LinkedIn posts can be pasted in the Competitors tab. |
| `CRON_SECRET` *(needed for weekly trend alerts)* | Any long random string. Vercel sends it to the weekly job so nobody else can trigger it. |
| `BLOB_READ_WRITE_TOKEN` *(recommended for creatives)* | Added automatically when you create a **Blob** store (Storage → Create → Blob) and connect it. Without it, creatives are stored in Redis (max ~900 KB each). |
| `GEMINI_IMAGE_MODEL` *(optional)* | Image model for creatives. Defaults to `gemini-2.5-flash-image`. Image generation needs Gemini billing on (about $0.039 per image). |
| `BACKUP_KEY` *(optional)* | Secret used to encrypt backups. If not set, `SESSION_SECRET` is used. Changing it makes older backups unreadable. |
| `GEMINI_API_KEY_FREE` *(recommended)* | A second Gemini key from a Google project **without billing** (free tier). Text (plans, posts, research, chat) runs on it first; the paid key covers images, overflow when the free tier is busy or out for the day, and anything the free key can't do. If the paid key runs out of credit, text keeps working on the free key. Admins choose the mode on Team → Free key vs paid key. Note: Google may use free-tier prompts to improve its products. |
| `GEMINI_MODEL_CHAT` *(optional)* | Model for Chat with Lumi. Defaults to `gemini-flash-lite-latest` (about ₹0.03 a message). |
| `LUMI_CHAT_DAILY` *(optional)* | Default chat messages per person per day (40). Admins can change it on Team → Lumi usage. |
| `ANTHROPIC_API_KEY` *(optional)* | Use Claude instead of Gemini |
   | `AI_PROVIDER` *(optional)* | `gemini` or `claude` if both keys are set |
   | `CLAUDE_MODEL` *(optional)* | Defaults to `claude-sonnet-5` |

4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables load.
5. Sign in as `owner`, open **Team → Logins** and create a login for each person. Share the link, their username and the temporary password privately. They set their own password on first sign-in.

### Backups

- Automatic, once a day (the first time anyone opens the tool), to the Blob store, encrypted with AES-256-GCM. The newest 30 are kept.
- Team → **Backups** (admins): Back up now, restore any backup (type RESTORE; a safety copy is taken first; existing logins are kept), and **Download everything** as a readable .json to keep in Google Drive monthly.
- Code: `api/_backup.js`, routes in `api/log.js`.

### Logins

- Every person has their own username and password (stored hashed with scrypt, never in the synced data).
- Admins create, reset, disable and delete logins. Resetting or disabling signs that person out everywhere.
- 8 wrong passwords lock that username for 15 minutes.
- `owner` + `TEAM_PASSWORD` always works as the break-glass admin login. Changing `TEAM_PASSWORD` in Vercel signs the owner out everywhere.
- Optional `SESSION_SECRET` variable: set a long random string to sign session cookies with your own secret.

## How it's built

The Vercel Hobby plan allows 12 server functions per deployment; the app uses 11 (`api/_lib.js` is shared code, not a function). Merge endpoints rather than adding new files.


- `index.html`: the whole app (no build step).
- `api/sync.js`: loads all data (skips the download when nothing changed).
- `api/db.js`: saves, updates and deletes records.
- `api/ai.js`: sends prompts to Gemini or Claude. Keys never reach the browser.
- `api/og.js`: checks design reference links (Pinterest, Behance, etc.) really open and returns their preview image for the designer deck.
- `api/login.js`: sign-in and sign-out (30-day signed session cookie).
- `api/users.js`: personal logins: create, reset, disable, change password.
- `api/log.js`: activity log, post version history, and Lumi cost per client (`?usage=1`, admins only).
- `api/cron.js`: weekly trend alert. Scheduled in `vercel.json` for Monday 03:30 UTC (9:00 IST); needs `CRON_SECRET`.
- `api/image.js`: generates creative backgrounds (Gemini image model), saves, serves and deletes creatives and product photos.
- `api/og.js`, `api/scrape.js`, `api/bench.js`: reference link checks, website product import, competitor and Instagram data.
- `api/bench.js`: pulls competitors' recent Instagram and LinkedIn posts through Apify.
- `api/scrape.js`: imports a brand's products from its website (Shopify and WooCommerce stores directly; any other site is read and Lumi picks out products and services).

Data lives in Upstash Redis under keys starting with `dcp:`. Clients poll for changes every 30 seconds.

## Free Instagram competitor data (Meta Business Discovery)

Works for competitors with an Instagram **business or creator** account (most brands). About 20–30 minutes, once.

1. **Instagram**: make sure your agency Instagram is a Professional account (Settings → Account type) and is linked to a Facebook Page you manage.
2. **Meta app**: go to developers.facebook.com → My Apps → Create app → choose the **Business** type (or "Other" then "Business"). Add the product **Instagram** → *API setup with Facebook login*.
3. **Token**: open the Graph API Explorer (developers.facebook.com/tools/explorer), select your app, click *Generate Access Token* and allow: `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `business_management`.
4. **Make it long-lived**: in the Access Token Debugger (developers.facebook.com/tools/debug/accesstoken) paste the token and click *Extend Access Token* (about 60 days). For a token that does not expire, run `me/accounts` in the Explorer with the extended token and copy your Page's `access_token`.
5. **Your Instagram user ID**: in the Explorer run `me/accounts?fields=instagram_business_account{id,username}` and copy the `id`.
6. **Vercel**: add `META_ACCESS_TOKEN` (the token) and `META_IG_USER_ID` (the id), then Redeploy.
7. **Test**: open any brand → Competitors → *Check Instagram connection*.

If the token expires, the benchmark shows "Instagram: … token …" next to each competitor. Repeat step 3–4 and update the value in Vercel.

LinkedIn has no free API for reading other companies' posts, so paste them in the Competitors tab (the planner counts reactions, comments and reposts itself).
