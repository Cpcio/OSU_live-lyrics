// Background palette/cover handling and MV discovery/playback synchronization.

function hexToRgb(hex) {
  const match = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return { r: 9, g: 12, b: 18 };

  const value = Number.parseInt(match[1], 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgbToHex(color) {
  return `#${[color.r, color.g, color.b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function blendColor(a, b, amount) {
  const ratio = clamp(Number(amount), 0, 1);

  return {
    r: a.r * (1 - ratio) + b.r * ratio,
    g: a.g * (1 - ratio) + b.g * ratio,
    b: a.b * (1 - ratio) + b.b * ratio,
  };
}

function readableAccent(color) {
  const boosted = {
    r: Math.min(255, color.r * 1.35 + 28),
    g: Math.min(255, color.g * 1.35 + 28),
    b: Math.min(255, color.b * 1.35 + 28),
  };

  return rgbToHex(blendColor(boosted, { r: 132, g: 244, b: 208 }, 0.35));
}

function luminance(color) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function saturation(color) {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  return max === 0 ? 0 : (max - min) / max;
}

function vividScore(color) {
  return luminance(color) * 0.72 + saturation(color) * 255 * 0.38;
}

function hue(color) {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (!delta) return 0;
  if (max === r) return (60 * ((g - b) / delta) + 360) % 360;
  if (max === g) return 60 * ((b - r) / delta + 2);
  return 60 * ((r - g) / delta + 4);
}

function brightenColor(color, amount = 0.34) {
  return {
    r: color.r + (255 - color.r) * amount,
    g: color.g + (255 - color.g) * amount,
    b: color.b + (255 - color.b) * amount,
  };
}

function boostSaturation(color, amount = 0.22) {
  const gray = luminance(color);

  return {
    r: clamp(gray + (color.r - gray) * (1 + amount), 0, 255),
    g: clamp(gray + (color.g - gray) * (1 + amount), 0, 255),
    b: clamp(gray + (color.b - gray) * (1 + amount), 0, 255),
  };
}

function makeTimelineColor(color) {
  const luma = luminance(color);
  const brightenAmount = luma < 76 ? 0.52 : luma < 128 ? 0.38 : 0.24;
  return boostSaturation(brightenColor(color, brightenAmount), 0.34);
}

function paletteBucketKey(color) {
  const h = Math.round(hue(color) / 18);
  const s = Math.round(saturation(color) * 5);
  const l = Math.round(luminance(color) / 32);
  return `${h}:${s}:${l}`;
}

function addPaletteSample(buckets, color) {
  const sat = saturation(color);
  const luma = luminance(color);
  if (luma < 24 || luma > 244 || sat < 0.08) return;

  const key = paletteBucketKey(color);
  const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0, score: 0 };
  const weight = 1 + sat * 2.4 + Math.min(luma, 210) / 210;

  bucket.r += color.r * weight;
  bucket.g += color.g * weight;
  bucket.b += color.b * weight;
  bucket.count += weight;
  bucket.score += weight;
  buckets.set(key, bucket);
}

function dominantPalette(buckets, fallback) {
  const colors = [...buckets.values()]
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => {
      const color = {
        r: bucket.r / bucket.count,
        g: bucket.g / bucket.count,
        b: bucket.b / bucket.count,
      };

      return {
        color,
        score: bucket.score * (0.75 + saturation(color)) * (0.72 + Math.min(luminance(color), 210) / 255),
      };
    })
    .sort((a, b) => b.score - a.score);

  const primary = colors[0]?.color || fallback;
  const secondary = colors.find((item) => colorDistance(item.color, primary) >= 58)?.color
    || colors[1]?.color
    || fallback;

  return { primary, secondary };
}

function colorDistance(a, b) {
  return Math.sqrt(
    (a.r - b.r) ** 2 +
    (a.g - b.g) ** 2 +
    (a.b - b.b) ** 2,
  );
}

function separateGradientEnds(top, bottom) {
  if (colorDistance(top, bottom) >= 72) {
    return { top, bottom };
  }

  const cool = blendColor(top, { r: 112, g: 190, b: 255 }, 0.32);
  const warm = blendColor(bottom, { r: 255, g: 214, b: 112 }, 0.24);

  return {
    top: makeTimelineColor(cool),
    bottom: makeTimelineColor(warm),
  };
}

function applyPanelColor(panel) {
  const root = document.documentElement.style;

  root.setProperty("--panel-r", String(panel.r));
  root.setProperty("--panel-g", String(panel.g));
  root.setProperty("--panel-b", String(panel.b));
}

function applyAccentColor(color) {
  const accent = readableAccent(color);
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--progress-color", accent);
}

function applyTimelineGradient(top, bottom) {
  const root = document.documentElement.style;
  root.setProperty("--timeline-top", rgbToHex(top));
  root.setProperty("--timeline-bottom", rgbToHex(bottom));
}

function softenLyricColor(color) {
  const desaturated = boostSaturation(color, -0.22);
  const amount = luminance(desaturated) < 80 ? 0.6 : luminance(desaturated) < 140 ? 0.46 : 0.3;
  return blendColor(desaturated, { r: 255, g: 255, b: 255 }, amount);
}

function applyLyricPalette(primary, secondary = primary) {
  const root = document.documentElement.style;
  const first = rgbToHex(softenLyricColor(primary));
  const last = rgbToHex(softenLyricColor(secondary));
  root.setProperty("--lyric-color", first);
  root.setProperty("--lyric-color-start", first);
  root.setProperty("--lyric-color-end", last);
}

async function loadBackgroundImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("background image timeout")), 2500);

    img.crossOrigin = "anonymous";
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("background image failed"));
    };
    img.src = src;
  });
}

function updateDashboardSongIcon(image) {
  const enabled = CONFIG.dashboardSongIconEnabled && overlayEl?.classList.contains("layout-dashboard");
  const validImage = image && image.naturalWidth > 0 && image.naturalHeight > 0;
  if (!enabled || !validImage || !songIconImageEl) {
    const wasVisible = overlayEl?.classList.contains("has-song-icon");
    dashboardSongIconSource = null;
    overlayEl?.classList.remove("has-song-icon");
    if (songIconImageEl?.hasAttribute("src")) songIconImageEl.removeAttribute("src");
    if (wasVisible) scheduleOverlayLayout();
    return;
  }
  if (dashboardSongIconSource === image && overlayEl.classList.contains("has-song-icon") && songIconImageEl.hasAttribute("src")) return;
  scheduleOverlayLayout();

  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  const size = Math.min(640, Math.round(sourceSize));
  const sourceX = Math.max(0, (image.naturalWidth - sourceSize) / 2);
  const sourceY = Math.max(0, (image.naturalHeight - sourceSize) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return;

  try {
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    songIconImageEl.src = canvas.toDataURL("image/jpeg", 0.9);
    dashboardSongIconSource = image;
    overlayEl?.classList.add("has-song-icon");
  } catch {
    // A source that cannot be read by canvas cannot be used as an icon.
    overlayEl?.classList.remove("has-song-icon");
  }
}

function updateSongIconPlayback(liveTime) {
  const time = Number(liveTime) || 0;
  const now = performance.now();
  // The first packet establishes a position; a later advancing clock starts
  // rotation. Repeated paused packets settle within the MV pause tolerance.
  const advanced = lastSongIconLiveTime !== null && Math.abs(time - lastSongIconLiveTime) > 1;
  if (advanced) lastSongIconAdvanceAt = now;
  lastSongIconLiveTime = time;
  const active = advanced || (songIconPlaybackActive && now - lastSongIconAdvanceAt < 180);
  if (active === songIconPlaybackActive) return;
  songIconPlaybackActive = active;
  overlayEl?.classList.toggle("song-icon-playing", active);
}

function resetSongIconPlayback() {
  lastSongIconLiveTime = null;
  lastSongIconAdvanceAt = 0;
  songIconPlaybackActive = false;
  overlayEl?.classList.remove("song-icon-playing");
}

async function extractBackgroundPalette(image) {

  const canvas = document.createElement("canvas");
  const size = 32;
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);

  const data = ctx.getImageData(0, 0, size, size).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const buckets = new Map();

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 16) continue;

    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count += 1;

    const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
    addPaletteSample(buckets, color);
  }

  if (!count) throw new Error("background image has no color");

  const average = {
    r: r / count,
    g: g / count,
    b: b / count,
  };
  const palette = dominantPalette(buckets, average);

  return {
    average,
    primary: palette.primary,
    secondary: palette.secondary,
  };
}

async function updateBeatmapColor(beatmap, payload = {}) {
  const fallback = hexToRgb(CONFIG.panelColor);
  const candidates = backgroundCandidates(beatmap, payload);
  const backgroundIdentity = beatmapDifficultyId(beatmap) || beatmap.checksum || beatmapSetId(beatmap) || "";
  const key = `${backgroundIdentity}::${candidates.join("|")}`;
  if (!candidates.length) {
    backgroundLoadToken += 1;
    currentBackgroundKey = "";
    currentBackgroundImage = null;
    updateDashboardSongIcon(null);
    applyPanelColor(fallback);
    applyAccentColor(fallback);
    applyTimelineGradient(fallback, fallback);
    applyLyricPalette(fallback);
    return;
  }
  if (key === currentBackgroundKey) {
    updateDashboardSongIcon(currentBackgroundImage);
    if (CONFIG.panelColorMode !== "beatmap") {
      applyPanelColor(fallback);
      applyAccentColor(fallback);
      applyTimelineGradient(fallback, fallback);
    }
    return;
  }

  currentBackgroundKey = key;
  currentBackgroundImage = null;
  updateDashboardSongIcon(null);
  const loadToken = ++backgroundLoadToken;
  const limitedCandidates = candidates.slice(0, 6);

  for (const candidate of limitedCandidates) {
    try {
      const image = await loadBackgroundImage(backgroundImageUrl(candidate, backgroundIdentity));
      if (loadToken !== backgroundLoadToken || key !== currentBackgroundKey) return;
      currentBackgroundImage = image;
      updateDashboardSongIcon(image);
      const sampled = await extractBackgroundPalette(image);
      // Lyric colours use the real sampled palette, independently of panel
      // tint and the progress bar's existing separation/colour treatment.
      applyLyricPalette(sampled.primary, sampled.secondary);
      if (CONFIG.panelColorMode !== "beatmap") {
        applyPanelColor(fallback);
        applyAccentColor(fallback);
        applyTimelineGradient(fallback, fallback);
        return;
      }
      const panel = blendColor(sampled.average, fallback, CONFIG.beatmapColorBlend);
      const gradient = separateGradientEnds(
        makeTimelineColor(sampled.primary),
        makeTimelineColor(sampled.secondary),
      );
      applyPanelColor(panel);
      applyTimelineGradient(gradient.top, gradient.bottom);

      if (CONFIG.autoAccentFromBeatmap) {
        applyAccentColor(sampled.average);
      }

      setStatus("background: sampled");
      return;
    } catch {
      // Try the next possible background field.
    }
  }

  applyPanelColor(fallback);
  applyAccentColor(fallback);
  applyTimelineGradient(fallback, fallback);
  applyLyricPalette(fallback);
  setStatus("background: fallback");
}

function clearMvBackground() {
  mvBackgroundAbortController?.abort();
  mvBackgroundAbortController = null;
  currentMvBackgroundKey = "";
  currentMvPlaybackPaused = false;
  lastMvObservedLiveTime = null;
  lastMvLiveAdvanceAt = 0;
  overlayEl?.classList.remove("has-mv-background");
  if (!mvBackgroundEl) return;
  mvBackgroundEl.pause();
  mvBackgroundEl.removeAttribute("src");
  mvBackgroundEl.load();
}

function updateMvPlaybackState(liveTime) {
  const now = performance.now();
  const time = Number(liveTime) || 0;
  const advanced = lastMvObservedLiveTime === null || Math.abs(time - lastMvObservedLiveTime) > 1;

  if (advanced) {
    lastMvLiveAdvanceAt = now;
    currentMvPlaybackPaused = false;
  } else if (lastMvLiveAdvanceAt && now - lastMvLiveAdvanceAt >= 180) {
    currentMvPlaybackPaused = true;
  }

  lastMvObservedLiveTime = time;
}

function syncMvBackground(liveTime = lastLiveTime, force = false) {
  if (!mvBackgroundEl?.src || !overlayEl?.classList.contains("has-mv-background")) return;
  if (mvBackgroundEl.readyState < HTMLMediaElement.HAVE_METADATA) return;

  const rawTarget = Math.max(0, Number(liveTime) || 0) / 1000;
  const duration = Number(mvBackgroundEl.duration) || 0;
  const target = duration > 0 ? rawTarget % duration : rawTarget;

  try {
    if (currentMvPlaybackPaused) {
      if (force || Math.abs(mvBackgroundEl.currentTime - target) > 0.03) {
        mvBackgroundEl.currentTime = target;
      }
      if (!mvBackgroundEl.paused) mvBackgroundEl.pause();
      return;
    }
    if (force || Math.abs(mvBackgroundEl.currentTime - target) > 0.35) {
      mvBackgroundEl.currentTime = target;
    }
    if (mvBackgroundEl.paused) mvBackgroundEl.play().catch(() => {});
  } catch {
    // Some media implementations reject seeks while replacing a source.
  }
}

async function fetchMvForSong(songId, resolution, options = {}) {
  try {
    return await fetchJson("/mv/for-song", {
      id: String(songId),
      r: String(resolution),
    }, options);
  } catch {
    if (options.signal?.aborted) throw new Error("MV request aborted");
    // api-enhanced exposes the same lookup as two public MV endpoints.
    const detail = await fetchJson("/song/detail", { ids: String(songId) }, options);
    const song = detail?.songs?.[0];
    const mvId = Number(song?.mv || song?.mvid || 0);
    if (!mvId) return { hasMv: false, songId: Number(songId) };

    const urlData = await fetchJson("/mv/url", {
      id: String(mvId),
      r: String(resolution),
    }, options);
    return {
      hasMv: Boolean(urlData?.data?.url),
      songId: Number(songId),
      mvId,
      url: urlData?.data?.url || "",
      r: Number(urlData?.data?.r || resolution),
    };
  }
}

async function updateMvBackground(songId, songMeta = {}, trackKey = currentTrackKey) {
  if (!CONFIG.mvBackgroundEnabled || !trackKey) {
    clearMvBackground();
    return;
  }
  const previousNetEaseId = currentMvTrackKey === trackKey ? currentMvSongId : "";
  // QQ may complement this identity, but never clear an existing NetEase MV.
  if (!songId && currentMvTrackKey === trackKey) songId = currentMvSongId;
  songMeta = currentMvTrackKey === trackKey ? { ...currentMvSongMeta, ...songMeta,
    qqSongId: songMeta.qqSongId || currentMvSongMeta.qqSongId || "" } : songMeta;
  if (!songId && !songMeta.qqSongId) {
    if (CONFIG.lyricLayout === "subtitle") clearMvBackground();
    if (currentMvTrackKey && currentMvTrackKey !== trackKey) clearMvBackground();
    return;
  }
  currentMvSongId = String(songId || "");
  currentMvSongMeta = { ...songMeta };
  currentMvTrackKey = trackKey;
  if (CONFIG.lyricLayout === "subtitle") {
    clearMvBackground();
    return;
  }

  const key = `${trackKey}:${songId || ""}:${songMeta.qqSongId || ""}:${Math.round(clamp(Number(CONFIG.mvBackgroundResolution), 240, 1080))}`;
  if (songId && overlayEl?.classList.contains("has-mv-background") && mvBackgroundEl.dataset.provider === "netease"
    && previousNetEaseId === String(songId) && key.split(":").at(-1) === currentMvBackgroundKey.split(":").at(-1)) return;
  if (key === currentMvBackgroundKey) return;

  mvBackgroundAbortController?.abort();
  const controller = new AbortController();
  mvBackgroundAbortController = controller;
  currentMvBackgroundKey = key;

  try {
    const resolution = Math.round(clamp(Number(CONFIG.mvBackgroundResolution), 240, 1080));
    let neteaseData;
    if (songId) {
      try { neteaseData = await fetchMvForSong(songId, resolution, { signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted || !songMeta.qqSongId) throw error; }
    }
    let data = neteaseData;
    if (!data?.hasMv && songMeta.qqSongId) {
      data = await fetchJson("/qq/mv/for-song", { id: songMeta.qqSongId, r: String(resolution) }, { signal: controller.signal });
    }

    if (controller.signal.aborted || CONFIG.lyricLayout === "subtitle" || currentTrackKey !== trackKey || currentMvBackgroundKey !== key) return;
    const videoUrl = data?.hasMv ? data.url : "";
    const videoSource = `${data?.provider || "netease"} MV ${data?.mvId || ""}`;

    if (!videoUrl) {
      clearMvBackground();
      return;
    }

    mvBackgroundEl.pause();
    mvBackgroundEl.onloadedmetadata = () => syncMvBackground(lastLiveTime, true);
    mvBackgroundEl.src = videoUrl;
    mvBackgroundEl.dataset.provider = data?.provider || "netease";
    mvBackgroundEl.load();
    overlayEl?.classList.add("has-mv-background");
    syncMvBackground(lastLiveTime, true);
    try {
      await mvBackgroundEl.play();
    } catch {
      // The muted video can still be blocked by a damaged media response.
    }
    if (!controller.signal.aborted && CONFIG.lyricLayout !== "subtitle") setStatus(`mv background: ${videoSource || "loaded"}`);
  } catch (error) {
    if (controller.signal.aborted || currentTrackKey !== trackKey || currentMvBackgroundKey !== key) return;
    clearMvBackground();
    setStatus(`mv background unavailable: ${error.message}`);
  } finally {
    if (mvBackgroundAbortController === controller) mvBackgroundAbortController = null;
  }
}

function refreshMvBackgroundForCurrentTrack() {
  if (!CONFIG.mvBackgroundEnabled || CONFIG.lyricLayout === "subtitle") {
    clearMvBackground();
    return;
  }
  if (currentTrackKey) {
    updateMvBackground(currentMvSongId || currentNeteaseSongId,
      currentMvSongId ? currentMvSongMeta : currentNeteaseSongMeta, currentTrackKey);
  }
}

function resetMvTrackIdentity() {
  currentMvSongId = "";
  currentMvSongMeta = { title: "", artist: "", durationMs: 0 };
  currentMvTrackKey = "";
}
