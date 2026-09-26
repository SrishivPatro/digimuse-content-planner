# Digimuse Content Planner

Internal social media planning tool for the Digimuse team.

- **Brand Brain** for every client: products (auto-imported from the brand website), rules, references, reply bank, brand kit
- **AI monthly plans**: research, strategy, topical days, calendar and a written content deck
- **Content deck** with brand-coloured previews, hooks, captions, carousel slides and reel scripts
- **Design briefs** for designers, creative versions, publish checklist
- **Workflow**: board, due dates, My tasks, client review, feedback routed back to writer or designer
- **Performance**: log results, charts and an AI-written monthly report
- **Client deck**: research, strategy and post-by-post slides built from each plan. Present in the app, download PowerPoint, or save as PDF. Presets for full plan, research, strategy or content decks.
- **Exports**: Excel workbook, CSV, Markdown document, design briefs

## Deploy on Vercel

1. **Import**: vercel.com → Add New → Project → import this repo → Framework preset **Other** → Deploy.
2. **Database**: in the project, go to **Storage** → Create Database → **Upstash (Redis)** → connect it to this project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Environment variables** (Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | From aistudio.google.com/apikey |
   | `TEAM_PASSWORD` | The password your team will sign in with |
   | `GEMINI_MODEL` *(optional)* | Leave empty to use Google's latest Flash model. If Google retires a model, the app switches to the replacement automatically. |
   | `ANTHROPIC_API_KEY` *(optional)* | Use Claude instead of Gemini |
   | `AI_PROVIDER` *(optional)* | `gemini` or `claude` if both keys are set |
   | `CLAUDE_MODEL` *(optional)* | Defaults to `claude-sonnet-5` |

4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables load.
5. Share the URL and password with the team.

## How it's built

- `index.html`: the whole app (no build step).
- `api/sync.js`: loads all data (skips the download when nothing changed).
- `api/db.js`: saves, updates and deletes records.
- `api/ai.js`: sends prompts to Gemini or Claude. Keys never reach the browser.
- `api/login.js`: team password sign-in (30-day cookie).
- `api/scrape.js`: imports a brand's products from its website (Shopify and WooCommerce stores directly; any other site is read and the AI picks out products and services).

Data lives in Upstash Redis under keys starting with `dcp:`. Clients poll for changes every 30 seconds.
