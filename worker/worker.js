/* WillFM metadata Worker — Cloudflare Worker that returns now-playing JSON for
 * any station, with CORS headers so the static GitHub Pages site can read it.
 *
 * This is a server-side port of the desktop app's metadata.py. It exists to do
 * the two things a browser can't:
 *   1. Read ICY metadata out of the raw audio byte-stream (browsers hide it).
 *   2. Fetch APIs that don't send CORS headers (e.g. Radio Paradise).
 *
 * Endpoint:  GET /nowplaying?id=<station id>
 * Response:  { "title": str, "artist": str, "art_url": str|null, "show": str|null }
 *
 * It loads the same stations.json the site uses (STATIONS_URL var), so there's
 * no station list to keep in sync here.
 */

const UA = { "User-Agent": "Mozilla/5.0 RadioApp/0.1" };
const TIMEOUT_MS = 8000;
const EMPTY = { title: "", artist: "", art_url: null, show: null };

const DEFAULT_STATIONS_URL =
  "https://raw.githubusercontent.com/WilliamHSpeiser/Radio/main/stations.json";

// Cache the station list per isolate so we don't refetch on every request.
let _stationsCache = null;
let _stationsAt = 0;
const STATIONS_TTL_MS = 10 * 60 * 1000;

async function getStations(env) {
  const now = Date.now();
  if (_stationsCache && now - _stationsAt < STATIONS_TTL_MS) return _stationsCache;
  const url = (env && env.STATIONS_URL) || DEFAULT_STATIONS_URL;
  const r = await fetch(url, { headers: UA, cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error("stations.json HTTP " + r.status);
  const data = await r.json();
  _stationsCache = {};
  for (const s of data.stations) _stationsCache[s.id] = s;
  _stationsAt = now;
  return _stationsCache;
}

// ---- small fetch helpers --------------------------------------------------
function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
async function getJSON(url) {
  const r = await fetch(url, { headers: UA, signal: timeoutSignal(TIMEOUT_MS) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: UA, signal: timeoutSignal(TIMEOUT_MS) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}
function unescapeHTML(s) {
  return s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g,
            (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ===========================================================================
// Pattern 1: ICY metadata embedded in the audio stream
// ===========================================================================
async function readExact(reader, n, state) {
  // Pull from the stream until `state.buf` holds at least n bytes, then split.
  while (state.buf.length < n) {
    const { done, value } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(state.buf.length + value.length);
    merged.set(state.buf); merged.set(value, state.buf.length);
    state.buf = merged;
  }
  const out = state.buf.slice(0, n);
  state.buf = state.buf.slice(n);
  return out;
}

async function icyTitle(streamUrl, maxBlocks = 6) {
  const r = await fetch(streamUrl, {
    headers: { ...UA, "Icy-MetaData": "1" },
    signal: timeoutSignal(TIMEOUT_MS),
  });
  const metaint = parseInt(r.headers.get("icy-metaint") || "0", 10);
  if (!metaint || !r.body) { try { r.body && r.body.cancel(); } catch (e) {} return { ...EMPTY }; }
  const reader = r.body.getReader();
  const state = { buf: new Uint8Array(0) };
  const dec = new TextDecoder("utf-8", { fatal: false });
  let title = "";
  try {
    for (let i = 0; i < maxBlocks; i++) {
      await readExact(reader, metaint, state);        // skip the audio block
      const lenByte = await readExact(reader, 1, state);
      const metaLen = (lenByte.length ? lenByte[0] : 0) * 16;
      if (!metaLen) continue;
      const metaBytes = await readExact(reader, metaLen, state);
      const meta = dec.decode(metaBytes).replace(/\x00+$/, "");
      const m = meta.match(/StreamTitle='([^']*)'/);
      if (m && m[1]) { title = m[1]; break; }
    }
  } finally {
    try { await reader.cancel(); } catch (e) {}
  }
  return parseIcyTitle(title);
}

const ICY_BLANK_MARKERS = ["no recent track data", "no track data", "(unknown)"];

function parseIcyTitle(raw) {
  const s = (raw || "").trim();
  if (!s) return { ...EMPTY };
  const low = s.toLowerCase();
  if (ICY_BLANK_MARKERS.some((m) => low.includes(m))) return { ...EMPTY };
  // iHeart pattern: many key="value" pairs; song_spot marks promos/sweepers.
  if (s.includes("song_spot=") || s.includes("spotInstanceId=")) {
    const fields = {};
    for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) fields[m[1]] = m[2];
    const text = fields.text || fields.title || "";
    const artist = fields.artist || "";
    if (["T", "F"].includes((fields.song_spot || "").toUpperCase())) {
      return { title: text || "(station promo)", artist: "", art_url: null, show: "non-music segment" };
    }
    return { title: text, artist, art_url: null, show: null };
  }
  if (s.includes(" - ")) {
    const i = s.indexOf(" - ");
    return { title: s.slice(i + 3).trim(), artist: s.slice(0, i).trim(), art_url: null, show: null };
  }
  return { title: s, artist: "", art_url: null, show: null };
}

// ===========================================================================
// Patterns 2-7 (port of metadata.py — these mostly work in-browser too, but
// the Worker handles them so it's a complete one-stop metadata source)
// ===========================================================================
async function composerNow(widgetId) {
  const body = await getText(`https://api.composer.nprstations.org/v1/widget/${widgetId}/now`);
  const grab = (cls) => {
    const m = body.match(new RegExp(`class="whatson-${cls}"[^>]*>([^<]*)</`));
    return m ? unescapeHTML(m[1]).trim() : "";
  };
  let art = null;
  const am = body.match(/<img src="([^"]+)"[^>]*class="whatson-albumArt"/);
  if (am) art = am[1].replace("60x60bb", "300x300bb");
  const sm = body.match(/class="whatson-programName"[^>]*>([^<]*)<\/a>/);
  return {
    title: grab("songTitle"), artist: grab("songArtist"),
    art_url: art, show: sm ? unescapeHTML(sm[1]).trim() : null,
  };
}
async function composerOrIcy(station) {
  const info = await composerNow(station.metadata.widget_id);
  if (info.title) return info;
  const fb = await icyTitle(station.stream_url);
  if (fb.title) { fb.show = info.show; return fb; }
  return info;
}
async function kexpNow() {
  const d = await getJSON("https://api.kexp.org/v2/plays/?limit=5");
  const results = d.results || [];
  if (!results.length) return { ...EMPTY };
  const inAir = results[0].play_type === "airbreak";
  const track = results.find((p) => p.play_type === "trackplay");
  if (!track) return { title: "DJ talking", artist: "", art_url: null, show: "KEXP" };
  return {
    title: track.song || "", artist: track.artist || "",
    art_url: track.thumbnail_uri || track.image_uri || null,
    show: inAir ? "DJ talking — last played" : null,
  };
}
async function somafmNow(channelId) {
  const d = await getJSON(`https://api.somafm.com/songs/${channelId}.json`);
  const songs = d.songs || [];
  if (!songs.length) return { ...EMPTY };
  const s = songs[0];
  return { title: s.title || "", artist: s.artist || "", art_url: s.albumart || null, show: s.album || null };
}
async function radioParadiseNow(chan) {
  const d = await getJSON(`https://api.radioparadise.com/api/now_playing?chan=${chan}`);
  return {
    title: d.title || "", artist: d.artist || "",
    art_url: d.cover_med || d.cover || null, show: d.album || null,
  };
}
async function ntsNow(channelIndex) {
  const d = await getJSON("https://www.nts.live/api/v2/live");
  const results = d.results || [];
  if (channelIndex >= results.length) return { ...EMPTY };
  const now = results[channelIndex].now || {};
  let art = null;
  try { art = now.embeds.details.media.background_medium_large; } catch (e) {}
  return { title: now.broadcast_title || "", artist: "", art_url: art, show: `NTS ${results[channelIndex].channel_name}` };
}
async function airtimeNow(baseUrl) {
  const d = await getJSON(`${baseUrl.replace(/\/$/, "")}/api/live-info-v2`);
  const cur = (d.tracks && d.tracks.current) || {};
  const name = cur.name || "";
  let artist = "", title = name;
  if (name.includes(" - ")) { const i = name.indexOf(" - "); artist = name.slice(0, i); title = name.slice(i + 3); }
  const show = (d.shows && d.shows.current && d.shows.current.name) || null;
  return { title: title.trim(), artist: artist.trim(), art_url: null, show };
}

async function fetchMeta(station) {
  const mt = station.metadata;
  switch (mt.type) {
    case "icy":           return icyTitle(station.stream_url);
    case "composer":      return composerNow(mt.widget_id);
    case "composer+icy":  return composerOrIcy(station);
    case "kexp_api":      return kexpNow();
    case "somafm":        return somafmNow(mt.channel_id);
    case "radioparadise": return radioParadiseNow(parseInt(mt.chan, 10));
    case "nts":           return ntsNow(parseInt(mt.channel_index, 10));
    case "airtime":       return airtimeNow(mt.base_url);
    case "none":          return { title: "(no track info)", artist: "", art_url: null, show: null };
    default:              throw new Error("unknown metadata type: " + mt.type);
  }
}

// ===========================================================================
// HTTP entrypoint
// ===========================================================================
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== "/nowplaying") {
      return json({ error: "use /nowplaying?id=<station id>" }, 404);
    }
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "missing id" }, 400);
    try {
      const stations = await getStations(env);
      const station = stations[id];
      if (!station) return json({ error: "unknown station: " + id }, 404);
      const info = await fetchMeta(station);
      return json(info);
    } catch (e) {
      // Return empty-but-valid metadata on failure so the site degrades quietly.
      return json({ ...EMPTY, error: String(e && e.message || e) }, 200);
    }
  },
};
