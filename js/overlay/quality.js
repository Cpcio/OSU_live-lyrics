// Bounded cross-provider lyric quality refinement. Recording evidence stays
// authoritative; translations never justify changing to an unrelated song.
function lyricIdentityText(text) {
  return String(text || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function lyricContentLines(result) {
  const title = lyricIdentityText(result?.neteaseSongTitle || "");
  const meaningful = (fragment, time) => {
    const text = safeText(fragment);
    if (!lyricIdentityText(text)) return false;
    if (/^(?:暂无(?:歌词|翻译)|暂时没有歌词|没有歌词|无歌词|no\s*(?:synced\s*)?lyrics(?:\s*available)?|lyrics\s*(?:not\s*)?available)$/i.test(text)) return false;
    if (/^(?:纯音乐(?:请欣赏)?|(?:此|本)(?:歌曲|曲)为(?:没有填词的)?纯音乐(?:请(?:您)?欣赏)?|instrumental)$/i.test(normalizeForCompare(text))) return false;
    if (/^(?:词|曲|作词|作曲|编曲|原唱|制作人|制作|监制|录音|混音|母带|lyrics(?:\s+by)?|composer|arranger)\s*[:：]/i.test(text)) return false;
    if (/^(?:QQ音乐享有.*著作权|本歌词由|歌词贡献者|版权所有|copyright\b)/i.test(text)) return false;
    // QQ supplies a timed title/artist credit before the actual vocals.
    if (title && time < 3000 && /\s[-–—]\s/u.test(text) && lyricIdentityText(text).startsWith(title)) return false;
    return true;
  };
  return (result?.lines || []).flatMap(line => {
    if (!Number.isFinite(Number(line.time))) return [];
    // Simultaneous LRC credits and the first vocal can share a single
    // coalesced row. Ignore only credit fragments, never the real vocal.
    const fragments = String(line.text || "").split(/\r?\n/), content = fragments.filter(text => meaningful(text, Number(line.time)));
    return content.length ? [content.length === fragments.length ? line : { ...line, text: content.join("\n") }] : [];
  });
}

function lyricResultQuality(result) {
  const lines = lyricContentLines(result);
  const meaningful = text => Boolean(lyricIdentityText(text))
    && !/^(?:暂无(?:歌词|翻译)|暂时没有歌词|no\s*(?:synced\s*)?lyrics|lyrics\s*(?:not\s*)?available|\/{2,})$/i.test(safeText(text));
  const source = lines.filter(line => meaningful(line.text) && Number.isFinite(Number(line.time)));
  const hasKana = source.some(line => /[\u3040-\u30ff\uff66-\uff9f]/u.test(line.text));
  const usefulTranslation = (line, text) => meaningful(text) && /[\u3400-\u9fff]/u.test(text)
    && (hasKana || !/[\u3400-\u9fff]/u.test(line.text)) && lyricIdentityText(text) !== lyricIdentityText(line.text);
  const translated = source.filter(line => (line.translationSegments || []).some(segment => usefulTranslation(line, segment.text))
    || usefulTranslation(line, line.translationText));
  const displayLength = text => Array.from(String(text || "").normalize("NFKC")).reduce((total, character) => total
    + (/\s/u.test(character) ? 0.35 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(character) ? 1 : 0.6), 0);
  const widths = source.map(line => {
    const translations = [...(line.translationSegments || []).map(segment => segment.text), line.translationText || ""]
      .filter(text => usefulTranslation(line, text));
    return Math.max(displayLength(line.text), ...translations.map(text => displayLength(text) * 0.6));
  }).sort((left, right) => left - right);
  return { available: source.length > 0, instrumental: Boolean(result?.instrumental),
    translated: translated.length, coverage: translated.length / Math.max(1, source.length), count: source.length,
    lineLength90: widths[Math.max(0, Math.ceil(widths.length * 0.9) - 1)] || 0,
    averageLineLength: widths.reduce((sum, width) => sum + width, 0) / Math.max(1, widths.length),
    chineseOriginal: source.length > 0 && !hasKana && source.every(line => /[\u3400-\u9fff]/u.test(line.text)) };
}

function lyricContentTimeline(lines) {
  let text = "";
  const starts = [], clocks = new Map();
  for (const line of lines) {
    const normalized = lyricIdentityText(line.text), position = text.length;
    starts.push({ position, time: Number(line.time), text: normalized }); clocks.set(position, Number(line.time));
    if (Array.isArray(line.words) && lyricIdentityText(line.words.map(word => word.text).join("")) === normalized) {
      let wordPosition = position;
      for (const word of line.words) {
        const part = lyricIdentityText(word.text);
        if (part && Number.isFinite(Number(word.time))) clocks.set(wordPosition, Number(word.time));
        wordPosition += part.length;
      }
    }
    text += normalized;
  }
  return { text, starts, clocks };
}

function alignLyricContent(reference, candidate) {
  // Global, monotonic text alignment handles a provider splitting one verse
  // into two. Keep at least 95% content identity; do not jump to a later
  // chorus when a spelling differs. Only a narrow diagonal band is stored.
  const n = reference.length, m = candidate.length, distance = Math.floor(Math.max(n, m) * 0.05);
  const band = distance * 2 + 1;
  if (!n || !m || Math.abs(n - m) > distance || (n + 1) * band > 1000000) return null;
  if (reference === candidate) return { positions: Int32Array.from({ length: m }, (_, index) => index), matched: m };
  const cap = distance + 1, trace = new Uint8Array((n + 1) * band);
  let previous = new Int32Array(m + 1), current = new Int32Array(m + 1);
  previous.fill(cap);
  for (let j = 0; j <= Math.min(m, distance); j++) previous[j] = j;
  for (let i = 1; i <= n; i++) {
    current.fill(cap); if (i <= distance) current[0] = i;
    let minimum = current[0];
    for (let j = Math.max(1, i - distance); j <= Math.min(m, i + distance); j++) {
      let best = previous[j - 1] + Number(reference[i - 1] !== candidate[j - 1]), direction = 1;
      if (previous[j] + 1 < best) { best = previous[j] + 1; direction = 2; }
      if (current[j - 1] + 1 < best) { best = current[j - 1] + 1; direction = 3; }
      current[j] = best; minimum = Math.min(minimum, best); trace[i * band + j - i + distance] = direction;
    }
    if (minimum > distance) return null;
    [previous, current] = [current, previous];
  }
  if (previous[m] > distance) return null;
  const positions = new Int32Array(m); positions.fill(-1);
  let i = n, j = m, matched = 0;
  while (i > 0 && j > 0) {
    const direction = trace[i * band + j - i + distance];
    if (direction === 1) {
      if (reference[i - 1] === candidate[j - 1]) { positions[j - 1] = i - 1; matched++; }
      i--; j--;
    } else if (direction === 2) i--;
    else if (direction === 3) j--;
    else return null;
  }
  return matched / Math.max(n, m) >= 0.95 ? { positions, matched } : null;
}

function lyricTimelineBridge(reference, candidate) {
  const originals = lyricContentLines(reference), alternatives = lyricContentLines(candidate);
  if (!originals.length || !alternatives.length) return null;
  const byText = new Map();
  originals.forEach((line, index) => {
    const text = lyricIdentityText(line.text);
    if (text.length < 4) return;
    const entries = byText.get(text) || []; entries.push({ line, index }); byText.set(text, entries);
  });
  const pairs = []; let previous = -1;
  for (const line of alternatives) {
    const match = (byText.get(lyricIdentityText(line.text)) || []).find(entry => entry.index > previous);
    if (!match || !Number.isFinite(line.time) || !Number.isFinite(match.line.time)) continue;
    pairs.push({ delta: match.line.time - line.time, text: lyricIdentityText(line.text) }); previous = match.index;
  }
  const required = Math.min(3, Math.min(originals.length, alternatives.length));
  const fixedShift = matches => {
    if (matches.length < 2 || new Set(matches.map(pair => pair.text)).size < 2) return null;
    const deltas = matches.map(pair => pair.delta).sort((a, b) => a - b), shift = deltas[Math.floor(deltas.length / 2)];
    return deltas.filter(delta => Math.abs(delta - shift) <= 450).length / deltas.length >= 0.9 ? shift : null;
  };
  const exactShift = required >= 2 && pairs.length >= required
    && pairs.length / Math.min(originals.length, alternatives.length) >= 0.6 ? fixedShift(pairs) : null;
  const first = lyricContentTimeline(originals), second = lyricContentTimeline(alternatives);
  if (exactShift != null && first.text === second.text && pairs.length === originals.length && pairs.length === alternatives.length) {
    return { shift: exactShift, matched: pairs.length, complete: true };
  }
  const content = alignLyricContent(first.text, second.text);
  if (content) {
    const anchors = [];
    for (const start of second.starts) {
      const position = content.positions[start.position];
      if (position < 0 || !first.clocks.has(position)) continue;
      // A boundary must begin with consecutive identical characters, not
      // land inside a substitution/deletion with an estimated word clock.
      const prefix = Math.min(3, start.text.length);
      if (!prefix || Array.from({ length: prefix }, (_, k) => content.positions[start.position + k]).some((p, k) => p !== position + k)) continue;
      anchors.push({ delta: first.clocks.get(position) - start.time, text: start.text, position });
    }
    const shift = fixedShift(anchors);
    if (anchors.length >= 3 && (anchors.at(-1).position - anchors[0].position) / Math.max(1, first.text.length) >= 0.6) {
      return shift == null ? null : { shift, matched: anchors.length, complete: true };
    }
  }
  // Preserve existing exact-sentence proof for partial copies; it cannot
  // justify shortening via a substantially incomplete lyric stream.
  return exactShift == null ? null : { shift: exactShift, matched: pairs.length, complete: false };
}

function mapLyricResultToClock(candidate, reference, bridge) {
  const move = line => ({ ...line, time: Number(line.time) + bridge.shift,
    ...(Array.isArray(line.words) ? { words: line.words.map(word => ({ ...word, time: Number(word.time) + bridge.shift })) } : {}),
    ...(Array.isArray(line.translationSegments) ? { translationSegments: line.translationSegments.map(segment => ({ ...segment,
      time: Number(segment.time) + bridge.shift, ...(Number.isFinite(segment.sourceTime) ? { sourceTime: segment.sourceTime + bridge.shift } : {}) })) } : {}) });
  const result = { ...candidate, lines: (candidate.lines || []).map(move), translations: (candidate.translations || []).map(move),
    mvNeteaseSongId: reference.mvNeteaseSongId || reference.neteaseSongId || candidate.mvNeteaseSongId || candidate.neteaseSongId || "",
    mvQqSongId: reference.mvQqSongId || (reference.provider === "qq" ? reference.providerSongId : "")
      || candidate.mvQqSongId || (candidate.provider === "qq" ? candidate.providerSongId : "") || "",
    mvSongMeta: reference.mvSongMeta || (reference.neteaseSongId ? {
      title: reference.neteaseSongTitle, artist: reference.neteaseSongArtist, durationMs: reference.neteaseDurationMs } : candidate.mvSongMeta),
  };
  for (const key of ["lyricOffsetMs", "speedMultiplier", "neteaseBpm", "audioMatchSource", "audioMatchSpeed", "audioMatchStartTimeMs",
    "audioMatchSampleStartMs", "audioMatchEffectiveSampleStartMs", "audioMatchAlignmentMode", "audioMatchAlignmentAnchors",
    "audioMatchConfidence", "audioMatchDebug", "autoOffsetMs", "autoOffsetSource", "sameSongSetReuse"]) {
    if (key in reference) result[key] = reference[key]; else delete result[key];
  }
  delete result.audioMatchBackgroundContext;
  return result;
}

function preferLyricQuality(reference, candidate) {
  if (!candidate) return reference;
  if (!reference) return candidate;
  const first = lyricResultQuality(reference), second = lyricResultQuality(candidate);
  // A confirmed instrumental recording must not become a vocal version just
  // because that version has more text in the catalogue.
  if (first.instrumental && reference.audioMatchSource) return reference;
  if (!second.available) return reference;
  if (!first.available) return retainNeteaseMv(candidate, reference);
  const bridge = lyricTimelineBridge(reference, candidate);
  if (!bridge) return reference;
  const preferred = CONFIG.lyricSourcePriority === "qq-first" ? "qq" : "netease";
  const provider = result => result.provider || "netease";
  let better = false;
  if ((second.translated > 0) !== (first.translated > 0)) better = second.translated > 0;
  else if (second.translated && Math.abs(second.coverage - first.coverage) >= 0.01) better = second.coverage > first.coverage;
  else {
    const clearlyShorter = (a, b) => a.lineLength90 <= b.lineLength90 * 0.9
      || (Math.abs(a.lineLength90 - b.lineLength90) < 1 && a.averageLineLength <= b.averageLineLength * 0.9);
    if (second.translated && bridge.complete && (clearlyShorter(second, first) || clearlyShorter(first, second))) better = clearlyShorter(second, first);
    else better = provider(candidate) === preferred && provider(reference) !== preferred;
  }
  return better ? mapLyricResultToClock(candidate, reference, bridge) : reference;
}

function resultMvIdentity(result) {
  const id = result?.mvNeteaseSongId || ((result?.provider || "netease") === "netease" ? result?.neteaseSongId : "") || "";
  return { id, meta: { ...(result?.mvSongMeta || { title: result?.neteaseSongTitle || "", artist: result?.neteaseSongArtist || "",
    durationMs: parseNumber(result?.neteaseDurationMs, 0) }),
    qqSongId: result?.mvQqSongId || (result?.provider === "qq" ? result?.providerSongId : "") || "" } };
}

function retainNeteaseMv(result, netease) {
  if (!netease?.neteaseSongId) return result;
  return { ...result, mvNeteaseSongId: netease.neteaseSongId, mvSongMeta: {
    title: netease.neteaseSongTitle, artist: netease.neteaseSongArtist, durationMs: netease.neteaseDurationMs } };
}

async function findLyricQualityAlternative(reference, context, signal) {
  const provider = (reference.provider || "netease") === "netease" ? "qq" : "netease";
  const title = reference.neteaseSongTitle || context.title;
  const artist = reference.neteaseSongArtist || context.artist;
  const options = { signal };
  const songs = provider === "qq" ? await searchQqSongs(title, artist, context.beatmap, options)
    : await searchNeteaseSongs(title, artist, context.beatmap, options);
  let best = reference;
  for (const song of songs.slice(0, 3)) {
    if (signal.aborted) throw new Error("audio match aborted");
    try {
      let candidate = provider === "qq" ? await loadQqLyricsBySong(song, options)
        : await loadLyricsBySongId(song.id, `NetEase: ${song.name}`, 0, 1, options);
      candidate = { ...candidate, neteaseSongTitle: song.name,
        neteaseSongArtist: (song.artists || song.ar || []).map(item => item.name).join("/"),
        neteaseDurationMs: parseNumber(song.dt || song.durationMs, 0), providerSong: song };
      candidate = restoreCandidateLyricRoles(candidate, reference.lines, reference.translations);
      if (!candidate) continue;
      const selected = preferLyricQuality(best, candidate);
      // A NetEase match remains useful for its MV even when QQ lyrics win.
      best = provider === "netease" && lyricTimelineBridge(reference, candidate)
        ? retainNeteaseMv(selected, candidate) : selected;
      if (provider === "qq" && lyricTimelineBridge(reference, candidate)) best = { ...best, mvQqSongId: candidate.providerSongId };
    } catch (error) { if (signal.aborted) throw error; }
  }
  return best;
}

function commitLyricQualityResult(result, context, trackKey) {
  currentLyricResult = result;
  currentProvider = result.provider || "netease";
  currentProviderSongId = String(result.providerSongId || result.neteaseSongId || "");
  currentNeteaseSongId = String(result.neteaseSongId || "");
  currentNeteaseSongMeta = { title: result.neteaseSongTitle || context.title, artist: result.neteaseSongArtist || context.artist,
    durationMs: parseNumber(result.neteaseDurationMs, 0) };
  lyricLines = result.lines || []; translatedLines = result.translations || [];
  currentTrackOffsetMs = parseNumber(result.lyricOffsetMs, 0);
  currentAutoOffsetSource = result.autoOffsetSource || "";
  currentAudioMatchConfidence = result.audioMatchConfidence || null;
  currentTrackAlignmentAnchors = !result.sameSongSetReuse && Array.isArray(result.audioMatchAlignmentAnchors)
    ? result.audioMatchAlignmentAnchors.filter(anchor => Number.isFinite(Number(anchor?.sampleTimeMs))
      && Number.isFinite(Number(anchor?.offsetMs))) : [];
  const matchedSpeed = Number(result.audioMatchSpeed);
  const useMatchedSpeed = result.audioMatchSource && Number.isFinite(matchedSpeed) && matchedSpeed > 0 && !result.sameSongSetReuse;
  currentSpeedMultiplier = resolvedLyricSpeed(context.beatmap, { neteaseBpm: result.neteaseBpm,
    audioMatchSpeed: useMatchedSpeed ? matchedSpeed : null, storedSpeedMultiplier: useMatchedSpeed ? 1 : result.speedMultiplier });
  loadedLyricsTrackKey = trackKey; lastRenderedLyricIndex = -2;
  if (currentAudioMatchState !== "refining") setAudioMatchState(result.audioMatchSource ? "success" : (CONFIG.audioMatchEnabled ? "fallback" : "disabled"));
  else updateAudioMatchBadge();
  updateOffsetBadge(); renderLyrics(latestLiveTimeMs(), true);
  const mv = resultMvIdentity(result); void updateMvBackground(mv.id, mv.meta, trackKey);
  setStatus(`lyrics quality: ${result.source || currentProvider}${lyricResultQuality(result).translated ? "; translation available" : ""}`);
}

async function refineLyricSourceQuality(context, token, trackKey) {
  if (!["netease-first", "qq-first"].includes(CONFIG.lyricSourcePriority) || !currentLyricResult) return;
  const reference = currentLyricResult;
  const quality = lyricResultQuality(reference);
  const preferred = CONFIG.lyricSourcePriority === "qq-first" ? "qq" : "netease";
  if (quality.instrumental && reference.audioMatchSource) return;
  // A Chinese original needs no translation upgrade, but an enabled MV can
  // still use a QQ identity verified by this same bounded background check.
  const needsQqMv = CONFIG.mvBackgroundEnabled && CONFIG.lyricLayout !== "subtitle"
    && (reference.provider || "netease") === "netease" && !reference.mvQqSongId;
  if (quality.chineseOriginal && (reference.provider || "netease") === preferred && !needsQqMv) return;
  lyricQualityAbortController?.abort();
  const controller = new AbortController(); lyricQualityAbortController = controller;
  const deadline = setTimeout(() => controller.abort(), 30000);
  const isCurrent = () => !controller.signal.aborted && token === lyricLoadToken && currentTrackKey === trackKey
    && trackInfoFromPayload(latestTrackPayload || {}).key === trackKey;
  try {
    const candidate = await findLyricQualityAlternative(reference, context, controller.signal);
    if (!isCurrent()) return;
    // B may have changed both the recording and its clock while the query
    // was in flight. Compare with the current commit, never the old snapshot.
    const selected = preferLyricQuality(currentLyricResult, candidate);
    const mv = resultMvIdentity(candidate);
    const sameRecording = currentLyricResult === reference || Boolean(lyricTimelineBridge(currentLyricResult, candidate));
    if (sameRecording && (mv.id || mv.meta.qqSongId)) void updateMvBackground(mv.id, mv.meta, trackKey);
    if (selected !== currentLyricResult) commitLyricQualityResult(selected, context, trackKey);
  } catch {
    // The foreground stays usable during optional catalogue outages.
  } finally {
    clearTimeout(deadline);
    if (lyricQualityAbortController === controller) lyricQualityAbortController = null;
  }
}
