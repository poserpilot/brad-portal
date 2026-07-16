# Deploy the portal Worker — step by step

Do these in a **native terminal** (git/wrangler don't run through the Cowork device bridge). You'll need Node + `wrangler` (`npm i -g wrangler`) and to be logged into Cloudflare (`wrangler login`). Run everything from inside the repo's `app/` folder.

Brad: run these one block at a time; paste me any output that doesn't look right.

### 1. Go to the app folder
```bash
cd path/to/brad-portal/app
```

### 2. Create the KV namespace
```bash
wrangler kv namespace create PORTAL_KV
```
Copy the `id = "…"` it prints, and paste it into `wrangler.toml` where it says `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Set the two secrets
Pick any strong random string for the write key (this authorizes adding/completing tasks). Save it — Claude sessions and the web UI need it.
```bash
wrangler secret put WRITE_KEY
# paste your chosen write key when prompted
```
Then the GitHub token — the **same fine-grained PAT you made for this repo** (scoped to `brad-portal` only, Contents **Read and write**):
```bash
wrangler secret put GITHUB_TOKEN
# paste the PAT when prompted
```

### 4. Deploy
```bash
wrangler deploy
```
It prints your URL, e.g. `https://brad-portal.<subdomain>.workers.dev`. Open it — you should see the portal with your seeded to-dos.

### 5. Tell me the URL + write key
Paste them back here (or just the URL). I'll:
- arm the 0800 ET daily brief to read from the API,
- drop the endpoint into the context-repo pointer so any Claude project can add to-dos,
- lock down access if you want (Cloudflare Access / a private route) instead of the workers.dev URL.

### Optional hardening (later)
- Put it behind **Cloudflare Access** (email-gated) so only you can open the UI.
- Add a custom route like `portal.halo.one` instead of `*.workers.dev`.
- Rotate `WRITE_KEY` any time with `wrangler secret put WRITE_KEY` + redeploy.
