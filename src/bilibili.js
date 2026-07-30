const BILIBILI_API = "https://api.bilibili.com";
const BILIBILI_REFERER = "https://www.bilibili.com/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15000;
const fs = require("fs");

let videoRulesCache = { file: "", mtimeMs: -1, rules: { blacklist: [], whitelist: [] } };

function readVideoRules(file) {
  const emptyRules = { blacklist: [], whitelist: [] };
  if (!file) return emptyRules;
  try {
    const stat = fs.statSync(file);
    if (videoRulesCache.file === file && videoRulesCache.mtimeMs === stat.mtimeMs) return videoRulesCache.rules;

    const rules = { blacklist: [], whitelist: [] };
    let section = "blacklist"; // Legacy files without sections remain blacklists.
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.replace(/^\uFEFF/, "").trim().toLowerCase();
      if (!line || line.startsWith("#")) continue;
      if (line === "[blacklist]") {
        section = "blacklist";
        continue;
      }
      if (line === "[whitelist]") {
        section = "whitelist";
        continue;
      }
      rules[section].push(line);
    }
    videoRulesCache = { file, mtimeMs: stat.mtimeMs, rules };
    return rules;
  } catch {
    videoRulesCache = { file, mtimeMs: -1, rules: emptyRules };
    return emptyRules;
  }
}

function videoText(video = {}) {
  return [video.title, video.description, video.author, video.owner?.name]
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]+>/g, "")
    .toLowerCase();
}

function isBlacklisted(video, terms) {
  const text = videoText(video);
  return terms.some((term) => text.includes(term));
}

function videoTitle(video = {}) {
  return String(video.title || "").replace(/<[^>]+>/g, "").toLowerCase();
}

function scoreVideoCandidate(video, deviationPercent, whitelistTerms) {
  const title = videoTitle(video);
  const matchedTerms = whitelistTerms.filter((term) => title.includes(term));
  const whitelistScore = matchedTerms.length ? matchedTerms.length * 40 : -15;
  const durationScore = Math.max(0, 10 - deviationPercent);
  return { score: whitelistScore + durationScore, matchedTerms };
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...headers,
      },
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || body?.code !== 0) {
      throw new Error(body?.message || `${new URL(url).pathname} returned HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function durationToSeconds(value) {
  const parts = String(value || "").split(":").map((item) => Number(item));
  if (!parts.length || parts.some((item) => !Number.isFinite(item))) return 0;
  return parts.reduce((total, item) => total * 60 + item, 0);
}

function qualityForResolution(resolution) {
  const value = Number(resolution) || 720;
  if (value <= 480) return 32;
  if (value <= 720) return 64;
  return 80;
}

function artistsText(song = {}) {
  return (song.ar || song.artists || []).map((artist) => artist?.name).filter(Boolean).join(" ");
}

async function bilibiliBackground({ title, artist = "", durationMs, r = 720, maxDeviationPercent = 8 }, options = {}) {
  const expectedSeconds = Number(durationMs) / 1000;
  if (!title || !Number.isFinite(expectedSeconds) || expectedSeconds < 15) {
    return { code: 200, found: false, reason: "missing title or song duration" };
  }

  const keyword = [title, artist].filter(Boolean).join(" ");
  const searchUrl = new URL("/x/web-interface/search/all/v2", BILIBILI_API);
  searchUrl.searchParams.set("keyword", keyword);
  searchUrl.searchParams.set("page", "1");
  const search = await fetchJson(searchUrl);
  const videoGroup = (search.data?.result || []).find((group) => group?.result_type === "video");
  const videos = videoGroup?.data || [];
  if (!videos.length) return { code: 200, found: false, reason: "no video result" };

  const allowedPercent = Math.min(30, Math.max(1, Number(maxDeviationPercent) || 8));
  const rules = readVideoRules(options.blacklistFile);
  const blacklistTerms = rules.blacklist;
  const whitelistTerms = rules.whitelist;
  let firstBlacklisted = null;
  let firstDurationMismatch = null;
  const scoredCandidates = [];

  for (const candidate of videos.slice(0, 5)) {
    if (!candidate?.bvid) continue;
    if (isBlacklisted(candidate, blacklistTerms)) {
      firstBlacklisted ||= candidate;
      continue;
    }
    const seconds = durationToSeconds(candidate.duration);
    const deviation = seconds ? Math.abs(seconds - expectedSeconds) / expectedSeconds * 100 : Infinity;
    if (!Number.isFinite(deviation) || deviation > allowedPercent) {
      firstDurationMismatch ||= { candidate, seconds, deviation };
      continue;
    }
    const scored = scoreVideoCandidate(candidate, deviation, whitelistTerms);
    scoredCandidates.push({ candidate, resultSeconds: seconds, deviationPercent: deviation, ...scored });
  }

  scoredCandidates.sort((left, right) => right.score - left.score || left.deviationPercent - right.deviationPercent);
  const selected = scoredCandidates[0] || null;

  if (!selected) {
    return {
      code: 200,
      found: false,
      reason: firstBlacklisted ? "all suitable-duration results are blacklisted" : "no result duration is close enough",
      bvid: firstBlacklisted?.bvid || firstDurationMismatch?.candidate?.bvid || "",
      title: firstBlacklisted?.title || firstDurationMismatch?.candidate?.title || "",
      resultSeconds: firstDurationMismatch?.seconds || 0,
      expectedSeconds,
      deviationPercent: firstDurationMismatch?.deviation || Infinity,
      blacklistTerms: blacklistTerms.length,
      whitelistTerms: whitelistTerms.length,
    };
  }

  const first = selected.candidate;
  const resultSeconds = selected.resultSeconds;
  const deviationPercent = selected.deviationPercent;

  const viewUrl = new URL("/x/web-interface/view", BILIBILI_API);
  viewUrl.searchParams.set("bvid", first.bvid);
  const view = await fetchJson(viewUrl);
  const cid = view.data?.cid;
  if (!cid) return { code: 200, found: false, reason: "video has no playable page" };

  const playUrl = new URL("/x/player/playurl", BILIBILI_API);
  playUrl.searchParams.set("bvid", first.bvid);
  playUrl.searchParams.set("cid", String(cid));
  playUrl.searchParams.set("qn", String(qualityForResolution(r)));
  playUrl.searchParams.set("fnval", "0");
  playUrl.searchParams.set("fnver", "0");
  playUrl.searchParams.set("fourk", "1");
  const playback = await fetchJson(playUrl, { Referer: BILIBILI_REFERER });
  const sourceUrl = playback.data?.durl?.[0]?.url || "";
  if (!sourceUrl) return { code: 200, found: false, reason: "video has no MP4 playback URL" };

  return {
    code: 200,
    found: true,
    bvid: first.bvid,
    aid: first.aid || 0,
    cid,
    title: String(first.title || "").replace(/<[^>]+>/g, ""),
    author: first.author || "",
    durationSeconds: Number(view.data?.duration || resultSeconds),
    expectedSeconds,
    deviationPercent,
    score: selected.score,
    whitelistMatches: selected.matchedTerms,
    sourceUrl,
  };
}

function isBilibiliMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "bilivideo.com" || url.hostname.endsWith(".bilivideo.com"));
  } catch {
    return false;
  }
}

module.exports = { bilibiliBackground, isBilibiliMediaUrl, BILIBILI_REFERER, USER_AGENT };
