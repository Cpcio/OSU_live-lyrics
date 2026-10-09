// B: reference recording alignment, worker lifetime and verified lyric refinement.
// Foreground display remains owned by tracks.js; stale refinements never commit.

function audioMatchReferenceCandidateList(coarseResult, coarseError, titleCandidates = []) {
  const byId = new Map();
  const addCandidate = (entry, windowInfo = null, titleConfirmed = false, rankOverride = null) => {
    const song = entry?.song || entry;
    const id = String(song?.id || "");
    if (!id) return;
    const previous = byId.get(id) || {
      song,
      windows: new Map(),
      rank: 99,
      titleConfirmed: false,
    };
    const key = String(windowInfo?.fraction ?? windowInfo?.actualStartSeconds ?? "metadata");
    if (windowInfo && !previous.windows.has(key)) previous.windows.set(key, windowInfo);
    const rank = rankOverride === null ? Number(entry?.candidateIndex ?? 99) : Number(rankOverride);
    previous.rank = Math.min(previous.rank, Number.isFinite(rank) ? rank : 99);
    previous.titleConfirmed ||= titleConfirmed;
    byId.set(id, previous);
  };

  const windowResults = coarseResult?.debugWindows || coarseError?.audioMatchWindows || [];
  for (const windowResult of windowResults) {
    const windowInfo = windowResult?.windowInfo || null;
    const candidates = windowResult?.candidates?.length ? windowResult.candidates : [windowResult];
    for (const candidate of candidates) addCandidate(candidate, windowInfo, false);
  }
  addCandidate(coarseResult, coarseResult?.windowInfo, true);
  for (const [rank, song] of (titleCandidates || []).entries()) addCandidate(song, null, true, rank);

  return [...byId.values()]
    .sort((left, right) => (
      right.windows.size - left.windows.size
      || Number(right.titleConfirmed) - Number(left.titleConfirmed)
      || left.rank - right.rank
    ));
}

function audioMatchReferenceWindowList(coarseResult, coarseError, audioBuffer, speed) {
  const byKey = new Map();
  const addWindow = (windowInfo) => {
    if (!windowInfo) return;
    const key = String(windowInfo.fraction ?? windowInfo.actualStartSeconds);
    if (!byKey.has(key)) byKey.set(key, windowInfo);
  };
  for (const entry of coarseResult?.debugWindows || coarseError?.audioMatchWindows || []) {
    addWindow(entry.windowInfo);
  }
  if (!byKey.size || (CONFIG.audioMatchMultiWindowEnabled && parseNumber(CONFIG.audioMatchStartSeconds, -1) < 0)) {
    const requestedDurationSeconds = clamp(parseNumber(CONFIG.audioMatchDurationSeconds, 15), 3, 30);
    const middle = audioMatchWindow(audioBuffer, parseNumber(CONFIG.audioMatchStartSeconds, -1), requestedDurationSeconds, speed);
    middle.fraction = 0.5;
    addWindow(middle);
    if (CONFIG.audioMatchMultiWindowEnabled && parseNumber(CONFIG.audioMatchStartSeconds, -1) < 0) {
      addWindow(audioMatchWindowAtFraction(audioBuffer, 0.25, middle.targetDurationSeconds, speed));
      addWindow(audioMatchWindowAtFraction(audioBuffer, 0.75, middle.targetDurationSeconds, speed));
    }
  }
  return [...byKey.values()].sort((left, right) => left.actualStartSeconds - right.actualStartSeconds);
}

function audioMatchReferenceProxyUrl(songId, provider = "netease") {
  const url = new URL(provider === "qq" ? "/qq/song/audio" : "/song/audio", CONFIG.neteaseApiBase);
  url.searchParams.set("id", String(songId));
  url.searchParams.set("timestamp", Date.now());
  return url.toString();
}

function alignReferenceInWorker(reference, queries, speed, signal, timeline = {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("audio match aborted"));
    let worker;
    try { worker = new Worker(new URL("js/audio-reference-worker.js", document.baseURI)); }
    catch (error) { return reject(new Error(`reference worker unavailable: ${error.message}`)); }
    let finished = false;
    const finish = (error, data) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      error ? reject(error) : resolve(data);
    };
    const cancel = () => finish(new Error("audio match aborted"));
    const timer = setTimeout(() => finish(new Error("reference worker timed out")), 60000);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = event => finish(event.data.error ? new Error(event.data.error) : null, event.data.alignments);
    worker.onerror = event => finish(new Error(`reference worker: ${event.message}`));
    try {
      const copies = [Float32Array.from(reference), ...queries.map(query => Float32Array.from(query))];
      worker.postMessage({ reference: copies[0], queries: copies.slice(1), sampleRate: 8000, speed,
        queryStarts: timeline.queryStarts || [], hintStarts: timeline.hintStarts || [],
        preservePitch: Boolean(CONFIG.audioMatchPitchPreserving),
        options: { frameSize: 1024, hopSize: 512, featureStride: 2, bandCount: 16 } }, copies.map(copy => copy.buffer));
    } catch (error) { finish(error); }
  });
}

function referenceAlignmentCluster(alignments, preferredOffset = null) {
  if (!alignments.length) return [];
  const threshold = Math.max(120, clamp(Number(CONFIG.audioMatchConsensusOffsetMs), 50, 2000));
  const sorted = [...alignments].sort((left, right) => left.offsetMs - right.offsetMs);
  let best = [];
  let bestScore = -Infinity;
  let bestDistance = Infinity;
  for (let start = 0; start < sorted.length; start += 1) {
    const byWindow = new Map();
    for (let end = start; end < sorted.length; end += 1) {
      if (sorted[end].offsetMs - sorted[start].offsetMs > threshold) break;
      const item = sorted[end];
      const key = item.windowInfo?.fraction ?? item.windowInfo?.actualStartSeconds ?? end;
      const previous = byWindow.get(key);
      if (!previous || item.score > previous.score) byWindow.set(key, item);
    }
    const cluster = [...byWindow.values()];
    const score = cluster.reduce((sum, item) => sum + item.score, 0) / cluster.length;
    const offset = cluster.reduce((sum, item) => sum + item.offsetMs, 0) / cluster.length;
    const distance = Number.isFinite(preferredOffset) ? Math.abs(offset - preferredOffset) : Infinity;
    // The coarse position is a tie-breaker only between acoustically
    // equivalent repeated passages, never an override of weaker evidence.
    if (cluster.length > best.length || (cluster.length === best.length
      && (score > bestScore + 0.025 || (score >= bestScore - 0.025 && distance < bestDistance)
        || (!Number.isFinite(preferredOffset) && score > bestScore)))) {
      best = cluster; bestScore = score; bestDistance = distance;
    }
  }
  return best;
}

async function audioMatchReferenceBeatmap(
  beatmap = {},
  searchMeta = {},
  options = {},
  coarseResultOverride = null,
  coarseErrorOverride = null,
) {
  const trackSignal = lyricRequestController?.signal;
  let coarseResult = coarseResultOverride;
  let coarseError = coarseErrorOverride;
  if (!coarseResult && !coarseError) {
    try {
      coarseResult = await audioMatchCurrentBeatmap(beatmap, searchMeta, options);
    } catch (error) {
      if (String(error.message || "").includes("audio match aborted")) throw error;
      coarseError = error;
    }
  }

  // Independent provider searches can overlap. Each provider keeps its
  // existing sequential query order and result ranking.
  const [titleCandidates, qqCandidates] = await Promise.all([
    CONFIG.lyricSourcePriority === "qq-only" ? [] : options.titleCandidates || searchNeteaseSongs(
      searchMeta.title || "", searchMeta.artist || "", beatmap,
    ).catch(() => []),
    options.extraCandidates?.length ? options.extraCandidates
      : CONFIG.lyricSourcePriority === "netease-only" ? []
      : searchQqSongs(searchMeta.title || "", searchMeta.artist || "", beatmap).catch(() => []),
  ]);
  if (trackSignal?.aborted) throw new Error("audio match aborted");
  const allCandidates = audioMatchReferenceCandidateList(coarseResult, coarseError, [...titleCandidates, ...qqCandidates])
    .filter(candidate => CONFIG.lyricSourcePriority !== "qq-only" || candidate.song.provider === "qq")
    .filter(candidate => CONFIG.lyricSourcePriority !== "netease-only" || candidate.song.provider !== "qq");
  const candidateLimit = clamp(parseNumber(CONFIG.audioMatchReferenceCandidateCount, 3), 1, 4);
  const candidates = [];
  const candidateIds = new Set();
  const addReferenceCandidate = (candidate) => {
    const id = String(candidate?.song?.id || "");
    if (!id || candidateIds.has(id) || candidates.length >= Math.min(8, candidateLimit + 3)) return;
    candidateIds.add(id);
    candidates.push(candidate);
  };

  // Keep the foreground A result in the verification set whenever it is
  // available. This protects the common case where A found the right song
  // but its sampled position needs a more accurate offset.
  const coarseSongId = String(coarseResult?.song?.id || "");
  addReferenceCandidate(allCandidates.find((candidate) => String(candidate.song?.id || "") === coarseSongId));

  // Preserve the strongest cross-window audio evidence, then reserve a
  // slot for title search. The latter is needed for instrumental maps and
  // romanized/incomplete beatmap metadata where A's candidate list can be
  // misleading even though the song search still exposes the right track.
  addReferenceCandidate(allCandidates.find((candidate) => candidate.windows.size > 0));
  addReferenceCandidate(allCandidates.find((candidate) => candidate.song.provider === "qq"));
  for (const candidate of allCandidates) {
    if (candidate.titleConfirmed && candidate.windows.size === 0) addReferenceCandidate(candidate);
  }
  for (const candidate of allCandidates) addReferenceCandidate(candidate);
  if (!candidates.length) {
    if (coarseError) throw coarseError;
    return coarseResult;
  }

  abortAudioMatchWork();
  const controller = new AbortController();
  audioMatchAbortController = controller;
  const signal = controller.signal;
  let sourceBytes = null;
  let sourceBuffer = null;
  let querySamplesList = null;
  const speed = audioMatchSpeed(beatmap, options.difficultySpeedMultiplier);
  const candidateResults = [];
  const candidateErrors = [];
  const candidateLyrics = new Map();
  let backgroundTimedOut = false;
  const backgroundDeadline = setTimeout(() => { backgroundTimedOut = true; controller.abort(); }, 180000);

  try {
    sourceBytes = await currentBeatmapAudioBuffer(signal);
    throwIfAudioMatchAborted(signal);
    sourceBuffer = await audioMatchTask(decodeAudioBuffer(sourceBytes, 8000, signal), signal, 15000, "source decode");
    sourceBytes = null;
    throwIfAudioMatchAborted(signal);
    const windowInfos = audioMatchReferenceWindowList(coarseResult, coarseError, sourceBuffer, speed);
    const queryStarts = windowInfos.map(info => info.targetStartSeconds * 1000);

    for (const candidate of candidates) {
      const verifiedCount = candidateResults.filter(result => result.coherent.length >= Math.min(2, windowInfos.length)
        && result.score >= 0.55).length;
      if (verifiedCount >= candidateLimit) break;
      throwIfAudioMatchAborted(signal);
      let referenceBytes = null;
      let referenceBuffer = null;
      try {
        // Lyrics are small; reject an unusable catalogue entry before a
        // full recording download/worker. The foreground recording can
        // still refine its existing lyric stream if this endpoint is empty.
        if (typeof loadLyricsBySongId === "function" && typeof loadQqLyricsBySong === "function") {
          const lyrics = candidate.song.provider === "qq"
            ? await loadQqLyricsBySong(candidate.song, { signal })
            : await loadLyricsBySongId(candidate.song.id, `NetEase: ${candidate.song.name}`, 0, 1, { signal });
          candidateLyrics.set(candidate.song.id, lyrics);
          const sameForeground = (candidate.song.provider || "netease") === (currentLyricResult?.provider || "netease")
            && String(candidate.song.id) === String(currentLyricResult?.providerSongId || currentLyricResult?.neteaseSongId || "")
            && currentLyricResult?.lines?.length;
          if (!lyricResultQuality(lyrics).available && !lyrics.instrumental && !sameForeground) {
            candidateErrors.push(`${candidate.song.id}: no synced lyrics`); continue;
          }
        }
        setStatus(`reference alignment: ${candidate.song.name || candidate.song.id}`);
        referenceBytes = await fetchArrayBuffer(audioMatchReferenceProxyUrl(candidate.song.id, candidate.song.provider), signal);
        throwIfAudioMatchAborted(signal);
        referenceBuffer = await audioMatchTask(decodeAudioBuffer(referenceBytes, 8000, signal), signal, 15000, "reference decode");
        referenceBytes = null;
        const referenceSamples = referenceBuffer.getChannelData(0);
        // These clips belong to this one verification transaction. Cut
        // them only after a reference is available, then keep using the
        // same source clips for each candidate; the worker gets copies.
        querySamplesList ||= windowInfos.map(windowInfo => audioMatchSamples(sourceBuffer, windowInfo.actualStartSeconds, windowInfo.actualDurationSeconds));
        const sameCoarse = String(candidate.song.id) === String(coarseResult?.song?.id)
          && (candidate.song.provider || "netease") === (coarseResult?.song?.provider || "netease");
        const measured = await alignReferenceInWorker(referenceSamples, querySamplesList, speed, signal, {
          queryStarts, hintStarts: sameCoarse ? queryStarts.map(start => start + coarseResult.offsetMs) : []
        });
        const alignments = [];
        for (const [index, windowInfo] of windowInfos.entries()) {
          throwIfAudioMatchAborted(signal);
          const alignment = measured[index];
          for (const location of alignment.hypotheses || [alignment]) {
            if (!Number.isFinite(location.startMs) || location.score < 0.48) continue;
            const offsetMs = Math.round(location.startMs - windowInfo.targetStartSeconds * 1000);
            if (!audioMatchOffsetInRange(offsetMs)) continue;
            alignments.push({
            ...location,
            windowInfo,
            startTimeMs: location.startMs,
            offsetMs,
          });
          }
        }

        const coherent = referenceAlignmentCluster(alignments, sameCoarse ? coarseResult.offsetMs : null);
        if (!coherent.length) { candidateErrors.push(`${candidate.song.id}: no coherent locations`); continue; }
        const averageScore = coherent.reduce((total, item) => total + item.score, 0) / coherent.length;
        const score = averageScore;
        candidateResults.push({ candidate, alignments, coherent, score });
        if (sameCoarse && coherent.length === windowInfos.length && coherent.length >= 3 && score >= 0.85
          && String(currentLyricResult?.providerSongId || currentLyricResult?.neteaseSongId || "") === String(candidate.song.id)
          && (currentLyricResult?.provider || "netease") === (candidate.song.provider || "netease")
          && currentLyricResult?.lines?.length) break;
      } catch (error) {
        if (String(error.message || "").includes("audio match aborted")) throw error;
        candidateErrors.push(`${candidate.song.id}: ${error.message}`);
      } finally {
        referenceBytes = null;
        referenceBuffer = null;
      }
    }

    const coarseSongId = String(coarseResult?.song?.id || "");
    const coarseProvider = coarseResult?.song?.provider || "netease";
    const recoveryMode = !coarseResult;
    const keepsForeground = result => Boolean(coarseSongId
      && coarseSongId === String(result?.candidate?.song?.id || "")
      && coarseProvider === (result?.candidate?.song?.provider || "netease"));
    const usableSingleRecovery = result => Boolean(recoveryMode && result.coherent.length === 1
      && result.score >= 0.82 && result.coherent[0].margin >= 0.025
      && (result.candidate.titleConfirmed || result.candidate.windows.size > 0));
    const isUsable = result => {
      const same = keepsForeground(result);
      const score = same ? 0.48 : recoveryMode ? 0.55 : 0.60;
      const windows = recoveryMode || same ? Math.min(2, windowInfos.length) : 2;
      return result.score >= score && (result.coherent.length >= windows || usableSingleRecovery(result));
    };
    // A single accidental peak must not hide a multi-window verified result.
    candidateResults.sort((left, right) => right.coherent.length - left.coherent.length || right.score - left.score);
    const usableResults = candidateResults.filter(isUsable);
    let selected = usableResults[0];
    let second = usableResults[1];
    const canonicalName = result => normalizeForCompare(stripBracketedText(result?.candidate?.song?.name || ""));
    const meanOffset = result => result.coherent.reduce((sum, item) => sum + item.offsetMs, 0) / result.coherent.length;
    // Duplicate catalogue IDs/masterings should not fail the replacement
    // margin test when every window independently validates the same song
    // and almost the same recording origin.
    const equivalentRecordings = Boolean(selected && second && selected.score >= 0.85 && second.score >= 0.85
      && selected.coherent.length === windowInfos.length && second.coherent.length === windowInfos.length
      && canonicalName(selected) && canonicalName(selected) === canonicalName(second)
      && Math.abs(meanOffset(selected) - meanOffset(second)) <= 1500);
    if (selected && !keepsForeground(selected) && !equivalentRecordings && second
      && selected.coherent.length === second.coherent.length && selected.score - second.score < 0.04) {
      const foreground = usableResults.find(keepsForeground);
      if (foreground && foreground.score >= selected.score - 0.08) {
        selected = foreground;
        second = usableResults.find(result => result !== foreground);
      }
    }
    const keepsCoarseSong = keepsForeground(selected);
    // A failed foreground match needs a recoverable path. Keep the
    // replacement path strict when A already identified a song, but do not
    // require the same margin from a candidate that is the first usable
    // result. Cross-window agreement still remains the primary safeguard.
    const minimumScore = keepsCoarseSong ? 0.48 : recoveryMode ? 0.55 : 0.60;
    const minimumWindows = recoveryMode
      ? (windowInfos.length >= 2 ? 2 : 1)
      : (keepsCoarseSong ? (windowInfos.length >= 2 ? 2 : 1) : 2);
    const canUseSingleRecovery = (candidateResult) => Boolean(
      recoveryMode
      && candidateResult
      && candidateResult.coherent.length === 1
      && candidateResult.score >= 0.82
      && candidateResult.coherent[0].margin >= 0.025
      && (
        candidateResult.candidate.titleConfirmed
        || candidateResult.candidate.windows.size > 0
      ),
    );
    const titleConfirmedSingleWindow = Boolean(
      canUseSingleRecovery(selected),
    );
    const replacementMargin = second && second.coherent.length >= selected.coherent.length ? selected.score - second.score : Infinity;
    const hasEnoughWindows = Boolean(
      selected
      && (selected.coherent.length >= minimumWindows || titleConfirmedSingleWindow),
    );
    if (!selected
      || selected.score < minimumScore
      || !hasEnoughWindows
      || (!recoveryMode && !keepsCoarseSong && !equivalentRecordings && replacementMargin < 0.04)) {
      if (coarseResult) return {
        ...coarseResult,
        decision: `${coarseResult.decision || "coarse match"}; reference alignment inconclusive`,
      };
      throw new Error(`reference alignment inconclusive: ${candidateErrors.join("; ") || "insufficient independent windows"}`);
    }

    const buildReferenceMatch = (candidateResult) => {
      const entries = [...candidateResult.coherent]
        .sort((left, right) => left.windowInfo.targetStartSeconds - right.windowInfo.targetStartSeconds);
      const preferred = entries.find((entry) => entry.windowInfo.fraction === 0.5) || entries[0];
      const offsets = candidateResult.coherent.map((entry) => entry.offsetMs).sort((left, right) => left - right);
      const offsetMs = Math.round(offsets[Math.floor(offsets.length / 2)]);
      const debugWindows = entries.map((entry) => ({
        song: candidateResult.candidate.song,
        startTimeMs: entry.startTimeMs,
        offsetMs: entry.offsetMs,
        effectiveSampleStartMs: Math.round(entry.windowInfo.targetStartSeconds * 1000),
        sampleStartMs: Math.round(entry.windowInfo.actualStartSeconds * 1000),
        speed,
        windowInfo: entry.windowInfo,
        mode: "reference",
      }));
      return {
        song: candidateResult.candidate.song,
        startTimeMs: preferred.startTimeMs,
        sampleStartMs: Math.round(preferred.windowInfo.actualStartSeconds * 1000),
        effectiveSampleStartMs: Math.round(preferred.windowInfo.targetStartSeconds * 1000),
        offsetMs,
        speed,
        alignmentMode: "reference",
        // These locations agree on a fixed offset; interpolate only when
        // a separately validated edit model exists.
        alignmentAnchors: [],
        decision: `reference alignment ${candidateResult.coherent.length}/${windowInfos.length}, score ${candidateResult.score.toFixed(3)}`,
        debugWindows,
        confidence: audioMatchConfidence({ song: candidateResult.candidate.song }, debugWindows),
        titleCandidateCount: titleCandidates.length,
        referenceScore: candidateResult.score,
        referenceTitleConfirmed: Boolean(candidateResult.candidate.titleConfirmed),
        prefetchedLyrics: candidateLyrics.get(candidateResult.candidate.song.id),
      };
    };

    const selectedMatch = buildReferenceMatch(selected);
    const referenceAlternatives = usableResults
      .filter(result => result !== selected)
      .map(buildReferenceMatch)
      .filter(Boolean)
      .slice(0, 3);
    return {
      ...selectedMatch,
      // Audio alignment can identify an alternate recording that has no
      // timed lyrics. Keep other sufficiently coherent candidates so the
      // lyric loader can choose a usable entry without rerunning audio.
      referenceAlternatives,
      referenceRecovery: recoveryMode,
    };
  } catch (error) {
    if (backgroundTimedOut) throw new Error("reference refinement deadline exceeded");
    throw error;
  } finally {
    clearTimeout(backgroundDeadline);
    sourceBytes = null;
    sourceBuffer = null;
    querySamplesList = null;
    candidateLyrics.clear();
    if (audioMatchAbortController === controller) audioMatchAbortController = null;
  }
}

function restoreCandidateLyricRoles(candidate, originals, translations) {
  // Use sentence identity, never artist spelling or script alone. Real
  // Chinese recordings and alternate editions must remain selectable.
  const texts = list => new Set((list || []).map(line => String(line.text || "").normalize("NFKC")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")).filter(text => text.length >= 4));
  const originalTexts = texts(originals);
  const translatedTexts = texts(translations);
  const candidateTexts = texts(candidate.lines);
  const coverage = (source, target) => [...source].filter(text => target.has(text)).length / Math.max(1, source.size);
  if (candidateTexts.size < 3 || originalTexts.size < 3 || translatedTexts.size < 3
    || coverage(candidateTexts, translatedTexts) < 0.8 || coverage(candidateTexts, originalTexts) >= 0.4) return candidate;
  const alternateTexts = texts(candidate.translations);
  if (alternateTexts.size >= 3 && coverage(alternateTexts, originalTexts) >= 0.8) {
    const source = candidate.translations.map(({ time, text }) => ({ time, text }));
    const translated = candidate.lines.map(({ time, text }) => ({ time, text }));
    return { ...candidate, lines: associateTranslationLines(source, translated), translations: translated, lyricFormat: "lrc" };
  }
  return null;
}

function canCommitInstrumentalLyrics(candidate, match, foreground) {
  if (!candidate?.instrumental || !(match?.referenceScore >= 0.85) || !(match.debugWindows?.length >= 2)) return false;
  // Reference audio proves the recording, not a catalogue's "no lyrics"
  // claim. A generic QQ instrumental/no-lyric placeholder alone cannot
  // erase an already usable vocal stream.
  return candidate.provider !== "qq" || !lyricResultQuality(foreground).available;
}

async function refineLyricsWithReferenceAudio(context, token, trackKey) {
  if (!context || CONFIG.audioMatchMode !== "b" || !CONFIG.audioMatchEnabled) return;
  const isCurrent = () => token === lyricLoadToken
    && currentTrackKey === trackKey
    && trackInfoFromPayload(latestTrackPayload || {}).key === trackKey;
  const retainedState = () => lyricResultQuality(currentLyricResult || { lines: lyricLines }).available || currentLyricResult?.instrumental
    ? (currentAudioMatchConfidence ? "success" : "fallback") : "empty";

  let retryableFailure = false;
  try {
    setAudioMatchState("refining");
    setStatus("audio match: refining in background");
    const match = await audioMatchReferenceBeatmap(
      context.beatmap,
      { title: context.title, artist: context.artist },
      context.options || {},
      context.coarseMatch || null,
      context.coarseError || null,
    );
    if (!isCurrent()) return;
    if (!match || match.alignmentMode !== "reference") {
      // Reference alignment may deliberately return the already accepted
      // A result when B is inconclusive. Do not leave the badge in the
      // intermediate "refining" state in that case.
      setAudioMatchState(retainedState());
      setStatus("audio match: foreground result retained");
      return;
    }

    const referenceMatches = [match, ...(match.referenceAlternatives || [])];
    let refined = null;
    let refinedMatch = null;
    let rejectedTranslationSource = false;
    for (const referenceMatch of referenceMatches) {
      if (!isCurrent()) return;
      try {
        const loadedCandidate = await loadLyricsByAudioMatchResult(
          context.title,
          context.artist,
          referenceMatch,
        );
        if (!isCurrent()) return;
        let candidateLyrics = restoreCandidateLyricRoles(loadedCandidate, lyricLines, translatedLines);
        if (!candidateLyrics) {
          rejectedTranslationSource = true;
          continue;
        }
        if (!lyricResultQuality(candidateLyrics).available && !candidateLyrics.instrumental
          && lyricResultQuality(currentLyricResult).available
          && (referenceMatch.song.provider || "netease") === (currentLyricResult.provider || "netease")
          && String(referenceMatch.song.id) === String(currentLyricResult.providerSongId || currentLyricResult.neteaseSongId)) {
          // Identity is exact: an empty refreshed endpoint need not discard
          // the original/translation already loaded for this recording.
          candidateLyrics = { ...candidateLyrics, lines: currentLyricResult.lines, translations: currentLyricResult.translations,
            lyricFormat: currentLyricResult.lyricFormat };
        }
        if (!refined) {
          refined = candidateLyrics;
          refinedMatch = referenceMatch;
        }
        const verifiedInstrumental = canCommitInstrumentalLyrics(candidateLyrics, referenceMatch, currentLyricResult || { lines: lyricLines });
        if (lyricResultQuality(candidateLyrics).available || verifiedInstrumental) {
          refined = candidateLyrics;
          refinedMatch = referenceMatch;
          break;
        }
      } catch {
        // A candidate may have audio but an unavailable lyric endpoint;
        // continue with the next already-aligned reference candidate.
      }
    }
    if (!isCurrent()) return;
    // Audio alignment alone is not enough to replace lyrics. In
    // particular, NetEase can return a valid recording entry with no
    // synced LRC/YRC. Keep the foreground state and clear the refining
    // badge instead of replacing it with "No synced lyrics found".
    const verifiedInstrumental = canCommitInstrumentalLyrics(refined, refinedMatch, currentLyricResult || { lines: lyricLines });
    if (!lyricResultQuality(refined).available && !verifiedInstrumental) {
      setAudioMatchState(retainedState());
      setStatus(rejectedTranslationSource
        ? "audio match: candidate original duplicates translation; foreground result retained"
        : "audio match: aligned candidate has no synced lyrics; foreground result retained");
      return;
    }
    // Retain a better same-recording lyric stream while adopting B's freshly
    // verified clock. Different originals still follow the audio decision.
    if (!verifiedInstrumental) refined = preferLyricQuality(refined, currentLyricResult);
    currentLyricResult = refined;

    rememberSameSongSetResult(context.beatmap, refined);
    currentProvider = refined.provider || "netease";
    currentProviderSongId = String(refined.providerSongId || refined.neteaseSongId || "");
    currentNeteaseSongId = String(refined.neteaseSongId || "");
    currentNeteaseSongMeta = {
      title: refined.neteaseSongTitle || context.title,
      artist: refined.neteaseSongArtist || context.artist,
      durationMs: parseNumber(refined.neteaseDurationMs, 0),
    };
    lyricLines = refined.lines || [];
    translatedLines = refined.translations || [];
    loadedLyricsTrackKey = trackKey;
    clearTimeout(lyricRetryTimer);
    lyricRetryTimer = 0;
    currentSpeedMultiplier = resolvedLyricSpeed(context.beatmap, {
      neteaseBpm: refined.neteaseBpm,
      audioMatchSpeed: refined.audioMatchSpeed,
      storedSpeedMultiplier: 1,
    });
    currentTrackOffsetMs = parseNumber(refined.lyricOffsetMs, 0);
    currentTrackAlignmentAnchors = Array.isArray(refined.audioMatchAlignmentAnchors)
      ? refined.audioMatchAlignmentAnchors.filter((anchor) => (
        Number.isFinite(Number(anchor?.sampleTimeMs)) && Number.isFinite(Number(anchor?.offsetMs))
      ))
      : [];
    currentAutoOffsetSource = refined.autoOffsetSource || "";
    currentAudioMatchConfidence = refined.audioMatchConfidence || null;
    updateOffsetBadge();
    setAudioMatchState("success");

    if (lyricLines.length) {
      lastRenderedLyricIndex = -2;
      renderLyrics(latestLiveTimeMs(), true);
      requestAnimationFrame(() => {
        if (isCurrent()) renderLyrics(latestLiveTimeMs(), true);
      });
    } else {
      currentLineEl.textContent = refined.instrumental ? "纯音乐，请欣赏" : "No synced lyrics found";
      if (typeof lyricsEl !== "undefined") lyricsEl?.classList.remove("is-before-first");
      delete currentLineEl.dataset?.introIndex;
    }
    setStatus([
      `lyrics refined: ${refined.source || "reference audio alignment"}`,
      refined.audioMatchDebug || refinedMatch?.decision || "",
    ].filter(Boolean).join("; "));
    const mv = resultMvIdentity(refined);
    void updateMvBackground(mv.id, mv.meta, trackKey);
    void refineLyricSourceQuality(context, token, trackKey);
  } catch (error) {
    if (!isCurrent() || String(error.message || "").includes("audio match aborted")) return;
    retryableFailure = isRetryableLyricError(error);
    // Keep the already visible A result. B is an optional refinement pass.
    setAudioMatchState(retainedState());
    const reason = String(error?.message || error || "unknown error")
      .replace(/\s+/g, " ")
      .slice(0, 120);
    console.warn(`[lyrics] background refinement skipped: ${reason || "unknown error"}`);
    setStatus(`B unavailable: ${reason}; foreground retained`);
  } finally {
    if (isCurrent() && !lyricLines.length && retryableFailure) scheduleLyricRetry(trackKey);
  }
}
