"use strict";
/* WillFM web — static port of the PySide6 radio app.
 *
 * Playback: a single <audio> element replaces mpv.
 * Metadata: ported handlers for the APIs that permit browser (CORS) access —
 *   composer / kexp / somafm / nts / airtime. ICY and Radio Paradise can't be
 *   reached from a browser, so those stations degrade to "(no track info)".
 * Discovery List: persisted in localStorage instead of a JSON file. */

const META_REFRESH_MS = 15000;   // current station
const ALL_REFRESH_MS = 30000;    // background sweep of every station
const DISCOVERY_KEY = "willfm.discovery";

// Optional metadata proxy. Leave "" for pure GitHub Pages (only the ~15
// CORS-friendly stations show titles). Set to a deployed Cloudflare Worker
// base URL (no trailing slash) to light up ICY + Radio Paradise titles too.
// The site queries `${META_PROXY}/nowplaying?id=<station id>` expecting JSON
// {title, artist, art_url, show}. See README "Full metadata via a Worker".
const META_PROXY = "https://willfm-metadata.williamhspeiser.workers.dev";

// ---- DOM refs -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const player = $("player");
const sidebarEl = $("sidebar");
const layoutEl = $("layout");

// ---- state ----------------------------------------------------------------
let stations = [];
let stationsById = {};
let stationOrder = [];          // display-order ids for prev/next/shuffle
const rowEls = {};              // id -> sidebar row element
const nowEls = {};              // id -> the .st-now element in a row
let currentId = null;
let currentTrack = null;        // latest metadata for the "+" button
let userStopped = true;
let metaTimer = null;
let reconnectTimer = null;

// ===========================================================================
// Metadata handlers (ported from metadata.py)
// ===========================================================================
const TIMEOUT_MS = 6000;
const EMPTY = { title: "", artist: "", art_url: null, show: null };

function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function getJSON(url) {
  const { signal, done } = withTimeout(null, TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { done(); }
}

async function getText(url) {
  const { signal, done } = withTimeout(null, TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { done(); }
}

const _decoder = document.createElement("textarea");
function unescapeHTML(s) { _decoder.innerHTML = s; return _decoder.value; }

// Pattern 2: NPR Composer "now playing" widget
async function composerNow(widgetId) {
  const body = await getText(
    `https://api.composer.nprstations.org/v1/widget/${widgetId}/now`);
  const grab = (cls) => {
    const m = body.match(new RegExp(`class="whatson-${cls}"[^>]*>([^<]*)</`));
    return m ? unescapeHTML(m[1]).trim() : "";
  };
  let art = null;
  const am = body.match(/<img src="([^"]+)"[^>]*class="whatson-albumArt"/);
  if (am) art = am[1].replace("60x60bb", "300x300bb");
  const sm = body.match(/class="whatson-programName"[^>]*>([^<]*)<\/a>/);
  const show = sm ? unescapeHTML(sm[1]).trim() : null;
  return { title: grab("songTitle"), artist: grab("songArtist"), art_url: art, show };
}

// Pattern 3: KEXP JSON API
async function kexpNow() {
  const d = await getJSON("https://api.kexp.org/v2/plays/?limit=5");
  const results = d.results || [];
  if (!results.length) return { ...EMPTY };
  const inAirbreak = results[0].play_type === "airbreak";
  const track = results.find((p) => p.play_type === "trackplay");
  if (!track) return { title: "DJ talking", artist: "", art_url: null, show: "KEXP" };
  return {
    title: track.song || "",
    artist: track.artist || "",
    art_url: track.thumbnail_uri || track.image_uri || null,
    show: inAirbreak ? "DJ talking — last played" : null,
  };
}

// Pattern 4: SomaFM songs feed
async function somafmNow(channelId) {
  const d = await getJSON(`https://api.somafm.com/songs/${channelId}.json`);
  const songs = d.songs || [];
  if (!songs.length) return { ...EMPTY };
  const s = songs[0];
  return {
    title: s.title || "", artist: s.artist || "",
    art_url: s.albumart || null, show: s.album || null,
  };
}

// Pattern 6: NTS live API
async function ntsNow(channelIndex) {
  const d = await getJSON("https://www.nts.live/api/v2/live");
  const results = d.results || [];
  if (channelIndex >= results.length) return { ...EMPTY };
  const now = results[channelIndex].now || {};
  let art = null;
  try { art = now.embeds.details.media.background_medium_large; } catch (e) {}
  return {
    title: now.broadcast_title || "", artist: "", art_url: art,
    show: `NTS ${results[channelIndex].channel_name}`,
  };
}

// Pattern 7: Airtime live-info-v2
async function airtimeNow(baseUrl) {
  const d = await getJSON(`${baseUrl.replace(/\/$/, "")}/api/live-info-v2`);
  const cur = (d.tracks && d.tracks.current) || {};
  const name = cur.name || "";
  let artist = "", title = name;
  if (name.includes(" - ")) {
    const i = name.indexOf(" - ");
    artist = name.slice(0, i); title = name.slice(i + 3);
  }
  const show = (d.shows && d.shows.current && d.shows.current.name) || null;
  return { title: title.trim(), artist: artist.trim(), art_url: null, show };
}

// Proxy fetch: for ICY / Radio Paradise stations when META_PROXY is configured.
async function proxyNow(stationId) {
  const d = await getJSON(`${META_PROXY.replace(/\/$/, "")}/nowplaying?id=${encodeURIComponent(stationId)}`);
  return {
    title: d.title || "", artist: d.artist || "",
    art_url: d.art_url || null, show: d.show || null,
  };
}

// True if we have any way to get metadata for this station in the browser.
function canFetchMeta(s) { return s.meta_browser || !!META_PROXY; }

// Dispatch. CORS-friendly types fetch their API directly (no proxy load).
// Everything else goes through META_PROXY if configured, else unsupported.
async function fetchMeta(station) {
  const mt = station.metadata;
  switch (mt.type) {
    case "composer":
    case "composer+icy": return composerNow(mt.widget_id);
    case "kexp_api":     return kexpNow();
    case "somafm":       return somafmNow(mt.channel_id);
    case "nts":          return ntsNow(parseInt(mt.channel_index, 10));
    case "airtime":      return airtimeNow(mt.base_url);
    default:
      if (META_PROXY) return proxyNow(station.id);
      throw new Error("unsupported-in-browser");
  }
}

// ===========================================================================
// Sidebar construction (genre -> subgenre -> stations; News last; collapsed)
// ===========================================================================
function buildSidebar() {
  // group: genre -> subgenre("" bucket first) -> [stations]
  const byGenre = {};
  for (const s of stations) {
    const g = (byGenre[s.genre] = byGenre[s.genre] || {});
    const sub = s.subgenre || "";
    (g[sub] = g[sub] || []).push(s);
  }
  const genreSort = (a, b) => {
    const an = a === "News" ? 1 : 0, bn = b === "News" ? 1 : 0;
    return an - bn || a.localeCompare(b);
  };

  for (const genre of Object.keys(byGenre).sort(genreSort)) {
    if (genre === "News") {
      const hr = document.createElement("hr");
      hr.className = "news-divider";
      sidebarEl.appendChild(hr);
    }
    // genre header
    const gHdr = document.createElement("div");
    gHdr.className = "genre-header";
    gHdr.innerHTML = `<span class="caret">&#9654;</span><span>${genre}</span>`;
    sidebarEl.appendChild(gHdr);

    const gChildren = [];           // everything that collapses with this genre
    const subs = byGenre[genre];
    for (const sub of Object.keys(subs).sort()) {
      let subState = null;          // {hdr, stationEls, expanded}
      let subHdr = null;
      const subStationEls = [];
      if (sub) {
        subHdr = document.createElement("div");
        subHdr.className = "subgenre-header";
        subHdr.innerHTML = `<span class="caret">&#9654;</span><span>${sub}</span>`;
        sidebarEl.appendChild(subHdr);
        gChildren.push(subHdr);
        subState = { hdr: subHdr, stationEls: subStationEls, expanded: false };
      }
      for (const st of subs[sub]) {
        const row = makeStationRow(st);
        sidebarEl.appendChild(row);
        gChildren.push(row);
        subStationEls.push(row);
        rowEls[st.id] = row;
        stationOrder.push(st.id);
        // a station inside a subgenre is hidden until BOTH genre+sub expanded
        row.dataset.sub = sub;
      }
      if (sub) {
        subHdr.addEventListener("click", () => {
          subState.expanded = !subState.expanded;
          setCaret(subHdr, subState.expanded);
          for (const r of subStationEls) {
            r.classList.toggle("hidden", !subState.expanded);
          }
        });
        subHdr._state = subState;
      }
    }

    // genre toggle: show subheaders + sub-less stations; subgenre stations stay
    // hidden until their own subheader is opened.
    let gExpanded = false;
    gHdr.addEventListener("click", () => {
      gExpanded = !gExpanded;
      setCaret(gHdr, gExpanded);
      for (const el of gChildren) {
        if (!gExpanded) { el.classList.add("hidden"); continue; }
        if (el.classList.contains("station-row") && el.dataset.sub) {
          const sh = el.previousSubHeader;
          el.classList.toggle("hidden", !(sh && sh._state.expanded));
        } else {
          el.classList.remove("hidden");
        }
      }
    });
    gHdr._children = gChildren;
    gHdr._expandedRef = () => gExpanded;
    gHdr._setExpanded = (v) => { if (gExpanded !== v) gHdr.click(); };

    // wire each subgenre station to its preceding subheader for visibility logic
    let lastSubHdr = null;
    for (const el of gChildren) {
      if (el.classList.contains("subgenre-header")) lastSubHdr = el;
      else if (el.classList.contains("station-row") && el.dataset.sub) {
        el.previousSubHeader = lastSubHdr;
      }
    }
    // start collapsed
    for (const el of gChildren) el.classList.add("hidden");
  }
}

function setCaret(headerEl, expanded) {
  const c = headerEl.querySelector(".caret");
  if (c) c.innerHTML = expanded ? "&#9660;" : "&#9654;";
}

function makeStationRow(station) {
  const row = document.createElement("div");
  row.className = "station-row";
  if (station.mixed_content) row.classList.add("blocked");
  const badge = station.mixed_content
    ? `<span class="st-badge" title="This station streams only over HTTP and is blocked on an HTTPS site">no https</span>`
    : "";
  row.innerHTML =
    `<div class="st-name">${station.name}${badge}</div>` +
    `<div class="st-now">…</div>`;
  nowEls[station.id] = row.querySelector(".st-now");
  row.addEventListener("click", () => selectStation(station.id));
  return row;
}

// ===========================================================================
// Playback + selection
// ===========================================================================
function selectStation(id) {
  const s = stationsById[id];
  if (!s) return;
  currentId = id;
  currentTrack = null;

  // highlight
  for (const el of Object.values(rowEls)) el.classList.remove("active");
  if (rowEls[id]) {
    rowEls[id].classList.add("active");
    rowEls[id].scrollIntoView({ block: "nearest" });
  }

  $("station-name").textContent = s.name;
  $("tagline").textContent = s.tagline || "";
  $("np-title").textContent = "Loading…";
  $("np-artist").textContent = "";
  $("np-show").textContent = "";
  $("art").style.backgroundImage = "";
  $("add-btn").disabled = true;
  $("play-btn").disabled = false;

  const warn = $("np-warning");
  if (s.mixed_content) {
    warn.hidden = false;
    warn.textContent =
      "This station streams only over HTTP. Browsers block HTTP audio on an " +
      "HTTPS page, so it cannot play here. Try it in the desktop app.";
  } else {
    warn.hidden = true;
  }

  if (!canFetchMeta(s)) {
    setStatus(s.metadata.type === "radioparadise"
      ? "Now-playing unavailable (Radio Paradise blocks cross-origin requests)."
      : "Now-playing unavailable for this station in the browser.");
  } else {
    setStatus("");
  }

  startPlayback(s);
  refreshMeta();
  startMetaTimer();
}

function startPlayback(s) {
  if (s.mixed_content) {
    $("play-btn").textContent = "Play";
    setStatus("Cannot play HTTP stream on an HTTPS site.");
    return;
  }
  clearTimeout(reconnectTimer);
  userStopped = false;
  player.src = s.stream_url;
  player.volume = $("vol").value / 100;
  player.play().then(() => {
    $("play-btn").textContent = "Stop";
    setStatus("Playing");
  }).catch((e) => {
    setStatus("Playback error: " + e.message);
    $("play-btn").textContent = "Play";
  });
}

function togglePlay() {
  if (!currentId) return;
  const s = stationsById[currentId];
  if ($("play-btn").textContent === "Stop") {
    userStopped = true;
    player.pause();
    player.removeAttribute("src");
    player.load();
    $("play-btn").textContent = "Play";
    stopMetaTimer();
    setStatus("Stopped");
  } else {
    startPlayback(s);
    refreshMeta();
    startMetaTimer();
  }
}

// Live streams never legitimately "end"; on a network drop the audio element
// fires 'error'/'stalled'. Reconnect unless the user pressed Stop.
player.addEventListener("error", scheduleReconnect);
player.addEventListener("ended", scheduleReconnect);
function scheduleReconnect() {
  if (userStopped || !currentId) return;
  const s = stationsById[currentId];
  if (!s || s.mixed_content) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (userStopped || !currentId) return;
    setStatus(`Reconnecting to ${s.name}…`);
    player.src = s.stream_url;
    player.play().catch(() => {});
  }, 1500);
}

// ---- prev / next / shuffle ----
function currentIndex() {
  return currentId ? stationOrder.indexOf(currentId) : -1;
}
function tuneByIndex(idx) {
  if (idx < 0 || idx >= stationOrder.length) return;
  const id = stationOrder[idx];
  const s = stationsById[id];
  // auto-expand containing genre + subgenre so the row is visible
  expandTo(s);
  selectStation(id);
}
function expandTo(s) {
  // find the genre header whose children include this row, expand it, then sub
  const row = rowEls[s.id];
  if (!row) return;
  // expand genre
  for (const hdr of sidebarEl.querySelectorAll(".genre-header")) {
    if (hdr._children && hdr._children.includes(row)) {
      if (!hdr._expandedRef()) hdr.click();
      break;
    }
  }
  // expand subgenre
  if (row.dataset.sub && row.previousSubHeader) {
    const sh = row.previousSubHeader;
    if (!sh._state.expanded) sh.click();
  }
}
function playPrev() {
  if (!stationOrder.length) return;
  const cur = currentIndex();
  tuneByIndex(cur < 0 ? 0 : (cur - 1 + stationOrder.length) % stationOrder.length);
}
function playNext() {
  if (!stationOrder.length) return;
  const cur = currentIndex();
  tuneByIndex(cur < 0 ? 0 : (cur + 1) % stationOrder.length);
}
function playShuffle() {
  if (!stationOrder.length) return;
  const cur = currentIndex();
  const choices = [];
  for (let i = 0; i < stationOrder.length; i++) if (i !== cur) choices.push(i);
  if (!choices.length) return;
  tuneByIndex(choices[Math.floor(Math.random() * choices.length)]);
}

// ===========================================================================
// Metadata polling
// ===========================================================================
function startMetaTimer() {
  stopMetaTimer();
  metaTimer = setInterval(refreshMeta, META_REFRESH_MS);
}
function stopMetaTimer() {
  if (metaTimer) { clearInterval(metaTimer); metaTimer = null; }
}

async function refreshMeta() {
  if (!currentId) return;
  const s = stationsById[currentId];
  if (!canFetchMeta(s)) return;
  try {
    const info = await fetchMeta(s);
    updateSidebarNow(s.id, info);
    if (s.id !== currentId) return;
    currentTrack = info;
    applyNowPlaying(info);
  } catch (e) {
    if (s.id === currentId) setStatus("Metadata error: " + e.message, true);
  }
}

function applyNowPlaying(info) {
  $("np-title").textContent = info.title || "—";
  $("np-artist").textContent = info.artist || "";
  $("np-show").textContent = info.show ? "On now: " + info.show : "";
  $("add-btn").disabled = !(info.title || "").trim();
  if (info.art_url) {
    $("art").style.backgroundImage = `url("${info.art_url}")`;
  } else {
    $("art").style.backgroundImage = "";
  }
}

function updateSidebarNow(id, info) {
  const el = nowEls[id];
  if (!el) return;
  const t = info.title || "", a = info.artist || "";
  let text = "(no info)";
  if (t && a) text = `${t} — ${a}`;
  else if (t) text = t;
  el.textContent = text;
  el.title = text;
}

// Background sweep so the sidebar shows what's on every (supported) station.
// Sequential to avoid hammering several APIs at once, mirroring the desktop app.
let sweeping = false;
async function sweepAll() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const s of stations) {
      if (!canFetchMeta(s)) continue;
      try {
        const info = await fetchMeta(s);
        updateSidebarNow(s.id, info);
      } catch (e) { /* one bad station shouldn't stop the rest */ }
    }
  } finally { sweeping = false; }
}

// ===========================================================================
// Discovery List (localStorage)
// ===========================================================================
function loadDiscovery() {
  try { return JSON.parse(localStorage.getItem(DISCOVERY_KEY)) || []; }
  catch (e) { return []; }
}
function saveDiscovery(list) {
  localStorage.setItem(DISCOVERY_KEY, JSON.stringify(list));
}
function addToDiscovery() {
  const t = currentTrack;
  if (!t || !(t.title || "").trim()) {
    setStatus("Nothing to add yet — wait for track info");
    return;
  }
  const title = t.title.trim();
  const artist = (t.artist || "").trim();
  const list = loadDiscovery();
  if (list.some((e) => e.title === title && e.artist === artist)) {
    setStatus("Already in your Discovery List");
    return;
  }
  const stationName = currentId && stationsById[currentId]
    ? stationsById[currentId].name : "";
  list.push({
    title, artist, station: stationName,
    added_at: new Date().toISOString(),
  });
  saveDiscovery(list);
  renderDiscovery();
  setStatus("Added: " + title);
}
function deleteDiscovery(entry) {
  let list = loadDiscovery();
  list = list.filter((e) =>
    !(e.title === entry.title && e.artist === entry.artist && e.added_at === entry.added_at));
  saveDiscovery(list);
  renderDiscovery();
}
function renderDiscovery() {
  const list = loadDiscovery();
  const ul = $("discovery-list");
  ul.innerHTML = "";
  $("discovery-empty").style.display = list.length ? "none" : "block";
  ul.style.display = list.length ? "block" : "none";
  // newest first
  for (const entry of [...list].reverse()) {
    const li = document.createElement("li");
    li.className = "disc-item";
    let dateStr = entry.added_at;
    try {
      const d = new Date(entry.added_at);
      dateStr = d.toLocaleString(undefined,
        { month: "short", day: "numeric", year: "numeric",
          hour: "numeric", minute: "2-digit" });
    } catch (e) {}
    const metaLine = entry.station ? `${dateStr} · ${entry.station}` : dateStr;
    li.innerHTML =
      `<button class="disc-del" title="Delete">&times;</button>` +
      `<div class="disc-title">${escapeHTML(entry.title || "(untitled)")}</div>` +
      (entry.artist ? `<div class="disc-artist">${escapeHTML(entry.artist)}</div>` : "") +
      `<div class="disc-meta">${escapeHTML(metaLine)}</div>`;
    li.querySelector(".disc-title").addEventListener("click", () => {
      const q = [entry.title, entry.artist].filter(Boolean).join(" ");
      window.open("https://www.youtube.com/results?search_query=" +
        encodeURIComponent(q), "_blank");
    });
    li.querySelector(".disc-del").addEventListener("click", () => deleteDiscovery(entry));
    ul.appendChild(li);
  }
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===========================================================================
// Misc UI wiring
// ===========================================================================
let statusTimer = null;
function setStatus(msg, transient) {
  $("status").textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  if (transient || msg === "Playing") {
    statusTimer = setTimeout(() => { $("status").textContent = ""; }, 4000);
  }
}

function wireControls() {
  $("play-btn").addEventListener("click", togglePlay);
  $("add-btn").addEventListener("click", addToDiscovery);
  $("prev-btn").addEventListener("click", playPrev);
  $("next-btn").addEventListener("click", playNext);
  $("shuffle-btn").addEventListener("click", playShuffle);
  $("vol").addEventListener("input", (e) => { player.volume = e.target.value / 100; });
  $("discovery-toggle").addEventListener("click", () => {
    const open = layoutEl.classList.toggle("show-discovery");
    $("discovery").classList.toggle("collapsed", !open);
    $("discovery-toggle").classList.toggle("active", open);
  });
}

// ===========================================================================
// Init
// ===========================================================================
async function init() {
  wireControls();
  renderDiscovery();
  try {
    const data = await getJSON("stations.json");
    stations = data.stations;
    stationsById = Object.fromEntries(stations.map((s) => [s.id, s]));
    buildSidebar();
  } catch (e) {
    setStatus("Failed to load stations.json: " + e.message);
    return;
  }
  // initial + periodic background sweep so sidebar shows now-playing
  setTimeout(sweepAll, 300);
  setInterval(sweepAll, ALL_REFRESH_MS);
}

init();
