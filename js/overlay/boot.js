// Register lifecycle hooks and start once, after every overlay script is loaded.
// Keep teardown together: requests, workers, sockets, observers and animations.

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  setStatus(`handled async error: ${event.reason?.message || event.reason || "unknown"}`);
});

window.addEventListener("error", (event) => {
  setStatus(`page error: ${event.message || "unknown"}`);
});

window.addEventListener("pagehide", () => {
  lyricLoadToken += 1;
  cancelLyricRequests();
  currentLyricResult = null;
  abortAudioMatchWork();
  resetTimelineVisualizer();
  dashboardSongIconSource = null;
  resetSongIconPlayback();
  songIconImageEl?.getAnimations?.().forEach(animation => animation.cancel());
  mvBackgroundAbortController?.abort();
  tosuConnectionId += 1;
  settingsConnectionId += 1;
  tosuSocket?.close();
  settingsSocket?.close();
  clearInterval(tosuWatchdogTimer);
  clearInterval(settingsLiveSyncTimer);
  clearTimeout(tosuReconnectTimer);
  clearTimeout(settingsReconnectTimer);
  clearTimeout(pendingTrackTimer);
  if (dashboardHeaderResizeFrame) cancelAnimationFrame(dashboardHeaderResizeFrame);
  dashboardHeaderResizeFrame = 0;
  overlayResizeObserver?.disconnect();
  clearLyricTransitionEffects();
  document.fonts?.removeEventListener("loadingdone", scheduleOverlayLayout);
});

window.addEventListener("resize", scheduleOverlayLayout);
document.addEventListener("visibilitychange", () => {
  overlayEl?.classList.toggle("song-icon-hidden", document.hidden);
});
const overlayResizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleOverlayLayout);
// Child dimensions are outputs of our own synchronous content/layout commit.
// Observing them feeds fitted fonts and row splitting back into the scheduler.
// Lyrics, translations, fonts and artwork already request explicit layouts.
if (overlayEl) overlayResizeObserver?.observe(overlayEl);
document.fonts?.addEventListener("loadingdone", scheduleOverlayLayout);

applyVisualConfig();
applyDebugStatusVisibility();
updateAudioMatchBadge();
loadSettingsFile().finally(() => Promise.allSettled([
  loadSongCacheIndex(),
  loadSongAliases(),
])).finally(() => {
  connectSettings();
  connectTosu();
});
