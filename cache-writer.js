const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 3001);
const cacheFile = path.resolve(__dirname, "song-cache.json");

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (data && typeof data === "object") return data;
  } catch {}
  return { tracks: {} };
}

function writeCache(cache) {
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function send(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json;charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(data));
}

function isValidCacheKey(key) {
  if (!key || key.startsWith("set:") || key.includes("::")) return false;
  if (!key.startsWith("beatmap:")) return true;

  const id = Number(key.slice("beatmap:".length));
  return Number.isFinite(id) && id > 0;
}

function collectJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 128) {
        request.destroy();
        reject(new Error("payload too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 200, { ok: true });
    return;
  }

  if (request.method !== "POST" || request.url !== "/song-cache") {
    send(response, 404, { ok: false, error: "not found" });
    return;
  }

  try {
    const payload = await collectJson(request);
    const songId = Number(payload.neteaseSongId || payload.songId || 0);
    const safeKeys = Array.isArray(payload.keys)
      ? payload.keys.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const key = safeKeys.find((item) => item.startsWith("beatmap:") && isValidCacheKey(item))
      || safeKeys.find((item) => isValidCacheKey(item))
      || "";

    if (!songId || !key) {
      send(response, 400, { ok: false, error: "missing strict beatmap/checksum key or neteaseSongId" });
      return;
    }

    const cache = readCache();
    cache.tracks ||= {};
    const existing = cache.tracks[key] || {};
    if (existing.manual) {
      send(response, 200, { ok: true, key, skipped: "manual entry" });
      return;
    }

    cache.tracks[key] = {
      neteaseSongId: songId,
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
      firstLyricTimeMs: Number(payload.firstLyricTimeMs || 0),
      firstObjectTimeMs: Number(payload.firstObjectTimeMs || 0),
      source: payload.source || "",
      autoCached: true,
      updatedAt: new Date().toISOString(),
    };

    writeCache(cache);
    send(response, 200, { ok: true, key });
  } catch (error) {
    send(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`song cache writer listening on http://127.0.0.1:${port}/song-cache`);
  console.log(`writing ${cacheFile}`);
});
