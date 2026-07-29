const fs = require("fs");
const path = require("path");

function readCache(cacheFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { tracks: {} };
  } catch {
    return { tracks: {} };
  }
}

function validCacheKey(key) {
  if (!key || key.startsWith("set:") || key.includes("::")) return false;
  if (!key.startsWith("beatmap:")) return true;
  return Number.isFinite(Number(key.slice("beatmap:".length))) && Number(key.slice("beatmap:".length)) > 0;
}

function writeSongCache(cacheFile, payload) {
  const songId = Number(payload.neteaseSongId || payload.songId || 0);
  const keys = Array.isArray(payload.keys) ? payload.keys.map((item) => String(item || "").trim()) : [];
  const key = keys.find((item) => item.startsWith("beatmap:") && validCacheKey(item)) || keys.find(validCacheKey) || "";
  if (!songId || !key) throw new Error("missing strict beatmap/checksum key or neteaseSongId");

  const cache = readCache(cacheFile);
  cache.tracks ||= {};
  if (cache.tracks[key]?.manual) return { key, skipped: "manual entry" };

  cache.tracks[key] = {
    neteaseSongId: songId,
    neteaseDurationMs: Number(payload.neteaseDurationMs || 0),
    neteaseBpm: Number(payload.neteaseBpm || 0),
    title: payload.title || "",
    artist: payload.artist || "",
    beatmapId: payload.beatmapId || "",
    beatmapSetId: payload.beatmapSetId || "",
    checksum: payload.checksum || "",
    lyricOffsetMs: Number(payload.lyricOffsetMs || 0),
    speedMultiplier: Number(payload.speedMultiplier || 1),
    autoOffsetMs: Number(payload.autoOffsetMs || 0),
    autoOffsetSource: payload.autoOffsetSource || "",
    audioMatchSource: payload.audioMatchSource || "",
    audioMatchStartTimeMs: Number(payload.audioMatchStartTimeMs || 0),
    audioMatchSampleStartMs: Number(payload.audioMatchSampleStartMs || 0),
    audioMatchEffectiveSampleStartMs: Number(payload.audioMatchEffectiveSampleStartMs || 0),
    audioMatchSpeed: Number(payload.audioMatchSpeed || 1),
    audioMatchConfidence: payload.audioMatchConfidence || "",
    firstLyricTimeMs: Number(payload.firstLyricTimeMs || 0),
    firstObjectTimeMs: Number(payload.firstObjectTimeMs || 0),
    source: payload.source || "",
    autoCached: true,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return { key };
}

module.exports = { writeSongCache };
