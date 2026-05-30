# WillFM

A curated internet-radio player, as a static website. It's a browser port of a
PySide6 desktop app: a sidebar of stations grouped by genre/subgenre, an HTML5
audio player, live now-playing info where the browser allows it, and a personal
"Discovery List" saved in your browser.

## Run it

It's pure static files — open `index.html` through any web server:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

(Opening `index.html` directly via `file://` won't work because `fetch()` of
`stations.json` is blocked on the file protocol.)

## Hosting on GitHub Pages

Settings → Pages → Build and deployment → Source: **Deploy from a branch**,
branch **main**, folder **/ (root)**. The site appears at
`https://<user>.github.io/Radio/`.

## Honest limitations (browser security, not bugs)

A browser is a sandboxed, origin-restricted client; the original desktop app was
an unrestricted OS process. Two consequences:

1. **HTTP-only streams won't play.** GitHub Pages is HTTPS, and browsers block
   "mixed content" (HTTP media on an HTTPS page). 11 stations stream only over
   HTTP with no HTTPS equivalent — they're listed with a "no https" badge and a
   warning, but can't play here. The other 82 play fine (12 were auto-upgraded
   from HTTP to a working HTTPS URL).

2. **Most now-playing titles are unavailable in-page.** 75 stations embed
   now-playing as ICY metadata *inside the audio byte-stream*, which the browser
   never exposes to JavaScript. 3 Radio Paradise stations have a JSON API that
   blocks cross-origin requests (no CORS header). The remaining ~15 stations
   (KEXP, SomaFM, NTS, NPR Composer, Airtime) expose CORS-friendly JSON APIs and
   **do** show live titles + cover art. Stations without titles still play; they
   just display "(no track info)".

## Full metadata via a Worker (optional)

To get titles for all 93 stations, deploy a tiny serverless endpoint that does
the ICY byte-parsing and Radio Paradise fetch server-side (a browser can't), and
re-serves the result as JSON with CORS headers. A free Cloudflare Worker is
enough (100k requests/day, no card required).

The site is already wired for it: set `META_PROXY` near the top of `app.js` to
your Worker base URL. The site will call `${META_PROXY}/nowplaying?id=<station>`
and expects `{title, artist, art_url, show}`. CORS-friendly stations keep
fetching their own API directly, so the Worker only handles the ICY / Radio
Paradise ones.

The Worker (a server-side port of `metadata.py`) and step-by-step deploy
instructions live in **[`worker/`](./worker/)** — see [`worker/README.md`](./worker/README.md).
ICY parsing is best-effort per server: some stations resolve titles, some don't,
and a failure always degrades to "(no track info)" without affecting playback.

## Files

- `index.html` — markup
- `styles.css` — dark theme (genre = purple, subgenre = orange)
- `app.js` — all logic: sidebar, playback, metadata handlers, Discovery List
- `stations.json` — 93 stations with HTTPS upgrades + browser-capability flags
- `icon.png` — app icon

`stations.json` is generated from the desktop app's station list; each entry adds
`mixed_content` (true if HTTP-only/unplayable) and `meta_browser` (true if its
metadata API works directly in the browser).
