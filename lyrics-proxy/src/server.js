const http = require("http");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { audioMatch, lyric, lyricNew, search, mvForSong, songAudioUrl } = require("./netease");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const { writeSongCache } = require("./cache");
const qqmusic = require("./qqmusic");
const { requests } = require("./upstream");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option("--port", process.env.PORT || 3002));
const runtimeDir = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
const cacheFile = path.resolve(option("--cache", path.join(runtimeDir, "song-cache.json")));

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json;charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function proxySongAudio(request, response, songId, provider = "netease") {
  if (!(provider === "qq" ? /^[a-zA-Z0-9]{10,20}$/ : /^\d+$/).test(String(songId || ""))) {
    return send(response, 400, { code: 400, message: "invalid song id" });
  }

  const audio = await (provider === "qq" ? qqmusic.songAudioUrl({ id: songId }) : songAudioUrl({ id: songId, level: "standard" }));
  if (audio.trial) return send(response, 404, { code: 404, message: "full reference audio unavailable (trial stream)" });
  if (!audio.url) return send(response, 404, { code: 404, message: "song audio unavailable" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const upstream = await fetch(audio.url, {
      headers: {
        "User-Agent": USER_AGENT,
        ...(request.headers.range ? { Range: request.headers.range } : {}),
      },
      signal: controller.signal,
    });
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
      "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
      "Cache-Control": "no-store",
    };
    for (const name of ["content-length", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    response.writeHead(upstream.status, headers);
    if (request.method === "HEAD" || !upstream.body) return response.end();
    await pipeline(Readable.fromWeb(upstream.body), response);
  } finally {
    clearTimeout(timeout);
  }
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        request.destroy();
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
      try {
        if (!raw) return resolve({});
        const contentType = String(request.headers["content-type"] || "");
        if (contentType.includes("application/json")) return resolve(JSON.parse(raw));
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (error) {
        reject(new Error(`invalid request body: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

async function queryFor(request, url) {
  if (request.method === "GET") return Object.fromEntries(url.searchParams);
  return parseBody(request);
}

const server = http.createServer((request, response) => {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  requests.run({ signal: controller.signal }, async () => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (request.method === "OPTIONS") return send(response, 200, { ok: true });
  if (url.pathname === "/health" && request.method === "GET") {
    return send(response, 200, { ok: true, service: "tosu-lyrics-proxy", version: "0.2.3", providers: ["netease", "qq"], features: ["qq-mv"], port });
  }

  if (["/song/audio", "/qq/song/audio"].includes(url.pathname) && ["GET", "HEAD"].includes(request.method)) {
    try {
      return await proxySongAudio(request, response, url.searchParams.get("id") || "", url.pathname.startsWith("/qq/") ? "qq" : "netease");
    } catch (error) {
      if (!response.headersSent) return send(response, 502, { code: 502, message: error.message || "song audio request failed" });
      response.destroy(error);
      return;
    }
  }

  try {
    const query = await queryFor(request, url);
    let body;

    switch (url.pathname) {
      case "/qq/search":
        body = await qqmusic.search(query);
        break;
      case "/qq/lyric":
        body = await qqmusic.lyric(query);
        break;
      case "/qq/mv/for-song":
        body = await qqmusic.mvForSong(query);
        break;
      case "/audio/match":
        body = { code: 200, data: await audioMatch(query) };
        break;
      case "/lyric/new":
        body = await lyricNew(query.id);
        break;
      case "/lyric":
        body = await lyric(query.id);
        break;
      case "/search":
        body = await search(query);
        break;
      case "/cloudsearch":
        body = await search({ ...query, cloud: true });
        break;
      case "/mv/for-song":
        body = await mvForSong(query);
        break;
      case "/song-cache":
        if (request.method !== "POST") return send(response, 405, { code: 405, message: "POST required" });
        body = { code: 200, ok: true, ...writeSongCache(cacheFile, query) };
        break;
      default:
        return send(response, 404, { code: 404, message: "not found" });
    }

    if (!controller.signal.aborted && !response.destroyed) send(response, 200, body);
  } catch (error) {
    console.error(`[proxy] ${request.method} ${url.pathname}: ${error.message}`);
    if (!response.destroyed && !controller.signal.aborted) send(response, error.status || 502, {
      code: error.status || 502, kind: error.kind || "network", message: error.message || "upstream request failed" });
  }
  }).catch(error => {
    if (!response.headersSent && !response.destroyed) send(response, 500, { code: 500, kind: "internal", message: error.message });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[proxy] listening on http://127.0.0.1:${port}`);
  console.log(`[proxy] cache file: ${cacheFile}`);
});
