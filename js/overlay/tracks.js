// Track-change transactions, foreground selection, retry policy and B handoff.
// Tokens/controllers invalidate work from a previously selected track.

function abortAudioMatchWork() {
  audioMatchAbortController?.abort();
  audioMatchAbortController = null;
}

function cancelLyricRequests() {
  lyricQualityAbortController?.abort();
  lyricQualityAbortController = null;
  lyricRequestController?.abort();
  lyricRequestController = null;
  clearTimeout(lyricRetryTimer);
  clearTimeout(lyricRequestDeadline);
  lyricRetryTimer = 0;
}

function scheduleLyricRetry(key) {
  if (key !== currentTrackKey || lyricRetryTimer) return;
  if (lyricRetryKey !== key) { lyricRetryKey = key; lyricRetryAttempts = 0; }
  if (lyricRetryAttempts >= 3) {
    if (!lyricLines.length) setStatus("lyrics unavailable: retry limit reached; reselect track or change recognition settings to retry");
    return;
  }
  const delay = [2000, 5000, 10000][lyricRetryAttempts++];
  lyricRetryTimer = setTimeout(() => {
    lyricRetryTimer = 0;
    if (trackInfoFromPayload(latestTrackPayload || {}).key !== key) return;
    loadedLyricsTrackKey = "";
    refreshTrack(latestTrackPayload).catch(error => setStatus(`lyrics retry: ${error.message}`));
  }, delay);
}

function isRetryableLyricError(error) {
  if (!error) return false;
  if (["network", "timeout", "rate_limited"].includes(error.kind)) return true;
  const message = String(error.message || error);
  if (/audio match aborted|inconclusive|no (?:synced|consistent)|no coherent|HTTP 40[034]|aligned candidate has no/i.test(message)) return false;
  return /timeout|timed out|deadline exceeded|fetch failed|failed to fetch|network|ECONN|HTTP (?:429|5\d\d)|upstream code (?:405|429|5\d\d)/i.test(message);
}

async function loadLyricsByAudioMatch(title, artist, beatmap, options = {}) {
  // A is always the foreground path. B receives this exact coarse match in
  // the background, so it never delays the first usable lyric result.
  const match = await audioMatchCurrentBeatmap(beatmap, { title, artist }, options);
  let result;
  try { result = await loadLyricsByAudioMatchResult(title, artist, match); }
  catch (error) {
    // A identified the recording even when its lyric request failed.
    error.audioMatchCoarseResult = match;
    throw error;
  }
  if (CONFIG.audioMatchMode === "b") {
    result.audioMatchBackgroundContext = {
      title,
      artist,
      beatmap,
      options: { ...options },
      coarseMatch: match,
    };
  }
  return result;
}

async function inconclusiveAudioMatchInstrumental(error, title) {
  const groups = new Map();
  for (const windowResult of error?.audioMatchWindows || []) {
    const windowKey = String(windowResult.windowInfo?.fraction ?? windowResult.effectiveSampleStartMs);
    for (const candidate of windowResult.candidates || []) {
      const name = normalizeForCompare(stripBracketedText(candidate.song?.name || ""));
      if (!name) continue;
      const group = groups.get(name) || new Map();
      const previous = group.get(windowKey);
      if (!previous || candidate.candidateIndex < previous.candidateIndex) group.set(windowKey, candidate);
      groups.set(name, group);
    }
  }
  const candidates = [...groups.values()]
    .filter((windows) => windows.size >= 2)
    .sort((left, right) => right.size - left.size)[0];
  if (!candidates) return null;

  const candidate = [...candidates.values()]
    .sort((left, right) => left.candidateIndex - right.candidateIndex)[0];
  const result = await loadLyricsBySongId(
    candidate.song.id,
    `audio match inconclusive ${candidate.song.id}: ${candidate.song.name || title}`,
  );
  if (!result.instrumental) return null;

  result.neteaseSongTitle = candidate.song.name || title;
  result.neteaseSongArtist = (candidate.song.artists || candidate.song.ar || []).map((item) => item?.name).filter(Boolean).join("/");
  result.audioMatchSource = "audio match instrumental confirmation";
  result.audioMatchDebug = "audio match inconclusive; repeated title candidate has no timed lyrics";
  result.audioMatchConfidence = "0/4";
  return result;
}

async function bpmAudioMatchContext(title, artist, beatmap) {
  const taggedBpm = difficultyBpmTag(beatmap.version);
  if (!CONFIG.bpmTagAudioMatchEnabled || isPackBeatmap(beatmap) || !taggedBpm) return null;

  try {
    const candidates = await searchNeteaseSongs(title, artist);
    for (const song of candidates) {
      const sourceBpm = neteaseSongBpm(song);
      const rawMultiplier = sourceBpm ? taggedBpm / sourceBpm : 0;
      const multiplier = bpmDifficultyMultiplier(beatmap, sourceBpm);
      if (rawMultiplier >= 0.5 && rawMultiplier <= 2.5 && Math.abs(multiplier - 1) >= 0.01) {
        return { titleCandidates: candidates, difficultySpeedMultiplier: multiplier, taggedBpm, sourceBpm };
      }
    }
  } catch {
    // BPM tags are optional acceleration hints; keep the normal path intact.
  }
  return null;
}

async function loadLyricsByMetadata(title, artist, beatmap, payload = {}) {
  const cachedSong = getSongCacheEntry(title, artist, beatmap);
  const cachedSongId = cachedSong?.neteaseSongId || cachedSong?.songId;
  const offset = parseNumber(cachedSong?.lyricOffsetMs, 0);
  const speed = parseNumber(cachedSong?.speedMultiplier, 1);
  const cachedAudioMatchOffsetOk = !cachedSong?.audioMatchSource || audioMatchOffsetInRange(cachedSong.lyricOffsetMs);
  if (cachedSongId && cachedAudioMatchOffsetOk) {
    const cacheOffset = cacheLyricOffset(cachedSong);
    const cacheSpeed = speed;
    let result = await loadLyricsBySongId(cachedSongId, `song cache ${cachedSongId}`, cacheOffset, cacheSpeed);
    result.neteaseSongTitle = cachedSong?.title || title;
    result.neteaseSongArtist = cachedSong?.artist || artist;
    result.neteaseDurationMs = parseNumber(cachedSong?.neteaseDurationMs, 0);
    result.neteaseBpm = parseNumber(cachedSong?.neteaseBpm, 0);
    result.audioMatchSource = cachedSong?.audioMatchSource || "";
    result.audioMatchStartTimeMs = Number.isFinite(Number(cachedSong?.audioMatchStartTimeMs))
      ? Number(cachedSong.audioMatchStartTimeMs)
      : null;
    result.audioMatchSampleStartMs = Number.isFinite(Number(cachedSong?.audioMatchSampleStartMs))
      ? Number(cachedSong.audioMatchSampleStartMs)
      : null;
    result.audioMatchEffectiveSampleStartMs = Number.isFinite(Number(cachedSong?.audioMatchEffectiveSampleStartMs))
      ? Number(cachedSong.audioMatchEffectiveSampleStartMs)
      : null;
    result.audioMatchSpeed = parseNumber(cachedSong?.audioMatchSpeed, 0);
    result.audioMatchConfidence = cachedSong?.audioMatchConfidence || "";
    result = await applyAutoOffset(result, beatmap, payload, cachedSong);

    return result;
  }

  let result = await loadNeteaseLyrics(title, artist, beatmapDuration(beatmap, payload), beatmap);
  result = await applyAutoOffset(result, beatmap, payload, cachedSong);
  return result;
}

async function loadLyricsForTrack(title, artist, beatmap, payload = {}) {
  const attachBackground = result => {
    if (CONFIG.audioMatchMode === "b" && CONFIG.audioMatchEnabled && !result.audioMatchBackgroundContext) {
      const metadataSong = result.providerSong || (result.neteaseSongId ? {
        id: result.neteaseSongId, name: result.neteaseSongTitle || title,
        dt: result.neteaseDurationMs || 0, provider: "netease",
      } : null);
      const inherited = foregroundAudioMatchContext || { title, artist, beatmap, options: {}, coarseMatch: null };
      result.audioMatchBackgroundContext = { ...inherited, options: { ...inherited.options,
        extraCandidates: [...(inherited.options?.extraCandidates || []), ...(metadataSong ? [metadataSong] : [])],
      }, coarseError: foregroundAudioMatchError || inherited.coarseError || new Error("metadata foreground") };
    }
    return result;
  };
  let foregroundAudioMatchError = null;
  let foregroundAudioMatchContext = null;
  if (CONFIG.lyricSourcePriority === "qq-first" || CONFIG.lyricSourcePriority === "qq-only") {
    try { const qq = await loadQqLyrics(title, artist, beatmap); if (qq.lines.length || CONFIG.lyricSourcePriority === "qq-only") return attachBackground(qq); }
    catch (error) { if (String(error.message).includes("audio match aborted") || CONFIG.lyricSourcePriority === "qq-only") throw error; }
  }
  const bpmContext = CONFIG.audioMatchEnabled ? await bpmAudioMatchContext(title, artist, beatmap) : null;
  if (CONFIG.audioMatchEnabled) {
    try {
      const result = await loadLyricsByAudioMatch(title, artist, beatmap, bpmContext || {});
      if (result.lines.length) return result;

      if (result.instrumental) return result;
      foregroundAudioMatchContext = result.audioMatchBackgroundContext || null;
      foregroundAudioMatchError = new Error("audio candidate has no synced lyrics");
    } catch (error) {
      if (String(error.message || "").includes("audio match aborted")) throw error;
      foregroundAudioMatchError = error;
      if (error.audioMatchCoarseResult) foregroundAudioMatchContext = {
        title, artist, beatmap, options: { ...(bpmContext || {}) }, coarseMatch: error.audioMatchCoarseResult,
      };
      if (error.audioMatchInconclusive) {
        try {
          const instrumental = await inconclusiveAudioMatchInstrumental(error, title);
          if (instrumental) return instrumental;
        } catch {
          // Keep the ordinary metadata fallback when the optional lyric check fails.
        }
      }
      setStatus(`audio match failed, fallback to title search: ${error.message}`);
    }
  }

  let metadataResult;
  let metadataError;
  try { metadataResult = await loadLyricsByMetadata(title, artist, beatmap, payload); }
  catch (error) { if (String(error.message).includes("audio match aborted")) throw error; metadataError = error; }
  if (!metadataResult?.lines?.length && !metadataResult?.instrumental && CONFIG.lyricSourcePriority !== "netease-only") {
    try { const qq = await loadQqLyrics(title, artist, beatmap); if (qq.lines.length || qq.instrumental) return attachBackground(retainNeteaseMv(qq, metadataResult)); }
    catch (error) { if (String(error.message).includes("audio match aborted")) throw error; metadataError ||= error; }
  }
  if (!metadataResult && metadataError && !(CONFIG.audioMatchMode === "b" && CONFIG.audioMatchEnabled)) throw metadataError;
  metadataResult ||= { lines: [], translations: [], reason: metadataError?.message || "no synced lyrics" };
  if (!metadataResult.neteaseSongId && !metadataResult.lines.length) {
    metadataResult.audioMatchConfidence = "0/4";
  }
  return attachBackground(metadataResult);
}

async function refreshTrack(payload, trackInfo = null) {
  const {
    beatmap,
    rawTitle,
    rawArtist,
    searchTitle,
    searchArtist,
    key,
  } = trackInfo || trackInfoFromPayload(payload);

  updateTimelineDuration(beatmap, payload);
  updateSongHeader(rawTitle, rawArtist);

  updateBeatmapColor(beatmap, payload).catch(() => {
    const fallback = hexToRgb(CONFIG.panelColor);
    applyPanelColor(fallback);
    applyAccentColor(fallback);
  });

  if (!rawTitle) {
    currentAudioMatchConfidence = null;
    setAudioMatchState("idle");
    if (currentTrackKey || pendingTrackKey || lyricLines.length) {
      currentTrackKey = "";
      lastSeenTrackKey = "";
      pendingTrackKey = "";
      pendingTrackPayload = null;
      pendingTrackSince = 0;
      currentDuration = 0;
      cancelLyricRequests();
      abortAudioMatchWork();
      resetTimelineVisualizer();
      currentNeteaseSongId = "";
      currentNeteaseSongMeta = { title: "", artist: "", durationMs: 0 };
      resetMvTrackIdentity();
      clearMvBackground();
      clearTimeout(pendingTrackTimer);
      lyricLoadToken += 1;
      clearDisplayedLyrics("Waiting for beatmap data");
      setStatus("waiting for beatmap data from tosu");
    }
    return;
  }

  if (key === currentTrackKey && (loadedLyricsTrackKey === key || loadingLyricsTrackKey === key)) return;
  if (key === pendingTrackKey && loadingLyricsTrackKey === key) {
    pendingTrackPayload = payload;
    return;
  }

  if (key !== pendingTrackKey) {
    cancelLyricRequests();
    if (lyricRetryKey !== key) { lyricRetryKey = key; lyricRetryAttempts = 0; }
    abortAudioMatchWork();
    pendingTrackKey = key;
    pendingTrackPayload = payload;
    pendingTrackSince = Date.now();
    currentAudioMatchConfidence = null;
    setAudioMatchState(CONFIG.audioMatchEnabled ? "matching" : "disabled");
    updateTimelineDuration(beatmap, payload, true);
    clearTimeout(pendingTrackTimer);
    lyricLoadToken += 1;
    currentNeteaseSongId = "";
    currentNeteaseSongMeta = { title: "", artist: "", durationMs: 0 };
    resetMvTrackIdentity();
    clearMvBackground();
    clearDisplayedLyrics("Preparing lyrics search");
    setStatus(`beatmap changed, waiting for stable data: ${searchArtist ? `${searchArtist} - ` : ""}${searchTitle}`);
    pendingTrackTimer = setTimeout(() => {
      if (pendingTrackKey === key) {
        refreshTrack(pendingTrackPayload || payload).catch((error) => {
          setStatus(`track refresh error: ${error.message}`);
        });
      }
    }, 320);
    return;
  }

  pendingTrackPayload = payload;

  if (Date.now() - pendingTrackSince < 300) return;

  pendingTrackKey = "";
  pendingTrackPayload = null;
  pendingTrackSince = 0;
  clearTimeout(pendingTrackTimer);
  currentTrackKey = key;
  loadTimelineVisualizerAudio(key);

  const token = ++lyricLoadToken;
  lyricRequestController = new AbortController();
  const requestController = lyricRequestController;
  lyricRequestDeadline = setTimeout(() => requestController.abort(), 90000);
  currentSpeedMultiplier = resolvedLyricSpeed(beatmap);
  loadingLyricsTrackKey = key;
  clearDisplayedLyrics("Searching lyrics");
  loadingLyricsTrackKey = key;
  updateTimelineDuration(beatmap, payload);
  setStatus(`searching lyrics: ${searchArtist ? `${searchArtist} - ` : ""}${searchTitle}`);

  try {
    const reusedResult = sameSongSetResult(beatmap);
    const result = reusedResult || await loadLyricsForTrack(searchTitle, searchArtist, beatmap, payload);
    if (token !== lyricLoadToken) return;
    if (currentTrackKey !== key || trackInfoFromPayload(latestTrackPayload || {}).key !== key) return;
    let backgroundRefinement = result.audioMatchBackgroundContext || null;
    // This is a one-shot runtime handoff. Do not let the context enter the
    // in-memory same-set result or the optional persistent cache payload.
    delete result.audioMatchBackgroundContext;
    if (!backgroundRefinement && reusedResult && CONFIG.audioMatchMode === "b" && CONFIG.audioMatchEnabled) {
      // A sibling difficulty can reuse the foreground song/lyrics for
      // instant display, but its playback rate and audio timeline still
      // need a fresh background measurement. Keep only the established
      // song identity/new rate as the hint; B measures all windows again
      // without repeating the foreground fingerprint requests.
      backgroundRefinement = {
        title: searchTitle,
        artist: searchArtist,
        beatmap,
        options: {},
        coarseMatch: { song: result.providerSong || { id: result.providerSongId || result.neteaseSongId,
          name: result.neteaseSongTitle || searchTitle, provider: result.provider || "netease" },
          offsetMs: result.lyricOffsetMs || 0, speed: resolvedLyricSpeed(beatmap, { neteaseBpm: result.neteaseBpm }),
          debugWindows: [] },
      };
    }
    if (!reusedResult && result.neteaseSongId && result.lines?.length) {
      writeSongCacheIndex(searchTitle, searchArtist, beatmap, result);
    }
    if (!reusedResult) rememberSameSongSetResult(beatmap, result);

    loadingLyricsTrackKey = "";
    currentLyricResult = result;
    currentNeteaseSongId = String(result.neteaseSongId || "");
    currentProvider = result.provider || "netease";
    currentProviderSongId = String(result.providerSongId || result.neteaseSongId || "");
    currentNeteaseSongMeta = {
      title: result.neteaseSongTitle || searchTitle,
      artist: result.neteaseSongArtist || searchArtist,
      durationMs: parseNumber(result.neteaseDurationMs, 0),
    };
    lyricLines = result.lines;
    translatedLines = result.translations;
    loadedLyricsTrackKey = key;
    const cachedAudioMatchSpeed = Number(result.audioMatchSpeed);
    const hasCachedAudioMatchSpeed = result.audioMatchSource
      && Number.isFinite(cachedAudioMatchSpeed)
      && cachedAudioMatchSpeed > 0;
    currentSpeedMultiplier = resolvedLyricSpeed(beatmap, {
      neteaseBpm: result.neteaseBpm,
      // A reused song result carries the source song and lyrics, but its
      // audio-match speed belongs to the previous difficulty. Recalculate
      // the rate from the current difficulty instead of applying that old
      // rate again.
      audioMatchSpeed: hasCachedAudioMatchSpeed && !result.sameSongSetReuse ? cachedAudioMatchSpeed : null,
      storedSpeedMultiplier: hasCachedAudioMatchSpeed && !result.sameSongSetReuse ? 1 : result.speedMultiplier,
    });
    currentTrackOffsetMs = parseNumber(result.lyricOffsetMs, 0);
    currentTrackAlignmentAnchors = !result.sameSongSetReuse && Array.isArray(result.audioMatchAlignmentAnchors)
      ? result.audioMatchAlignmentAnchors.filter((anchor) => (
        Number.isFinite(Number(anchor?.sampleTimeMs)) && Number.isFinite(Number(anchor?.offsetMs))
      ))
      : [];
    currentAutoOffsetSource = result.autoOffsetSource || "";
    updateOffsetBadge();
    currentAudioMatchConfidence = result.audioMatchConfidence || null;
    setAudioMatchState(!lyricResultQuality(result).available && !result.instrumental ? "empty" : result.audioMatchSource || result.audioMatchSucceeded
      ? "success"
      : (CONFIG.audioMatchEnabled ? "fallback" : "disabled"));

    if (lyricLines.length) {
      clearTimeout(lyricRetryTimer);
      lyricRetryTimer = 0;
      setStatus([
        `lyrics: ${result.source || "loaded"}`,
        result.audioMatchDebug || "",
      ].filter(Boolean).join("; "));
      lastRenderedLyricIndex = -2;
      renderLyrics(latestLiveTimeMs());
      // Lyrics can finish loading between two tosu packets. Re-read the
      // live clock on the next frame so the first visible line is selected
      // from the current track time, not the value captured mid-load.
      requestAnimationFrame(() => {
        if (token === lyricLoadToken && loadedLyricsTrackKey === key) renderLyrics(latestLiveTimeMs(), true);
      });
    } else {
      currentLineEl.textContent = result.instrumental ? "纯音乐，请欣赏" : "No synced lyrics found";
      if (typeof lyricsEl !== "undefined") lyricsEl?.classList.remove("is-before-first");
      delete currentLineEl.dataset?.introIndex;
      setStatus(result.instrumental
        ? [
          `instrumental: ${result.source || "audio match found no timed lyrics"}`,
          result.audioMatchDebug || "",
        ].filter(Boolean).join("; ")
        : [
          `no synced lyrics: ${result.reason || result.source || "song found, but no timed LRC was returned"}`,
          result.audioMatchDebug || "",
        ].filter(Boolean).join("; "));
      lastRenderedLyricIndex = -2;
    }

    // Background lookup is deliberately outside the lyric transaction.
    // A third-party video failure must never delay or replace lyrics.
    const mv = resultMvIdentity(result);
    void updateMvBackground(mv.id, mv.meta, key);
    if (backgroundRefinement) {
      void refineLyricsWithReferenceAudio(backgroundRefinement, token, key);
    }
    void refineLyricSourceQuality({ title: searchTitle, artist: searchArtist, beatmap }, token, key);
  } catch (error) {
    if (token !== lyricLoadToken) return;

    loadingLyricsTrackKey = "";
    clearDisplayedLyrics("Lyrics service unavailable");
    loadedLyricsTrackKey = key;
    currentLineEl.textContent = "Lyrics service unavailable";
    setStatus(`lyrics API unavailable: ${error.message}`);
    if (isRetryableLyricError(error)) scheduleLyricRetry(key);
  } finally {
    if (token === lyricLoadToken) clearTimeout(lyricRequestDeadline);
  }
}
