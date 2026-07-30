const fs = require("fs");
const os = require("os");
const path = require("path");
const { eapi, weapi } = require("./vendor/netease-crypto");

const API_DOMAIN = "https://interface.music.163.com";
const AUDIO_MATCH_URL = "https://interface.music.163.com/api/music/audio/match";
const USER_AGENT = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
const REQUEST_TIMEOUT_MS = 15000;

let wnmcid = `${Math.random().toString(36).slice(2, 8)}.${Date.now()}.01.0`;

function readAnonymousToken() {
  if (process.env.NETEASE_ANONYMOUS_TOKEN) return process.env.NETEASE_ANONYMOUS_TOKEN.trim();

  try {
    return fs.readFileSync(path.join(os.tmpdir(), "anonymous_token"), "utf8").trim();
  } catch {
    return "";
  }
}

function createHeader() {
  const anonymousToken = readAnonymousToken();
  const header = {
    osver: "16.2",
    deviceId: "",
    os: "iPhone OS",
    appver: "9.0.90",
    versioncode: "140",
    mobilename: "",
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: "1920x1080",
    __csrf: "",
    channel: "distribution",
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
  };
  if (anonymousToken) header.MUSIC_A = anonymousToken;
  return header;
}

function cookieHeader(header) {
  return Object.entries(header)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("; ");
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function requestEapi(uri, data) {
  const header = createHeader();
  const payload = { ...data, header };
  const encrypted = eapi(uri, payload);
  const url = `${API_DOMAIN}/eapi/${uri.slice("/api/".length)}`;

  return fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      Cookie: `${cookieHeader(header)}; WNMCID=${wnmcid}`,
    },
    body: new URLSearchParams(encrypted).toString(),
  });
}

async function requestWeapi(uri, data) {
  const encrypted = weapi(data);
  const url = `${API_DOMAIN}/weapi/${uri.slice("/api/".length)}`;

  return fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      Referer: API_DOMAIN,
    },
    body: new URLSearchParams(encrypted).toString(),
  });
}

async function audioMatch({ duration, audioFP }) {
  if (!duration || !audioFP) throw new Error("duration and audioFP are required");
  const url = new URL(AUDIO_MATCH_URL);
  url.searchParams.set("sessionId", "0123456789abcdef");
  url.searchParams.set("algorithmCode", "shazam_v2");
  url.searchParams.set("duration", String(duration));
  url.searchParams.set("rawdata", String(audioFP));
  url.searchParams.set("times", "1");
  url.searchParams.set("decrypt", "1");
  const response = await fetchJson(url.toString(), { headers: { "User-Agent": USER_AGENT } });
  return response?.data || response;
}

function lyricNew(id) {
  return requestEapi("/api/song/lyric/v1", {
    id: String(id),
    cp: false,
    tv: 0,
    lv: 0,
    rv: 0,
    kv: 0,
    yv: 0,
    ytv: 0,
    yrv: 0,
  });
}

function lyric(id) {
  return requestEapi("/api/song/lyric", {
    id: String(id),
    tv: -1,
    lv: -1,
    rv: -1,
    kv: -1,
    _nmclfl: 1,
  });
}

function search({ keywords, limit = 30, type = 1, offset = 0, cloud = false }) {
  if (!keywords) throw new Error("keywords is required");
  return requestEapi(cloud ? "/api/cloudsearch/pc" : "/api/search/get", {
    s: String(keywords),
    type: Number(type) || 1,
    limit: Number(limit) || 30,
    offset: Number(offset) || 0,
    ...(cloud ? { total: true } : {}),
  });
}

async function mvForSong({ id, r = 720 }) {
  if (!id) throw new Error("song id is required");

  const detail = await requestWeapi("/api/v3/song/detail", {
    c: JSON.stringify([{ id: Number(id) }]),
  });
  const song = detail?.songs?.[0];
  const mvId = Number(song?.mv || song?.mvid || 0);
  const durationMs = Number(song?.dt || song?.duration || 0);
  if (!mvId) return { code: 200, hasMv: false, songId: Number(id), durationMs };

  const urlData = await requestWeapi("/api/song/enhance/play/mv/url", {
    id: mvId,
    r: Number(r) || 720,
  });
  const mvUrl = urlData?.data?.url || "";
  return {
    code: 200,
    hasMv: Boolean(mvUrl),
    songId: Number(id),
    durationMs,
    mvId,
    url: mvUrl,
    r: Number(urlData?.data?.r || r || 720),
  };
}

module.exports = { audioMatch, lyric, lyricNew, search, mvForSong };
