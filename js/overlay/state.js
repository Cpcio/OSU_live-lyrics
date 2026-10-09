// Configuration defaults, setting types, DOM references and shared runtime state.
// This file owns declarations only; boot.js starts the application.

const CONFIG = {
  tosuWebSocket: "ws://127.0.0.1:24050/websocket/v2",
  neteaseApiBase: "http://127.0.0.1:3002",
  lyricOffsetMs: 0,
  audioMatchEnabled: true,
  audioMatchMode: "b",
  audioMatchStartSeconds: -1,
  audioMatchDurationSeconds: 15,
  audioMatchMinOffsetMs: -40000,
  audioMatchMaxOffsetMs: 100000,
  audioMatchPitchPreserving: true,
  audioMatchMultiWindowEnabled: true,
  audioMatchAlwaysUseAllWindows: true,
  audioMatchConsensusOffsetMs: 200,
  audioMatchReferenceCandidateCount: 3,
  autoOffsetFromFirstObject: false,
  autoOffsetMaxMs: 45000,
  autoOffsetLeadMs: 900,
  autoSpeedFromDifficulty: true,
  reuseSameSongSet: true,
  bpmTagAudioMatchEnabled: true,
  speedMultiplier: 1,
  retryDelayMs: 1200,
  lyricSourcePriority: "netease-first",
  searchLimit: 8,
  contextBefore: 2,
  contextAfter: 2,
  autoContextLinesEnabled: false,
  showTranslation: true,
  lyricTransitionMode: "fade",
  showAudioMatchBadge: true,
  showDebugStatus: true,
  songHeaderFormat: "two-line",
  lyricLayout: "lazer",
  dashboardSongIconEnabled: true,
  dashboardSongIconStyle: "square",
  dashboardSongIconSizePx: 0,
  lyricSingleLineEnabled: true,
  translatedLyricWrapEnabled: true,
  lyricColorGradientEnabled: false,
  dashboardLeftColumnPercent: 36,
  timelineVisualizerEnabled: true,
  timelineVisualizerBarCount: 36,
  timelineVisualizerSensitivity: 1.25,
  timelineVisualizerFallSpeed: 3.8,
  lyricProgressEnabled: true,
  lyricProgressUnplayedOpacity: 0.46,
  customFontEnabled: false,
  customFontPath: "",
  titleFontScale: 1,
  artistFontScale: 1,
  lyricFontScale: 1.3,
  contextFontScale: 1.2,
  translationFontScale: 1,
  audioMatchBadgeFontScale: 1,
  offsetFontScale: 1,
  timeFontScale: 1,
  statusFontScale: 1,
  overlayWidthPx: 900,
  overlayHeightPx: 0,
  lyricsHeightPx: 250,
  panelColor: "#090c12",
  panelOpacity: 0.5,
  panelColorMode: "beatmap",
  beatmapColorBlend: 0.72,
  autoAccentFromBeatmap: true,
  mvBackgroundEnabled: true,
  mvBackgroundResolution: 720,
  mvBackgroundOverlayOpacity: 0.5,
  mvBackgroundBrightness: 1,
  mvBackgroundOpacity: 0.7,
  mvBackgroundCropWidth: 0.78,
  mvBackgroundCropHeight: 0.9,
  searchEndpoints: ["/search", "/cloudsearch"],
  fetchTimeoutMs: 4500,
  allowPostFallback: true,
  songCachePath: "song-cache.json",
  songCacheWriteEndpoint: "",
  aliasPath: "",
};

// Editable setting whitelist; internal defaults are intentionally not all exposed.
// Recognition sampling, pitch restoration, consensus and speed detection use
// the defaults above. Removing them here also ignores legacy saved toggles.
const SETTINGS_TYPES = {
  neteaseApiBase: "string",
  lyricSourcePriority: "string",
  lyricOffsetMs: "number",
  audioMatchEnabled: "boolean",
  audioMatchMode: "string",
  speedMultiplier: "number",
  contextBefore: "number",
  contextAfter: "number",
  autoContextLinesEnabled: "boolean",
  showTranslation: "boolean",
  lyricTransitionMode: "string",
  showAudioMatchBadge: "boolean",
  showDebugStatus: "boolean",
  songHeaderFormat: "string",
  lyricLayout: "string",
  dashboardSongIconEnabled: "boolean",
  dashboardSongIconStyle: "string",
  dashboardSongIconSizePx: "number",
  lyricSingleLineEnabled: "boolean",
  translatedLyricWrapEnabled: "boolean",
  lyricColorGradientEnabled: "boolean",
  dashboardLeftColumnPercent: "number",
  timelineVisualizerEnabled: "boolean",
  timelineVisualizerBarCount: "number",
  timelineVisualizerSensitivity: "number",
  timelineVisualizerFallSpeed: "number",
  lyricProgressEnabled: "boolean",
  lyricProgressUnplayedOpacity: "number",
  customFontEnabled: "boolean",
  customFontPath: "string",
  titleFontScale: "number",
  artistFontScale: "number",
  lyricFontScale: "number",
  contextFontScale: "number",
  translationFontScale: "number",
  audioMatchBadgeFontScale: "number",
  offsetFontScale: "number",
  timeFontScale: "number",
  statusFontScale: "number",
  overlayWidthPx: "number",
  overlayHeightPx: "number",
  lyricsHeightPx: "number",
  panelColor: "string",
  panelOpacity: "number",
  panelColorMode: "string",
  beatmapColorBlend: "number",
  autoAccentFromBeatmap: "boolean",
  mvBackgroundEnabled: "boolean",
  mvBackgroundResolution: "number",
  mvBackgroundOverlayOpacity: "number",
  mvBackgroundBrightness: "number",
  mvBackgroundOpacity: "number",
  mvBackgroundCropWidth: "number",
  mvBackgroundCropHeight: "number",
  fetchTimeoutMs: "number",
};

// DOM references: keep IDs synchronized with index.html.
const titleEl = document.getElementById("title");
const titleTailEl = document.getElementById("titleTail");
const artistEl = document.getElementById("artist");
const songCopyEl = document.getElementById("songCopy");
const songIconImageEl = document.getElementById("songIconImage");
const offsetBadgeEl = document.getElementById("offsetBadge");
const audioMatchBadgeEl = document.getElementById("audioMatchBadge");
const timelineFillEl = document.getElementById("timelineFill");
const timelineVisualizerEl = document.getElementById("timelineVisualizer");
const beforeLinesEl = document.getElementById("beforeLines");
const currentLineEl = document.getElementById("currentLine");
const currentTimeEl = document.getElementById("currentTime");
const translationEl = document.getElementById("translation");
const afterLinesEl = document.getElementById("afterLines");
const statusEl = document.getElementById("status");
const lyricsEl = document.querySelector(".lyrics");
const overlayEl = document.querySelector(".overlay");
const mvBackgroundEl = document.getElementById("mvBackground");

// Current track transaction and committed lyric data.
let currentTrackKey = "";
let lastSeenTrackKey = "";
let pendingTrackKey = "";
let pendingTrackPayload = null;
let latestTrackPayload = null;
let pendingTrackTimer = 0;
let pendingTrackSince = 0;
let lyricLines = [];
let translatedLines = [];
let loadedLyricsTrackKey = "";
let loadingLyricsTrackKey = "";
let lyricLoadToken = 0;
// Artwork loading and the current cover source.
let currentBackgroundKey = "";
let currentBackgroundImage = null;
let dashboardSongIconSource = null;
// Disc playback is independent of MV loading/clearing and needs no RAF loop.
let lastSongIconLiveTime = null;
let lastSongIconAdvanceAt = 0;
let songIconPlaybackActive = false;
let backgroundLoadToken = 0;
// Spectrum buffers, analysis history and animation frame.
let timelineVisualizerAudioBuffer = null;
let timelineVisualizerTrackKey = "";
let timelineVisualizerAbortController = null;
let timelineVisualizerLevels = [];
let timelineVisualizerFftReal = null;
let timelineVisualizerFftImaginary = null;
let timelineVisualizerFftWindow = null;
let timelineVisualizerSpectrumOutput = null;
let timelineVisualizerSpectrumEnergies = null;
let timelineVisualizerSpectrumBinCounts = null;
let timelineVisualizerSpectrumBandFrequencies = null;
let timelineVisualizerLastRenderAt = 0;
let timelineVisualizerFrame = 0;
// Responsive layout scheduling and stable header text.
let dashboardHeaderResizeFrame = 0;
let lyricViewportLayoutKey = "";
let dashboardHeaderTitle = "Waiting for beatmap data...";
let dashboardHeaderArtist = "";
// Playback clocks, alignment and rendered-line position.
let currentDuration = 0;
let currentSpeedMultiplier = 1;
let currentTrackOffsetMs = 0;
let currentTrackAlignmentAnchors = [];
let currentAutoOffsetSource = "";
let lastRenderedLyricIndex = -2;
let lastTimelineBucket = -1;
let lastLiveTime = 0;
let lastSeenLiveTime = 0;
// Existing same-song results and user-provided aliases.
let songCacheIndex = {};
let externalAliases = {};
// Data/settings connection ownership.
let tosuSocket = null;
let settingsSocket = null;
let tosuReconnectTimer = 0;
let settingsReconnectTimer = 0;
let settingsLiveSyncTimer = 0;
let tosuConnectionId = 0;
let settingsConnectionId = 0;
// Identification/HTTP cancellation and bounded retries.
let audioMatchAbortController = null;
let lyricRequestController = null;
let lyricRequestDeadline = 0;
let lyricRetryTimer = 0;
let lyricRetryKey = "";
let lyricRetryAttempts = 0;
let tosuWatchdogTimer = 0;
let tosuLastMessageAt = 0;
let tosuReconnectAttempts = 0;
let settingsReconnectAttempts = 0;
// Committed lyric provider identity.
let currentProvider = "netease";
let currentProviderSongId = "";
let currentLyricResult = null;
let lyricQualityAbortController = null;
// Transient lyric animation resources.
let lyricTransitionTimer = 0;
let lyricAnimationFrame = 0;
let lyricTransitionGeneration = 0;
let customFontLoadKey = "";
let currentLyricProgressUnits = [];
let currentLyricEllipsis = null;
let lastLyricProgressRenderAt = 0;
// Recognition state and existing same-set results.
let currentAudioMatchState = "idle";
let currentAudioMatchConfidence = null;
const sameSongSetResults = new Map();
// MV lookup and playback state.
let currentMvBackgroundKey = "";
let currentNeteaseSongId = "";
let currentNeteaseSongMeta = { title: "", artist: "", durationMs: 0 };
// Video identity survives a lyric-provider change within the same track.
let currentMvSongId = "";
let currentMvSongMeta = { title: "", artist: "", durationMs: 0 };
let currentMvTrackKey = "";
let mvBackgroundAbortController = null;
let currentMvPlaybackPaused = false;
let lastMvObservedLiveTime = null;
let lastMvLiveAdvanceAt = 0;

// Lazy audio dependency shared across matches; no work begins here.
let soundTouchRuntimePromise = null;
