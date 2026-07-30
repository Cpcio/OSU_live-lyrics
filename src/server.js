const http = require("http");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { audioMatch, lyric, lyricNew, search, mvForSong } = require("./netease");
const { bilibiliBackground, isBilibiliMediaUrl, BILIBILI_REFERER, USER_AGENT } = require("./bilibili");
const { writeSongCache } = require("./cache");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option("--port", process.env.PORT || 3002));
const runtimeDir = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
const cacheFile = path.resolve(option("--cache", path.join(runtimeDir, "song-cache.json")));
const bilibiliBlacklistFile = path.resolve(option(
  "--bilibili-blacklist",
  process.env.BILIBILI_BLACKLIST_FILE || path.join(runtimeDir, "bilibili-blacklist.txt"),
));

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

async function proxyBilibiliMedia(request, response, rawUrl) {
  if (!isBilibiliMediaUrl(rawUrl)) return send(response, 400, { code: 400, message: "invalid Bilibili media URL" });

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const upstream = await fetch(rawUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Referer: BILIBILI_REFERER,
      ...(request.headers.range ? { Range: request.headers.range } : {}),
    },
    signal: controller.signal,
  });
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    "Content-Type": upstream.headers.get("content-type") || "video/mp4",
    "Cache-Control": "no-store",
  };
  for (const name of ["content-length", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
  if (request.method === "HEAD" || !upstream.body) return response.end();

  // Bilibili CDNs can close a range response while Electron is seeking. Keep
  // that failure inside this request so it cannot take down lyric endpoints.
  try {
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (!response.destroyed) response.destroy(error);
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (request.method === "OPTIONS") return send(response, 200, { ok: true });
  if (url.pathname === "/health" && request.method === "GET") {
    return send(response, 200, { ok: true, service: "tosu-lyrics-proxy", port });
  }

  if (url.pathname === "/bilibili/media" && ["GET", "HEAD"].includes(request.method)) {
    try {
      return await proxyBilibiliMedia(request, response, url.searchParams.get("url") || "");
    } catch (error) {
      if (!response.headersSent) return send(response, 502, { code: 502, message: error.message || "Bilibili media request failed" });
      response.destroy(error);
      return;
    }
  }

  try {
    const query = await queryFor(request, url);
    let body;

    switch (url.pathname) {
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
      case "/bilibili/background":
        try {
          body = await bilibiliBackground(query, { blacklistFile: bilibiliBlacklistFile });
        } catch (error) {
          // Video fallback is optional. Never let a Bilibili outage become a
          // failing overlay request or affect lyric endpoints.
          body = { code: 200, found: false, reason: `Bilibili unavailable: ${error.message}` };
        }
        if (body.found) {
          body.mediaUrl = `http://127.0.0.1:${port}/bilibili/media?url=${encodeURIComponent(body.sourceUrl)}`;
        }
        delete body.sourceUrl;
        break;
      case "/song-cache":
        if (request.method !== "POST") return send(response, 405, { code: 405, message: "POST required" });
        body = { code: 200, ok: true, ...writeSongCache(cacheFile, query) };
        break;
      default:
        return send(response, 404, { code: 404, message: "not found" });
    }

    send(response, 200, body);
  } catch (error) {
    console.error(`[proxy] ${request.method} ${url.pathname}: ${error.message}`);
    send(response, 502, { code: 502, message: error.message || "upstream request failed" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[proxy] listening on http://127.0.0.1:${port}`);
  console.log(`[proxy] cache file: ${cacheFile}`);
  console.log(`[proxy] Bilibili blacklist: ${bilibiliBlacklistFile}`);
});
