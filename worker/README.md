# WillFM metadata Worker

A free Cloudflare Worker that gives **all 93 stations** live now-playing titles,
including the 75 ICY stations and 3 Radio Paradise stations the browser can't
read on its own. It's a server-side port of the desktop app's `metadata.py`.

Once deployed, the Pages site calls `https://<your-worker>/nowplaying?id=<id>`
and gets back `{title, artist, art_url, show}` with CORS headers.

**Cost:** free tier = 100,000 requests/day, no credit card. A personal radio app
won't come close.

---

## Deploy — Option 1: dashboard copy-paste (no tools, ~3 min)

1. Go to **dash.cloudflare.com → Workers & Pages → Create → Create Worker**.
2. Name it (e.g. `willfm-metadata`) and click **Deploy** to make the starter.
3. Click **Edit code**, delete the starter, paste the entire contents of
   [`worker.js`](./worker.js), and click **Deploy**.
4. (Optional) If your repo/branch isn't `WilliamHSpeiser/Radio@main`, set the
   station source: **Settings → Variables → Add variable**, name `STATIONS_URL`,
   value = raw URL of your `stations.json`. (Otherwise it uses the default baked
   into the code.)
5. Copy your Worker URL — it looks like
   `https://willfm-metadata.<your-subdomain>.workers.dev`.

## Deploy — Option 2: Wrangler CLI

```bash
npm install -g wrangler
cd worker
wrangler login          # opens a browser to authorize
wrangler deploy         # uses wrangler.toml
```

Wrangler prints the deployed URL on success.

---

## Point the site at it

Edit `app.js` in the repo root, set the proxy URL (no trailing slash):

```js
const META_PROXY = "https://willfm-metadata.<your-subdomain>.workers.dev";
```

Commit and push; GitHub Pages redeploys in a minute. Now every station resolves
titles: the ~15 CORS-friendly ones still fetch their own API directly (zero
Worker load), and the ICY / Radio Paradise ones route through the Worker.

## Quick test

```bash
# WKCR is an ICY station — the hard case:
curl "https://willfm-metadata.<your-subdomain>.workers.dev/nowplaying?id=wkcr"
# A Radio Paradise station:
curl "https://willfm-metadata.<your-subdomain>.workers.dev/nowplaying?id=radioparadise_main"
```

You should get JSON like `{"title":"…","artist":"…","art_url":null,"show":null}`.

## Honest caveats

- ICY parsing reads the raw stream the same way `metadata.py` does, and it works
  in the Workers runtime in principle — but I could not test it inside Cloudflare
  from here. Some Icecast servers behave oddly (no `icy-metaint`, odd framing);
  those return empty metadata, and the site just shows "(no track info)" as
  before. It never breaks playback.
- Radio Paradise via the Worker is reliable (clean JSON API).
- The Worker fetches each ICY stream briefly to read metadata, which counts as
  outbound traffic. At a 15-30s poll cadence this is tiny, but it's why the site
  only routes non-CORS stations here.
