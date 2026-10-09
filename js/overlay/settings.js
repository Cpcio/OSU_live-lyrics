// Settings normalization, visual application, font loading and reload decisions.
// Editable keys live in SETTINGS_TYPES (state.js) and settings.json.

function normalizeSettingValue(value) {
  if (value && typeof value === "object") {
    if ("value" in value) return value.value;
    if ("selected" in value) return value.selected;
    if ("name" in value) return value.name;
    if ("label" in value) return value.label;
    if ("default" in value) return value.default;
  }
  return value;
}

function normalizeLyricTransitionMode(value) {
  if (value && typeof value === "object") value = normalizeSettingValue(value);

  const normalized = String(value ?? "").trim().toLowerCase();
  if (["0", "fade", "crossfade"].includes(normalized)) return "fade";
  if (["1", "roll", "slide", "rolling"].includes(normalized)) return "roll";
  if (["2", "off", "none", "disabled", "false"].includes(normalized)) return "off";
  if (normalized.includes("off") || normalized.includes("none") || normalized.includes("disabled")) return "off";
  if (normalized.includes("fade") || normalized.includes("crossfade")) return "fade";
  if (normalized.includes("roll") || normalized.includes("slide")) return "roll";

  return CONFIG.lyricTransitionMode;
}

function normalizeSettingsPayload(payload) {
  const source = payload?.settings || payload?.data || payload?.message || payload || {};
  const normalized = {};

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!entry?.uniqueID) continue;
      normalized[entry.uniqueID] = normalizeSettingValue(entry);
    }

    return normalized;
  }

  if (source && typeof source === "object" && source.uniqueID) {
    normalized[source.uniqueID] = normalizeSettingValue(source);
    return normalized;
  }

  if (source && typeof source === "object") {
    const nested = source.settings || source.data || source.message;
    if (nested && nested !== source) {
      const nestedSettings = normalizeSettingsPayload(nested);
      if (Object.keys(nestedSettings).length) return nestedSettings;
    }
  }

  for (const [key, value] of Object.entries(source)) {
    const normalizedValue = normalizeSettingValue(value);
    normalized[key] = normalizedValue;

    if (value && typeof value === "object" && value.uniqueID) {
      normalized[value.uniqueID] = normalizedValue;
    }
  }

  return normalized;
}

function applySettings(payload, options = {}) {
  const settings = normalizeSettingsPayload(payload);
  const previousSongCachePath = CONFIG.songCachePath;
  const previousAliasPath = CONFIG.aliasPath;
  const previousReloadKey = settingsReloadKey();
  let changed = false;
  let recognized = false;

  for (const [key, type] of Object.entries(SETTINGS_TYPES)) {
    if (!(key in settings)) continue;

    recognized = true;
    let nextValue = CONFIG[key];
    if (type === "number") nextValue = parseNumber(settings[key], CONFIG[key]);
    else if (type === "boolean") nextValue = parseBool(settings[key], CONFIG[key]);
    else if (key === "lyricTransitionMode") nextValue = normalizeLyricTransitionMode(settings[key]);
    else if (key === "audioMatchMode") {
      const value = String(settings[key]).toLowerCase();
      nextValue = ["b", "reference", "reference-audio", "2"].includes(value) ? "b" : "a";
    }
    else if (key === "lyricSourcePriority") {
      const value = String(settings[key]).toLowerCase();
      nextValue = ["netease-first", "qq-first", "netease-only", "qq-only"].includes(value) ? value : "netease-first";
    }
    else if (key === "songHeaderFormat") {
      const value = String(settings[key]).toLowerCase();
      nextValue = ["1", "single-line", "single", "one-line"].includes(value) ? "single-line" : "two-line";
    }
    else if (key === "lyricLayout") {
      const value = String(settings[key]).toLowerCase();
      nextValue = ["dashboard", "card", "3"].includes(value)
        ? "dashboard"
        : (["subtitle", "minimal", "4"].includes(value) ? "subtitle" : "lazer");
    }
    else if (key === "dashboardSongIconStyle") {
      const value = String(settings[key]).toLowerCase();
      nextValue = ["square", "circle", "record"].includes(value) ? value : "square";
    }
    else nextValue = String(settings[key]);

    if (CONFIG[key] !== nextValue) {
      CONFIG[key] = nextValue;
      changed = true;
    }
  }

  if (!recognized || !changed) return false;

  applyVisualConfig();
  applyCustomFont();
  applyDebugStatusVisibility();
  if ("mvBackgroundEnabled" in settings || "mvBackgroundResolution" in settings || "lyricLayout" in settings) {
    refreshMvBackgroundForCurrentTrack();
  }
  updateAudioMatchBadge();
  updateSongHeaderFromLatestPayload();
  updateOffsetBadge();
  if (CONFIG.songCachePath !== previousSongCachePath) {
    loadSongCacheIndex();
  }
  if (CONFIG.aliasPath !== previousAliasPath) {
    loadSongAliases();
  }
  lastRenderedLyricIndex = -2;
  if (!options.silent) setStatus("settings: applied");
  if (settingsReloadKey() !== previousReloadKey) {
    refreshCurrentTrackAfterSettings();
  } else {
    renderLyrics(lastLiveTime);
  }

  return true;
}

function settingsReloadKey() {
  return JSON.stringify({
    neteaseApiBase: CONFIG.neteaseApiBase,
    lyricSourcePriority: CONFIG.lyricSourcePriority,
    lyricOffsetMs: CONFIG.lyricOffsetMs,
    audioMatchEnabled: CONFIG.audioMatchEnabled,
    audioMatchMode: CONFIG.audioMatchMode,
    speedMultiplier: CONFIG.speedMultiplier,
    songCachePath: CONFIG.songCachePath,
  });
}

function refreshCurrentTrackAfterSettings() {
  if (!latestTrackPayload) return;

  cancelLyricRequests();
  lyricRetryKey = "";
  abortAudioMatchWork();
  clearTimeout(pendingTrackTimer);
  pendingTrackKey = "";
  pendingTrackPayload = null;
  pendingTrackSince = 0;
  currentTrackKey = "";
  loadedLyricsTrackKey = "";
  loadingLyricsTrackKey = "";
  lyricLoadToken += 1;
  clearDisplayedLyrics("Searching lyrics");
  refreshTrack(latestTrackPayload).catch((error) => {
    setStatus(`settings refresh error: ${error.message}`);
  });
}

function applyVisualConfig() {
  const panel = hexToRgb(CONFIG.panelColor);
  applyPanelColor(panel);
  document.documentElement.style.setProperty("--panel-alpha", String(clamp(Number(CONFIG.panelOpacity), 0, 1)));
  document.documentElement.style.setProperty("--mv-overlay-opacity", String(clamp(Number(CONFIG.mvBackgroundOverlayOpacity), 0.15, 0.95)));
  document.documentElement.style.setProperty("--mv-brightness", String(clamp(Number(CONFIG.mvBackgroundBrightness), 0.25, 1.4)));
  document.documentElement.style.setProperty("--mv-opacity", String(clamp(Number(CONFIG.mvBackgroundOpacity), 0.1, 1)));
  document.documentElement.style.setProperty("--mv-crop-width", String(clamp(Number(CONFIG.mvBackgroundCropWidth), 0.5, 1)));
  document.documentElement.style.setProperty("--mv-crop-height", String(clamp(Number(CONFIG.mvBackgroundCropHeight), 0.5, 1)));
  document.documentElement.style.setProperty("--overlay-width", `${clamp(Number(CONFIG.overlayWidthPx), 320, 2400)}px`);
  const lyricHeight = clamp(Number(CONFIG.lyricsHeightPx), 132, 620);
  const iconSize = Number(CONFIG.dashboardSongIconSizePx) > 0 ? clamp(Number(CONFIG.dashboardSongIconSizePx), 64, 320) : 0;
  document.documentElement.style.setProperty("--lyrics-height", `${lyricHeight}px`);
  document.documentElement.style.setProperty("--dashboard-icon-size", `${iconSize}px`);
  document.documentElement.style.setProperty("--dashboard-header-max-height", `${Math.max(32, Math.floor((lyricHeight - iconSize) / 2) - 8)}px`);
  document.documentElement.style.setProperty("--dashboard-left-column", `${clamp(Number(CONFIG.dashboardLeftColumnPercent), 22, 55)}%`);
  document.documentElement.style.setProperty("--lyric-unplayed-opacity", String(clamp(Number(CONFIG.lyricProgressUnplayedOpacity), 0.12, 0.9)));
  const fontScales = {
    "--title-font-scale": CONFIG.titleFontScale,
    "--artist-font-scale": CONFIG.artistFontScale,
    "--lyric-font-scale": CONFIG.lyricFontScale,
    "--context-font-scale": CONFIG.contextFontScale,
    "--translation-font-scale": CONFIG.translationFontScale,
    "--audio-match-badge-font-scale": CONFIG.audioMatchBadgeFontScale,
    "--offset-font-scale": CONFIG.offsetFontScale,
    "--time-font-scale": CONFIG.timeFontScale,
    "--status-font-scale": CONFIG.statusFontScale,
  };
  for (const [property, value] of Object.entries(fontScales)) {
    document.documentElement.style.setProperty(property, String(clamp(Number(value), 0.5, 3)));
  }
  const layout = ["dashboard", "subtitle"].includes(CONFIG.lyricLayout) ? CONFIG.lyricLayout : "lazer";
  overlayEl?.classList.remove("layout-lazer", "layout-dashboard", "layout-subtitle");
  overlayEl?.classList.add(`layout-${layout}`);
  const iconStyle = ["circle", "record"].includes(CONFIG.dashboardSongIconStyle) ? CONFIG.dashboardSongIconStyle : "square";
  overlayEl?.classList.toggle("song-icon-circle", iconStyle !== "square");
  overlayEl?.classList.toggle("song-icon-record", iconStyle === "record");
  overlayEl?.classList.toggle("lyric-single-line", CONFIG.lyricSingleLineEnabled);
  overlayEl?.classList.toggle("translated-wrap-enabled", CONFIG.translatedLyricWrapEnabled);
  overlayEl?.classList.toggle("lyric-color-gradient", CONFIG.lyricColorGradientEnabled);
  overlayEl?.classList.toggle("lyric-progress-enabled", CONFIG.lyricProgressEnabled);
  overlayEl?.classList.toggle("auto-context-lines", CONFIG.autoContextLinesEnabled);
  const showTimelineVisualizer = Boolean(CONFIG.timelineVisualizerEnabled) && layout === "dashboard";
  overlayEl?.classList.toggle("timeline-visualizer-enabled", showTimelineVisualizer);
  timelineVisualizerEl?.classList.toggle("is-active", showTimelineVisualizer);
  if (!showTimelineVisualizer) resetTimelineVisualizer();
  else {
    startTimelineVisualizerLoop();
    if (currentTrackKey) loadTimelineVisualizerAudio(currentTrackKey);
  }
  updateDashboardSongIcon(currentBackgroundImage);
  scheduleOverlayLayout();
  lastTimelineBucket = -1;
  renderTimeline(lastLiveTime);
}

function applyDebugStatusVisibility() {
  overlayEl?.classList.toggle("show-debug-status", Boolean(CONFIG.showDebugStatus));
  scheduleOverlayLayout();
}

function resetCustomFont() {
  document.documentElement.style.setProperty("--overlay-font", "\"Segoe UI\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", sans-serif");
  scheduleOverlayLayout();
}

async function applyCustomFont() {
  const path = String(CONFIG.customFontPath || "").trim();
  const enabled = Boolean(CONFIG.customFontEnabled && path);
  const loadKey = enabled ? path : "";
  if (loadKey === customFontLoadKey) return;
  customFontLoadKey = loadKey;

  if (!enabled) {
    resetCustomFont();
    return;
  }

  try {
    const url = new URL(encodeURI(path.replace(/\\/g, "/")), window.location.href).toString();
    const family = "tosu-custom-lyrics-font";
    const font = new FontFace(family, `url("${url}") format("truetype")`);
    const loaded = await font.load();
    if (customFontLoadKey !== loadKey) return;
    document.fonts.add(loaded);
    document.documentElement.style.setProperty("--overlay-font", `"${family}", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`);
    scheduleOverlayLayout();
  } catch (error) {
    if (customFontLoadKey !== loadKey) return;
    resetCustomFont();
    setStatus(`custom font unavailable: ${error.message || path}`);
  }
}

async function loadSettingsFile() {
  try {
    const response = await fetch("./settings.json", { cache: "no-store" });
    if (!response.ok) return;
    applySettings(await response.json(), { silent: true });
  } catch {
    // The command channel can still provide settings later.
  }
}
