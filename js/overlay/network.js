// tosu file paths, local URLs, HTTP requests, deadlines and cancellation.

function rawCounterPath() {
  if (typeof window.COUNTER_PATH === "string" && window.COUNTER_PATH.trim()) {
    return window.COUNTER_PATH;
  }

  return `${location.pathname || "/"}${location.search || ""}`;
}

function getCounterPathForCommand() {
  return encodeURI(rawCounterPath());
}

function getCounterPathForQuery() {
  return encodeURIComponent(rawCounterPath());
}

function backgroundCandidates(beatmap, payload = {}) {
  const directPath = payload.directPath || {};
  const files = payload.files || {};
  const folders = payload.folders || {};
  const stableEndpoint = "/files/beatmap/background";
  const raw = [
    stableEndpoint,
    directPath.beatmapBackground,
    directPath.beatmapFolder && files.background ? `${directPath.beatmapFolder}/${files.background}` : "",
    folders.beatmap && files.background ? `${folders.beatmap}/${files.background}` : "",
    files.background,
    beatmap.background,
    beatmap.backgroundImage,
    beatmap.bg,
    beatmap.path?.background,
    beatmap.path?.bg,
    beatmap.path?.full,
    beatmap.path?.folder,
    beatmap.folder,
    beatmap.folders?.beatmap,
    beatmap.folders?.songs,
    beatmap.files?.background,
    beatmap.assets?.background,
  ].filter(Boolean).map(String);

  const candidates = [];

  for (const item of raw) {
    const isStableEndpoint = item === stableEndpoint || item.startsWith("/files/beatmap/");
    const isImagePath = /\.(jpg|jpeg|png|webp|gif)$/i.test(item);
    const isRootTemporaryPath = item.startsWith("/") && !isStableEndpoint;
    if (isRootTemporaryPath) continue;
    if (!isStableEndpoint && !isImagePath) continue;

    candidates.push(item);
    if (!isImagePath) continue;
    candidates.push(`/Songs/${item}`);
    candidates.push(`/files/beatmap/${item}`);
    candidates.push(`/files/beatmap/background/${item}`);
  }

  const filename = files.background || beatmap.files?.background || beatmap.background || beatmap.bg;
  const folderCandidates = [folders.beatmap, beatmap.path?.folder, beatmap.folder, beatmap.folders?.beatmap].filter(Boolean).map(String);

  for (const folder of folderCandidates) {
    if (folder.startsWith("/") && !folder.startsWith("/files/beatmap/")) continue;
    if (filename) {
      candidates.push(`${folder}/${filename}`);
      candidates.push(`/Songs/${folder}/${filename}`);
      candidates.push(`/files/beatmap/${folder}/${filename}`);
    }
  }

  return uniqueStrings(candidates);
}

function toImageUrl(path) {
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  if (path.startsWith("/")) return path;

  const normalizedPath = path.replaceAll("\\", "/");
  const songsIndex = normalizedPath.toLowerCase().lastIndexOf("/songs/");
  if (songsIndex >= 0) {
    return `/files/beatmap/${normalizedPath.slice(songsIndex + "/songs/".length)}`;
  }

  if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(normalizedPath)) {
    return `/files/beatmap/${normalizedPath}`;
  }

  try {
    return new URL(normalizedPath, location.origin).toString();
  } catch {
    return path;
  }
}

function backgroundImageUrl(path, identity) {
  const imageUrl = toImageUrl(path);
  if (/^(data:|blob:)/i.test(imageUrl)) return imageUrl;
  const separator = imageUrl.includes("?") ? "&" : "?";
  // tosu's shortcut keeps one URL for every map; bind it to this beatmap so
  // Chromium cannot reuse the preceding background image.
  return `${imageUrl}${separator}beatmap=${encodeURIComponent(identity)}`;
}

function toBeatmapFileUrl(path) {
  if (!path) return "";
  if (/^(https?:|data:|blob:)/i.test(path)) return path;

  const normalizedPath = String(path).replaceAll("\\", "/");
  if (normalizedPath.startsWith("/")) {
    if (normalizedPath.startsWith("/files/beatmap/") || /\.osu(?:[?#].*)?$/i.test(normalizedPath)) return normalizedPath;
    return "";
  }

  const songsIndex = normalizedPath.toLowerCase().lastIndexOf("/songs/");
  if (songsIndex >= 0) {
    return `/files/beatmap/${normalizedPath.slice(songsIndex + "/songs/".length)}`;
  }

  if (/\.osu$/i.test(normalizedPath)) {
    return `/files/beatmap/${normalizedPath}`;
  }

  return "";
}

function beatmapFileCandidates(beatmap = {}, payload = {}) {
  const directPath = payload.directPath || {};
  const files = payload.files || beatmap.files || {};
  const pathInfo = beatmap.path || {};

  return uniqueStrings([
    "/files/beatmap/file",
    directPath.beatmapFile,
    directPath.beatmap,
    files.beatmap,
    files.osu,
    files.file,
    beatmap.file,
    beatmap.filename,
    pathInfo.file,
    pathInfo.full,
  ].filter(Boolean).map(toBeatmapFileUrl).filter(Boolean));
}

async function fetchText(path) {
  const timeout = timeoutSignal(CONFIG.fetchTimeoutMs);

  try {
    const response = await fetch(path, {
      cache: "no-store",
      mode: "cors",
      signal: timeout.signal,
    });

    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return await response.text();
  } finally {
    timeout.done?.();
  }
}

async function fetchArrayBuffer(path, signal = null) {
  const timeout = timeoutSignal(Math.max(CONFIG.fetchTimeoutMs, 45000));
  let abortHandler = null;

  try {
    if (signal?.aborted) throw new Error("request aborted");
    if (signal) {
      abortHandler = () => timeout.abort?.();
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    const response = await fetch(path, {
      cache: "no-store",
      mode: "cors",
      signal: timeout.signal,
    });

    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return await response.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) throw new Error("audio match aborted");
    throw error;
  } finally {
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    timeout.done?.();
  }
}

function toTosuHttpBase() {
  try {
    const url = new URL(CONFIG.tosuWebSocket);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "http://127.0.0.1:24050/";
  }
}

function toTosuUrl(path) {
  return new URL(path, toTosuHttpBase()).toString();
}

async function currentBeatmapAudioBuffer(signal = null) {
  return fetchArrayBuffer(toTosuUrl("/files/beatmap/audio"), signal);
}

function timeoutSignal(timeoutMs) {
  if (!window.AbortController) return {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    done: () => clearTimeout(timer),
  };
}

async function fetchJson(path, params, options = {}) {
  const queryUrl = new URL(path, CONFIG.neteaseApiBase);

  for (const [key, value] of Object.entries(params || {})) {
    queryUrl.searchParams.set(key, value);
  }

  queryUrl.searchParams.set("timestamp", Date.now());

  try {
    return await requestJson(queryUrl.toString(), { ...options, method: "GET" });
  } catch (error) {
    const message = String(error.message || "");
    if (!CONFIG.allowPostFallback || !/(404|405)/.test(message)) {
      throw error;
    }

    const postUrl = new URL(path, CONFIG.neteaseApiBase);
    const body = new URLSearchParams();

    for (const [key, value] of Object.entries(params || {})) {
      body.set(key, value);
    }

    body.set("timestamp", Date.now());

    return requestJson(postUrl.toString(), {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
    });
  }
}

async function requestJson(url, options) {
  const timeout = timeoutSignal(Math.max(CONFIG.fetchTimeoutMs, 27000));
  const parent = options?.signal || lyricRequestController?.signal;
  const cancel = () => timeout.abort?.();
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();

  try {
    const response = await fetch(url, {
      cache: "no-store",
      mode: "cors",
      ...options,
      signal: timeout.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(`${new URL(url).pathname}: ${body.message || response.status}`);
      error.kind = body.kind || (response.status === 429 ? "rate_limited" : "network");
      throw error;
    }

    const body = await response.json();
    if (body.code !== undefined && ![0, 200].includes(Number(body.code))) {
      const error = new Error(`upstream code ${body.code}: ${body.message || body.msg || ""}`);
      error.kind = "upstream_business";
      throw error;
    }
    return body;
  } catch (error) {
    if (parent?.aborted) throw new Error("audio match aborted");
    if (timeout.signal?.aborted) { error.kind = "timeout"; error.message = "lyrics request timed out"; }
    throw error;
  } finally {
    parent?.removeEventListener("abort", cancel);
    timeout.done?.();
  }
}
