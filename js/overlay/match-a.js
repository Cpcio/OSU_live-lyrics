// A: fingerprint candidates, independent-window votes and coarse time alignment.

function audioMatchSpeed(beatmap = {}, difficultySpeedOverride = null) {
  return resolvedLyricSpeed(beatmap, { difficultySpeedOverride });
}

function audioMatchCandidates(response) {
  return (response?.data?.result || []).filter((item) => item?.song?.id);
}

function audioMatchEntryFromCandidate(base, candidate, candidateIndex = 0) {
  if (!candidate?.song?.id) return null;
  const startTimeMs = parseNumber(candidate.startTime, base.effectiveSampleStartMs);
  const offsetMs = Math.round(startTimeMs - base.effectiveSampleStartMs);
  if (!audioMatchOffsetInRange(offsetMs)) return null;
  return {
    ...base,
    song: candidate.song,
    startTimeMs,
    offsetMs,
    raw: candidate,
    candidateIndex,
  };
}

function selectAudioMatchEntries(entries, titleIds) {
  const windowKeyFor = (entry) => String(entry.windowInfo?.fraction ?? entry.effectiveSampleStartMs);
  const coherentCluster = (candidates) => {
    if (candidates.length < 2) return { size: candidates.length, spread: Infinity };
    const threshold = clamp(Number(CONFIG.audioMatchConsensusOffsetMs), 50, 2000);
    const sorted = [...candidates].sort((left, right) => left.offsetMs - right.offsetMs);
    let best = { size: 1, spread: Infinity };
    for (let start = 0; start < sorted.length; start += 1) {
      let end = start;
      while (end + 1 < sorted.length && sorted[end + 1].offsetMs - sorted[start].offsetMs <= threshold) end += 1;
      const size = end - start + 1;
      const spread = sorted[end].offsetMs - sorted[start].offsetMs;
      if (size > best.size || (size === best.size && spread < best.spread)) best = { size, spread };
    }
    return best;
  };
  const coherentEntries = (candidates) => {
    const threshold = clamp(Number(CONFIG.audioMatchConsensusOffsetMs), 50, 2000);
    const sorted = [...candidates].sort((left, right) => left.offsetMs - right.offsetMs);
    let best = [];
    let bestSpread = Infinity;
    let bestRank = Infinity;
    for (let start = 0; start < sorted.length; start += 1) {
      const byWindow = new Map();
      for (let end = start; end < sorted.length; end += 1) {
        if (sorted[end].offsetMs - sorted[start].offsetMs > threshold) break;
        const key = windowKeyFor(sorted[end]);
        const previous = byWindow.get(key);
        if (!previous || sorted[end].candidateIndex < previous.candidateIndex) byWindow.set(key, sorted[end]);
      }
      const cluster = [...byWindow.values()];
      const spread = cluster.length > 1
        ? Math.max(...cluster.map((entry) => entry.offsetMs)) - Math.min(...cluster.map((entry) => entry.offsetMs))
        : Infinity;
      const rank = cluster.reduce((total, entry) => total + (entry.candidateIndex || 0), 0);
      if (cluster.length > best.length
        || (cluster.length === best.length && spread < bestSpread)
        || (cluster.length === best.length && spread === bestSpread && rank < bestRank)) {
        best = cluster;
        bestSpread = spread;
        bestRank = rank;
      }
    }
    return best;
  };
  const groups = new Map();
  for (const entry of entries) {
    const windowKey = windowKeyFor(entry);
    for (const candidate of entry.candidates || [entry]) {
      const id = String(candidate.song?.id || "");
      if (!id) continue;
      const group = groups.get(id) || new Map();
      const previous = group.get(windowKey);
      if (!previous || candidate.candidateIndex < previous.candidateIndex) group.set(windowKey, candidate);
      groups.set(id, group);
    }
  }

  const rankedGroups = [...groups.entries()]
    .map(([id, windows]) => ({
      id,
      entries: [...windows.values()].sort((left, right) => left.effectiveSampleStartMs - right.effectiveSampleStartMs),
      titleConfirmed: titleIds.has(id),
      rankSum: [...windows.values()].reduce((total, entry) => total + (entry.candidateIndex || 0), 0),
    }))
    .map((group) => ({ ...group, coherence: coherentCluster(group.entries) }))
    .sort((left, right) => (
      right.coherence.size - left.coherence.size
      || right.entries.length - left.entries.length
      || Number(right.titleConfirmed) - Number(left.titleConfirmed)
      || left.rankSum - right.rankSum
      || Number(right.entries.some((entry) => entry.windowInfo?.fraction === 0.5))
        - Number(left.entries.some((entry) => entry.windowInfo?.fraction === 0.5))
    ));
  // The API can rank a near-match above the right recording. A repeated
  // song ID only wins when at least two windows also agree on its location.
  // Title confirmation is only a tie-breaker here: it must not override a
  // recording supported by more independent audio windows. Artist fields
  // are intentionally excluded because osu! metadata is often incomplete
  // or romanized.
  const repeated = rankedGroups.find((group) => group.coherence.size >= 2);
  if (repeated) return repeated.entries;

  // Some NetEase uploads are duplicate IDs for the same recording. When
  // their normalized titles agree, use a coherent position across distinct
  // windows as a lower-priority identity, but only for IDs returned by the
  // title search. This prevents an unrelated repeated title in the
  // fingerprint top-five from hijacking a song with a different name.
  const titleGroups = new Map();
  for (const entry of entries) {
    for (const candidate of entry.candidates || [entry]) {
      if (!titleIds.has(String(candidate.song?.id || ""))) continue;
      const name = normalizeForCompare(stripBracketedText(candidate.song?.name || ""));
      if (name.length < 6) continue;
      const list = titleGroups.get(name) || [];
      list.push(candidate);
      titleGroups.set(name, list);
    }
  }
  const titleFallback = [...titleGroups.entries()]
    .map(([name, candidates]) => ({ name, entries: coherentEntries(candidates) }))
    .filter((group) => group.entries.length >= 2)
    .sort((left, right) => (
      right.entries.length - left.entries.length
      || left.entries.reduce((total, entry) => total + (entry.candidateIndex || 0), 0)
        - right.entries.reduce((total, entry) => total + (entry.candidateIndex || 0), 0)
    ))[0];
  if (titleFallback) {
    return titleFallback.entries.map((entry) => ({
      ...entry,
      matchIdentity: `title:${titleFallback.name}`,
    }));
  }

  // With only one window, title confirmation can select a non-first
  // fingerprint candidate. Artist strings are deliberately not compared.
  const titleConfirmed = entries.map((entry) => (
    entry.candidates?.find((candidate) => titleIds.has(String(candidate.song?.id || ""))) || null
  )).filter(Boolean);
  return titleConfirmed.length ? titleConfirmed : entries;
}

function formatAudioMatchDebug(entries, decision) {
  const windows = entries
    .map((entry) => `${Math.round(entry.windowInfo.fraction * 100)}%:${entry.song.id}@${formatSignedMs(entry.offsetMs)}`)
    .join(", ");
  return `audio ${decision}; ${windows}`;
}

function audioMatchConfidence(match, entries) {
  // Presentation evidence only: acceptance thresholds stay in A/B. Both
  // methods report independent audio support out of the three standard
  // sample positions; title hits and repeated samples are not extra votes.
  const identity = match.matchIdentity || String(match.song?.id || "");
  const windows = new Set();
  for (const entry of entries) {
    if (!identity || (entry.matchIdentity || String(entry.song?.id || "")) !== identity) continue;
    const info = entry.windowInfo || {};
    const start = entry.effectiveSampleStartMs ?? (info.targetStartSeconds == null ? null : info.targetStartSeconds * 1000);
    const key = Number.isFinite(Number(start)) && start != null
      ? `start:${Math.round(Number(start))}`
      : info.fraction == null ? null : `position:${info.fraction}`;
    if (key != null) windows.add(key);
  }
  return `windows:${Math.min(3, windows.size)}/3`;
}

async function audioMatchWindowResult(audioBuffer, windowInfo, speed, signal) {
  let samples = audioMatchSamples(audioBuffer, windowInfo.actualStartSeconds, windowInfo.actualDurationSeconds);
  const sourceSampleRate = audioBuffer.sampleRate || 8000;
  const hasSpeedChange = Math.abs(speed - 1) >= 0.01;
  const attempts = hasSpeedChange
    ? [
      { label: "pitch-shift", samples: () => resampleSamples(stretchSamplesForSpeed(samples, speed), sourceSampleRate) },
      ...(CONFIG.audioMatchPitchPreserving
        ? [{ label: "preserve-pitch", samples: async () => resampleSamples(
          await stretchSamplesPreservePitch(samples, sourceSampleRate, speed, signal),
          sourceSampleRate,
        ) }]
        : []),
    ]
    : [{ label: "normal", samples: () => resampleSamples(samples, sourceSampleRate) }];
  let lastError = null;

  try {
    for (const attempt of attempts) {
      try {
        const windowNumber = windowInfo.fraction === 0.5 ? 1 : windowInfo.fraction === 0.25 ? 2 : 3;
        setStatus(`A ${windowNumber}/3: ${attempt.label} @ ${speed.toFixed(2)}x`);
        let matchedSamples = await attempt.samples();
        const matchDurationSeconds = clamp(matchedSamples.length / 8000, 3, 30);
        throwIfAudioMatchAborted(signal);
        const audioFP = await audioMatchTask(GenerateFP(matchedSamples), signal, 12000, "fingerprint");
        matchedSamples = null;
        throwIfAudioMatchAborted(signal);
        const data = await fetchJson("/audio/match", {
          duration: String(matchDurationSeconds),
          audioFP,
        }, { signal });
        throwIfAudioMatchAborted(signal);
        const candidates = audioMatchCandidates(data);
        if (!candidates.length) {
          throw new Error(`audio match no result${data?.data?.noMatchReason !== undefined ? ` (${data.data.noMatchReason})` : ""}`);
        }

        const base = {
          sampleStartMs: Math.round(windowInfo.actualStartSeconds * 1000),
          effectiveSampleStartMs: Math.round(windowInfo.targetStartSeconds * 1000),
          speed,
          mode: attempt.label,
          windowInfo,
        };
        // Keep a few candidates only for this live request. A title-confirmed
        // candidate can then replace an ambiguous top fingerprint result.
        const candidateEntries = candidates
          .slice(0, 5)
          .map((candidate, index) => audioMatchEntryFromCandidate(base, candidate, index))
          .filter(Boolean);
        const match = candidateEntries[0];
        if (!match) throw new Error("audio match candidates have invalid offsets");
        return {
          ...match,
          candidates: candidateEntries,
          candidateCount: candidates.length,
        };
      } catch (error) {
        if (String(error.message || "").includes("audio match aborted")) throw error;
        lastError = error;
      }
    }
  } finally {
    samples = null;
  }

  throw lastError || new Error("audio match failed");
}

function audioMatchConsensus(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const id = entry.matchIdentity || String(entry.song?.id || "");
    if (!id) continue;
    const list = groups.get(id) || [];
    list.push(entry);
    groups.set(id, list);
  }

  const threshold = clamp(Number(CONFIG.audioMatchConsensusOffsetMs), 50, 2000);
  const clusters = [];

  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => left.offsetMs - right.offsetMs);
    // Three successful windows provide enough evidence to reject a pair
    // that only agrees because both landed on a repeated chorus. If one
    // window failed, two agreeing windows remain a valid fixed mapping.
    const requiredSize = sorted.length >= 3 ? 3 : 2;
    for (let start = 0; start < sorted.length; start += 1) {
      const cluster = [sorted[start]];
      for (let end = start + 1; end < sorted.length; end += 1) {
        // Require every accepted anchor to stay within one consensus band.
        // This prevents a repeated chorus with a bad location from pulling
        // a correct pair toward an unrelated offset.
        if (sorted[end].offsetMs - sorted[start].offsetMs > threshold) break;
        cluster.push(sorted[end]);
      }
      if (cluster.length >= requiredSize) clusters.push(cluster);
    }
  }

  const consensus = clusters.sort((left, right) => {
    const leftMiddle = left.some((entry) => entry.windowInfo.fraction === 0.5) ? 1 : 0;
    const rightMiddle = right.some((entry) => entry.windowInfo.fraction === 0.5) ? 1 : 0;
    const leftSpread = Math.max(...left.map((entry) => entry.offsetMs)) - Math.min(...left.map((entry) => entry.offsetMs));
    const rightSpread = Math.max(...right.map((entry) => entry.offsetMs)) - Math.min(...right.map((entry) => entry.offsetMs));
    return right.length - left.length
      || rightMiddle - leftMiddle
      || leftSpread - rightSpread;
  })[0];
  if (!consensus) return null;

  const offsets = consensus.map((entry) => entry.offsetMs).sort((left, right) => left - right);
  const medianOffset = offsets[Math.floor(offsets.length / 2)];
  const preferred = consensus.find((entry) => entry.windowInfo.fraction === 0.5) || consensus[0];
  const spread = offsets[offsets.length - 1] - offsets[0];
  return {
    ...preferred,
    offsetMs: Math.round(medianOffset),
    decision: `multi-window consensus ${consensus.length}x, spread ${Math.round(spread)}ms`,
  };
}

function audioMatchFixedOffset(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const id = entry.matchIdentity || String(entry.song?.id || "");
    if (!id) continue;
    const list = groups.get(id) || [];
    list.push(entry);
    groups.set(id, list);
  }

  const group = [...groups.values()]
    .filter((items) => items.length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  if (!group) return null;

  const offsets = group.map((entry) => entry.offsetMs).sort((left, right) => left - right);
  const spread = offsets[offsets.length - 1] - offsets[0];
  // A fixed mapping should produce almost the same offset in every window.
  // The old 8-second allowance accepted repeated choruses as a valid
  // location and was the main source of multi-second errors.
  const consensusThreshold = clamp(Number(CONFIG.audioMatchConsensusOffsetMs), 50, 2000);
  const maxFixedOffsetSpreadMs = Math.max(500, consensusThreshold * 3);
  if (spread > maxFixedOffsetSpreadMs) return null;

  const offsetMs = Math.round(offsets[Math.floor(offsets.length / 2)]);
  const preferred = [...group].sort((left, right) => (
    Math.abs(left.offsetMs - offsetMs) - Math.abs(right.offsetMs - offsetMs)
    || Number(right.windowInfo.fraction === 0.5) - Number(left.windowInfo.fraction === 0.5)
  ))[0];
  return {
    ...preferred,
    offsetMs,
    decision: `multi-window fixed offset ${group.length}x, spread ${Math.round(spread)}ms`,
  };
}

function audioMatchSegmentedAlignment(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const id = entry.matchIdentity || String(entry.song?.id || "");
    if (!id) continue;
    const list = groups.get(id) || [];
    list.push(entry);
    groups.set(id, list);
  }

  const threshold = clamp(Number(CONFIG.audioMatchConsensusOffsetMs), 50, 2000);
  const group = [...groups.values()]
    .filter((items) => items.length >= 3)
    .sort((left, right) => right.length - left.length)[0];
  if (!group) return null;

  const sorted = [...group]
    .sort((left, right) => left.effectiveSampleStartMs - right.effectiveSampleStartMs);
  const meanTime = sorted.reduce((total, entry) => total + entry.effectiveSampleStartMs, 0) / sorted.length;
  const meanOffset = sorted.reduce((total, entry) => total + entry.offsetMs, 0) / sorted.length;
  const denominator = sorted.reduce((total, entry) => (
    total + (entry.effectiveSampleStartMs - meanTime) ** 2
  ), 0);
  if (!denominator) return null;
  const slope = sorted.reduce((total, entry) => (
    total + (entry.effectiveSampleStartMs - meanTime) * (entry.offsetMs - meanOffset)
  ), 0) / denominator;
  const intercept = meanOffset - slope * meanTime;
  const totalVariance = sorted.reduce((total, entry) => total + (entry.offsetMs - meanOffset) ** 2, 0);
  const residualVariance = sorted.reduce((total, entry) => {
    const predicted = intercept + slope * entry.effectiveSampleStartMs;
    return total + (entry.offsetMs - predicted) ** 2;
  }, 0);
  const rSquared = totalVariance > 0 ? 1 - residualVariance / totalVariance : 0;
  const spread = Math.max(...sorted.map((entry) => entry.offsetMs)) - Math.min(...sorted.map((entry) => entry.offsetMs));
  // Segmented correction is only for a small, sustained rate mismatch.
  // Large linear changes are more likely to be repeated sections matched
  // at different source positions than real drift. The normal path should
  // correct the start point and leave the rest of the song on one timeline.
  if (spread <= Math.max(1000, threshold * 4) || Math.abs(slope) > 0.03 || rSquared < 0.85) return null;

  const anchors = sorted
    .map((entry) => ({
      sampleTimeMs: entry.effectiveSampleStartMs,
      offsetMs: entry.offsetMs,
      windowDurationMs: Math.round(entry.windowInfo.targetDurationSeconds * 1000),
    }));
  const preferred = group.find((entry) => entry.windowInfo.fraction === 0.5) || group[0];
  return {
    ...preferred,
    alignmentMode: "segmented",
    alignmentAnchors: anchors,
    decision: `multi-window segmented alignment ${anchors.length}x, spread ${Math.round(spread)}ms`,
  };
}

async function audioMatchCurrentBeatmap(beatmap = {}, searchMeta = {}, options = {}) {
  if (!CONFIG.audioMatchEnabled) return null;
  if (typeof GenerateFP !== "function") throw new Error("audio fingerprint runtime unavailable");

  const requestedStartSeconds = parseNumber(CONFIG.audioMatchStartSeconds, -1);
  const requestedDurationSeconds = clamp(parseNumber(CONFIG.audioMatchDurationSeconds, 15), 3, 30);
  const speed = audioMatchSpeed(beatmap, options.difficultySpeedMultiplier);
  const useMultiWindow = CONFIG.audioMatchMultiWindowEnabled && requestedStartSeconds < 0;
  const alwaysUseAllWindows = useMultiWindow && CONFIG.audioMatchAlwaysUseAllWindows;
  const titleCandidatesPromise = useMultiWindow
    ? Promise.resolve(options.titleCandidates || searchNeteaseSongs(searchMeta.title || "", searchMeta.artist || "", beatmap).catch(() => []))
    : Promise.resolve([]);

  abortAudioMatchWork();
  const controller = new AbortController();
  audioMatchAbortController = controller;
  const signal = controller.signal;
  const parent = lyricRequestController?.signal;
  const cancel = () => controller.abort();
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  let buffer = null;
  let audioBuffer = null;
  try {
    buffer = await currentBeatmapAudioBuffer(signal);
    throwIfAudioMatchAborted(signal);
    // Analysis must not inherit a high device rate (for example 192kHz).
    // Keep enough bandwidth for both speed modes before the final 8kHz fingerprint.
    // Extreme time stretching changes WSOLA overlap choices enough to affect
    // fingerprint recall. Keep a bounded 48kHz analysis rate from 2x onward.
    const analysisSampleRate = Math.abs(speed - 1) >= 0.01 && CONFIG.audioMatchPitchPreserving
      ? (speed >= 2 ? 48000 : 44100) : 8000;
    audioBuffer = await audioMatchTask(decodeAudioBuffer(buffer, analysisSampleRate, signal), signal, 15000, "source decode");
    buffer = null;
    throwIfAudioMatchAborted(signal);

    const middleWindow = audioMatchWindow(audioBuffer, requestedStartSeconds, requestedDurationSeconds, speed);
    middleWindow.fraction = 0.5;
    setStatus(`audio match: sampling ${middleWindow.actualStartSeconds.toFixed(2)}s + ${middleWindow.actualDurationSeconds.toFixed(2)}s @ ${speed.toFixed(2)}x`);

    const results = [];
    let firstError = null;
    try {
      results.push(await audioMatchWindowResult(audioBuffer, middleWindow, speed, signal));
    } catch (error) {
      if (String(error.message || "").includes("audio match aborted")) throw error;
      firstError = error;
    }

    if (!useMultiWindow) {
      if (!results.length) throw firstError || new Error("audio match failed");
      return { ...results[0], decision: "single-window", debugWindows: results, confidence: audioMatchConfidence(results[0], results) };
    }

    // In full-window mode the outer windows are mandatory, so a slow
    // title search need not stall their processing. The early-confirmed
    // single-window path retains its original wait and decision rules.
    let titleCandidates = alwaysUseAllWindows ? null : await titleCandidatesPromise;
    throwIfAudioMatchAborted(signal);
    let titleIds = titleCandidates ? new Set(titleCandidates.slice(0, 3).map((song) => String(song.id))) : null;
    let selectedResults = titleIds ? selectAudioMatchEntries(results, titleIds) : [];
    const middle = selectedResults[0];
    if (middle && titleIds.has(String(middle.song.id)) && !alwaysUseAllWindows) {
      return {
        ...middle,
        decision: "50% confirmed by title top-3",
        titleCandidateCount: titleCandidates.length,
        debugWindows: selectedResults,
        confidence: audioMatchConfidence(middle, selectedResults),
      };
    }

    const outerResults = await Promise.allSettled([0.25, 0.75].map(async fraction => {
        const windowInfo = audioMatchWindowAtFraction(audioBuffer, fraction, middleWindow.targetDurationSeconds, speed);
        return audioMatchWindowResult(audioBuffer, windowInfo, speed, signal);
    }));
    for (const entry of outerResults) {
      if (entry.status === "fulfilled") results.push(entry.value);
      else if (String(entry.reason?.message).includes("audio match aborted")) throw entry.reason;
    }

    if (alwaysUseAllWindows) {
      titleCandidates = await titleCandidatesPromise;
      throwIfAudioMatchAborted(signal);
      titleIds = new Set(titleCandidates.slice(0, 3).map((song) => String(song.id)));
    }
    selectedResults = selectAudioMatchEntries(results, titleIds);
    const consensus = audioMatchConsensus(selectedResults);
    if (consensus) {
      return {
        ...consensus,
        decision: consensus.decision,
        titleCandidateCount: titleCandidates.length,
        debugWindows: selectedResults,
        confidence: audioMatchConfidence(consensus, selectedResults),
      };
    }

    const fixedOffset = audioMatchFixedOffset(selectedResults);
    if (fixedOffset) {
      return {
        ...fixedOffset,
        decision: fixedOffset.decision,
        titleCandidateCount: titleCandidates.length,
        debugWindows: selectedResults,
        confidence: audioMatchConfidence(fixedOffset, selectedResults),
      };
    }

    const segmented = audioMatchSegmentedAlignment(selectedResults);
    if (segmented) {
      return {
        ...segmented,
        decision: segmented.decision,
        titleCandidateCount: titleCandidates.length,
        debugWindows: selectedResults,
        confidence: audioMatchConfidence(segmented, selectedResults),
      };
    }

    const titleConfirmed = selectedResults.find((entry) => titleIds.has(String(entry.song?.id || "")));
    // Once multiple windows disagree on the location, returning the first
    // title-confirmed hit would reintroduce the exact multi-second jump
    // this pass is meant to remove. Let metadata fallback choose the song
    // without trusting an unverified audio position.
    if (titleConfirmed && selectedResults.length <= 1) {
      return {
        ...titleConfirmed,
        decision: "single title-confirmed window",
        titleCandidateCount: titleCandidates.length,
        debugWindows: selectedResults,
        confidence: audioMatchConfidence(titleConfirmed, selectedResults),
      };
    }
    const error = firstError || new Error("audio match has no consistent song and location");
    error.audioMatchInconclusive = results.length > 0;
    error.audioMatchWindows = results;
    throw error;
  } finally {
    buffer = null;
    audioBuffer = null;
    parent?.removeEventListener("abort", cancel);
    if (audioMatchAbortController === controller) audioMatchAbortController = null;
  }
}
