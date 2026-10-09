// LRC/YRC normalization, translation association and the source-time model.

function resolvedLyricSpeed(beatmap = {}, options = {}) {
  const manualSpeed = clamp(parseNumber(CONFIG.speedMultiplier, 1), 0.5, 2.5);
  const explicitSpeed = CONFIG.autoSpeedFromDifficulty ? explicitDifficultySpeed(beatmap.version) : null;
  const bpmSpeed = CONFIG.autoSpeedFromDifficulty
    ? bpmDifficultyMultiplier(beatmap, options.neteaseBpm)
    : 1;
  const overrideSpeed = Number(options.difficultySpeedOverride);
  const matchedSpeed = Number(options.audioMatchSpeed);
  const storedSpeed = clamp(parseNumber(options.storedSpeedMultiplier, 1), 0.5, 2.5);

  // Audio matching has already applied the manual rate, so reuse its exact
  // scale for lyric rendering. With automatic speed disabled, preserve the
  // existing manual-only behavior for metadata and cached lyric paths.
  if (Number.isFinite(matchedSpeed) && matchedSpeed > 0) {
    return clamp(matchedSpeed, 0.5, 2.5);
  }
  if (!CONFIG.autoSpeedFromDifficulty) return manualSpeed;

  // A named rate and a BPM tag normally describe the same edit. Prefer the
  // explicit name, then use the BPM-derived value only when it is the sole
  // evidence.
  const automaticSpeed = explicitSpeed !== null
    ? explicitSpeed
    : (Number.isFinite(overrideSpeed) && overrideSpeed > 0 ? overrideSpeed : bpmSpeed);
  return clamp(automaticSpeed * manualSpeed * storedSpeed, 0.5, 2.5);
}

async function firstObjectTimeForAlignment(beatmap = {}, payload = {}) {
  const fromTosu = window.LyricAlignment?.firstObjectTimeFromBeatmap?.(beatmap, payload);
  if (fromTosu !== null && fromTosu !== undefined) return fromTosu;

  for (const candidate of beatmapFileCandidates(beatmap, payload)) {
    try {
      const osuText = await fetchText(candidate);
      const fromFile = window.LyricAlignment?.firstObjectTimeFromOsu?.(osuText);
      if (fromFile !== null && fromFile !== undefined) return fromFile;
    } catch {
      // Try another possible beatmap file endpoint/path.
    }
  }

  return null;
}

function parseLrc(lrc) {
  const lines = [];
  const source = String(lrc || "");
  const offsetMatch = source.match(/^\s*\[offset\s*:\s*([+-]?\d+)\s*]/im);
  const timestampOffsetMs = Number(offsetMatch?.[1] || 0);

  for (const rawLine of source.split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?]/g)];
    if (!tags.length) continue;

    const text = rawLine.replace(/(?:\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?])+/g, "").trim();
    if (!text) continue;

    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      const fraction = tag[3] || "0";
      const millis = Number(fraction.padEnd(3, "0").slice(0, 3));

      lines.push({
        time: Math.max(0, minutes * 60000 + seconds * 1000 + millis + timestampOffsetMs),
        text,
      });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

function parseYrc(yrc) {
  const lines = [];

  for (const rawLine of String(yrc || "").split(/\r?\n/)) {
    const lineTag = rawLine.match(/\[(\d+),(\d+)]/);
    if (!lineTag) continue;

    const text = rawLine
      .replace(/\[\d+,\d+]/g, "")
      .replace(/\(\d+,\d+(?:,\d+)?\)/g, "")
      .trim();
    if (!text) continue;

    const words = [];
    const wordMatcher = /\((\d+),(\d+)(?:,\d+)?\)([^()]*)/g;
    for (const match of rawLine.matchAll(wordMatcher)) {
      const wordText = match[3];
      if (!wordText) continue;
      words.push({
        time: Number(match[1]),
        duration: Number(match[2]),
        text: wordText,
      });
    }

    lines.push({
      time: Number(lineTag[1]),
      duration: Number(lineTag[2]),
      text,
      words,
    });
  }

  return lines.sort((a, b) => a.time - b.time);
}

function coalesceSimultaneousLyricLines(lines = []) {
  const output = [];
  for (const line of [...lines].sort((left, right) => left.time - right.time)) {
    const previous = output[output.length - 1];
    if (!previous || Math.abs(Number(previous.time) - Number(line.time)) > 20) {
      output.push({ ...line });
      continue;
    }

    const previousText = safeText(previous.text);
    const currentText = safeText(line.text);
    const sameText = normalizeForCompare(previousText) === normalizeForCompare(currentText);
    if (!sameText && currentText) previous.text = `${previousText}\n${currentText}`;
    if (Array.isArray(line.words) && line.words.length) {
      previous.words = [...(previous.words || []), ...line.words];
    }
    previous.duration = Math.max(Number(previous.duration) || 0, Number(line.duration) || 0);
  }
  return output;
}

function mergeTranslationLines(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const line of group || []) {
      const time = Number(line?.time);
      const text = safeText(line?.text);
      if (!Number.isFinite(time) || !text) continue;
      const key = `${Math.round(time)}|${normalizeForCompare(text)}`;
      if (!byKey.has(key)) byKey.set(key, { ...line, time, text });
    }
  }
  return coalesceSimultaneousLyricLines([...byKey.values()]);
}

function associateTranslationLines(lines, translations) {
  const associated = lines.map(line => ({ ...line, translationSegments: [] }));
  // Separate original/translation LRC files may have independent clocks.
  // Equal sentence counts alone are not enough: require a stable clock
  // offset or shared-word occurrence patterns proving sentence order.
  let ordinal = false;
  if (lines.length >= 3 && lines.length === translations.length) {
    const deltas = lines.map((line, index) => translations[index].time - line.time).sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    const stable = Math.abs(median) >= 700
      && deltas.filter(delta => Math.abs(delta - median) <= 1000).length >= lines.length * 0.9;
    const tokens = list => {
      const positions = new Map();
      list.forEach((line, index) => {
        for (const token of new Set(String(line.text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])) {
          const indices = positions.get(token) || [];
          indices.push(index);
          positions.set(token, indices);
        }
      });
      return positions;
    };
    const originals = tokens(lines);
    const translated = tokens(translations);
    const anchors = new Set();
    let contradictions = 0;
    for (const [token, indices] of originals) {
      const other = translated.get(token);
      if (!other || indices.length !== other.length) continue;
      if (indices.every((index, occurrence) => index === other[occurrence])) indices.forEach(index => anchors.add(index));
      else contradictions += 1;
    }
    ordinal = stable || (anchors.size >= 2 && !contradictions);
  }
  for (const [position, translation] of translations.entries()) {
    if (/^(?:\/{2,}|QQ音乐享有.*著作权)$/u.test(safeText(translation.text))) continue;
    if (ordinal) {
      associated[position].translationSegments.push({ ...translation, sourceTime: translation.time, time: lines[position].time });
      continue;
    }
    let index = findLineIndex(lines, translation.time);
    const next = index + 1;
    const previousDistance = index >= 0 ? Math.abs(translation.time - lines[index].time) : Infinity;
    if (next < lines.length && lines[next].time - translation.time >= 0
      && lines[next].time - translation.time <= 700 && lines[next].time - translation.time < previousDistance) index = next;
    if (index >= 0) associated[index].translationSegments.push(translation);
  }
  return associated;
}

function splitInlineLyricTranslation(line) {
  const text = String(line.text || ""), separator = text.search(/[／/]/);
  if (separator < 1) return line;
  const original = text.slice(0, separator).trimEnd(), translation = text.slice(separator + 1).trim();
  // Keep real slash lyrics (AC/DC, fractions, repeated // placeholders).
  // A Chinese second half and a foreign first half is a bilingual row.
  if (!/[\u3400-\u9fff]/u.test(translation) || /[\u3040-\u30ff]/u.test(translation)
    || !/[a-z\u3040-\u30ff]/iu.test(original)) return line;
  let remaining = original.length;
  const words = (line.words || []).flatMap(word => {
    if (remaining <= 0) return [];
    const text = String(word.text || "").slice(0, remaining); remaining -= text.length;
    return text ? [{ ...word, text }] : [];
  });
  return { ...line, text: original, ...(line.words ? { words } : {}), inlineTranslation: translation };
}

function parseNeteaseLyricData(data) {
  const lrcLines = parseLrc(data.lrc?.lyric || "");
  const yrcLines = parseYrc(data.yrc?.lyric || "");
  // Some YRC entries span several separately timed LRC sentences. Use
  // those finer sentence boundaries while retaining the YRC word times.
  const splitYrc = yrcLines.some((line, index) => {
    const end = line.duration > 0 ? line.time + line.duration : yrcLines[index + 1]?.time;
    const parts = lrcLines.filter(part => part.time >= line.time && part.time < end);
    const text = normalizeForCompare(line.text);
    return parts.length > 1 && parts.every(part => text.includes(normalizeForCompare(part.text)));
  });
  const usesYrcTimeline = yrcLines.length > 0 && !splitYrc;
  let sourceLines = usesYrcTimeline ? yrcLines : lrcLines;
  if (splitYrc) {
    const words = yrcLines.flatMap(line => line.words || []);
    sourceLines = lrcLines.map((line, index) => {
      const end = lrcLines[index + 1]?.time ?? Infinity;
      const sentenceWords = words.filter(word => word.time >= line.time && word.time < end);
      return { ...line, words: sentenceWords, duration: Number.isFinite(end) ? end - line.time : 0 };
    });
  }
  const unavailableMarker = line => /^(?:暂无歌词|暂时没有歌词|没有歌词|无歌词|no\s*(?:synced\s*)?lyrics(?:\s*available)?|lyrics\s*(?:not\s*)?available)$/i
    .test(safeText(line?.text));
  const lines = coalesceSimultaneousLyricLines(sourceLines.map(splitInlineLyricTranslation)).filter(line => !unavailableMarker(line));
  // LRC and YRC translations are alternative timelines, not extra verses.
  // Prefer the matching format; fill missing timestamps from the other
  // timeline only when they closely match a source sentence start.
  const ordinary = parseLrc(data.tlyric?.lyric || "");
  const wordTimed = parseLrc(data.ytlrc?.lyric || "");
  const primary = usesYrcTimeline ? wordTimed : ordinary;
  const secondary = usesYrcTimeline ? ordinary : wordTimed;
  const translationLines = mergeTranslationLines(primary.length ? primary : secondary);
  if (primary.length) {
    for (const line of lines) {
      if (translationLines.some(t => Math.abs(t.time - line.time) <= 700)) continue;
      const fallback = secondary.find(t => Math.abs(t.time - line.time) <= 700);
      if (fallback && !translationLines.some(t => Math.abs(t.time - fallback.time) <= 700)) translationLines.push({ ...fallback });
    }
    translationLines.sort((a, b) => a.time - b.time);
  }
  const instrumentalMarker = (line) => /^(?:纯音乐(?:请欣赏)?|(?:此|本)(?:歌曲|曲)为(?:没有填词的)?纯音乐(?:请(?:您)?欣赏)?|instrumental)$/i
    .test(normalizeForCompare(line?.text || ""));
  const creditsOnly = lines.every(line => String(line.text || "").split(/\r?\n/).every(text => instrumentalMarker({ text })
    || /^(?:词|曲|作词|作曲|编曲|原唱|制作人|制作|监制|录音|混音|母带|lyrics(?:\s+by)?|composer|arranger)\s*[:：]/i.test(safeText(text))));
  const instrumental = (Boolean(data?.nolyric) && creditsOnly)
    || (lines.length > 0 && lines.every(instrumentalMarker));

  // Split translations keep their timestamps instead of being displayed
  // all at once underneath the first source sentence.
  const associated = associateTranslationLines(lines, translationLines);
  // Associate the provider timeline first: adding inline rows before its
  // clock check changes sentence counts and can hide a valid global offset.
  for (const line of associated) {
    if (!line.inlineTranslation || line.translationSegments.length) continue;
    const translation = { time: line.time, text: line.inlineTranslation };
    line.translationSegments.push(translation);
    translationLines.push(translation);
  }
  translationLines.sort((a, b) => a.time - b.time);

  return {
    lines: instrumental ? [] : associated,
    translations: translationLines,
    lyricFormat: yrcLines.length ? "yrc" : (lrcLines.length ? "lrc" : ""),
    instrumental,
  };
}

function findLineIndex(lines, time) {
  if (!lines.length) return -1;

  let low = 0;
  let high = lines.length - 1;
  let answer = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (lines[middle].time <= time) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return answer;
}

function pickTranslation(time, currentLine = null, nextLine = null, currentIndex = -1) {
  if (!CONFIG.showTranslation) return "";
  if (Array.isArray(currentLine?.translationSegments)) {
    const segments = currentLine.translationSegments;
    const index = findLineIndex(segments, time);
    if (index >= 0) return segments[index].text;
    return segments.length && segments[0].time - time <= 700 ? segments[0].text : "";
  }
  if (currentLine && Object.prototype.hasOwnProperty.call(currentLine, "translationText")) return currentLine.translationText;
  if (!CONFIG.showTranslation || !translatedLines.length) return "";

  const currentTime = Number(currentLine?.time);
  if (!Number.isFinite(currentTime)) return "";

  const nextTime = Number(nextLine?.time);
  const nextDelta = Number.isFinite(nextTime) && nextTime > currentTime
    ? nextTime - currentTime
    : 0;
  const currentDuration = Math.max(0, Number(currentLine?.duration) || 0);
  const lineEnd = Number.isFinite(nextTime) && nextTime > currentTime
    ? nextTime
    : currentDuration > 0 ? currentTime + currentDuration : Infinity;
  const timestampTolerance = nextDelta
    ? Math.max(2200, Math.min(9000, nextDelta * 0.8))
    : Math.max(6000, currentDuration || 0);

  const nearest = translatedLines.reduce((best, line) => {
    if (!best) return line;
    return Math.abs(Number(line.time) - currentTime) < Math.abs(Number(best.time) - currentTime)
      ? line
      : best;
  }, null);
  if (nearest && Math.abs(Number(nearest.time) - currentTime) <= timestampTolerance) {
    // Keep the translation attached to the current original line until the
    // next original line begins. This also covers the final line, where no
    // next timestamp exists and the old time-based window used to expire.
    if (time <= lineEnd + 350 || !Number.isFinite(lineEnd)) return nearest.text;
  }

  // Some NetEase responses omit a translation line or shift its timestamp.
  // The same-index fallback is safe only when the timestamp is reasonably
  // close; it prevents a missing final timestamp from hiding a valid line.
  const indexed = currentIndex >= 0 ? translatedLines[currentIndex] : null;
  if (indexed && Math.abs(Number(indexed.time) - currentTime) <= timestampTolerance) {
    return indexed.text;
  }
  return "";
}

function explicitDifficultySpeed(version) {
  const text = safeText(version);
  const matches = [
    ...text.matchAll(/(?:^|[^\d])(\d+(?:[\.,]\d+)?)\s*x(?:$|[^\d])/gi),
    ...text.matchAll(/(?:^|[^\d])x\s*(\d+(?:[\.,]\d+)?)(?:$|[^\d])/gi),
    ...text.matchAll(/(?:^|[^\d])((?:0|1|2)[\.,]\d+)(?:$|[^\d])/gi),
  ];

  for (const match of matches) {
    const value = Number(String(match[1]).replace(",", "."));
    if (value >= 0.5 && value <= 2.5) return value;
  }

  const percent = text.match(/(?:^|[^\d])(\d{2,3}(?:[\.,]\d+)?)\s*[%％](?:$|[^\d])/);
  const value = Number(percent?.[1]?.replace(",", ".")) / 100;
  return value >= 0.5 && value <= 2.5 ? value : null;
}

function parseSpeedMultiplier(version) {
  return explicitDifficultySpeed(version) ?? 1;
}

function effectiveLyricTime(liveTime) {
  const scaledLiveTime = liveTime * currentSpeedMultiplier;
  let alignmentOffsetMs = currentTrackOffsetMs;
  if (currentTrackAlignmentAnchors.length) {
    const anchors = currentTrackAlignmentAnchors;
    if (scaledLiveTime <= anchors[0].sampleTimeMs) {
      alignmentOffsetMs = anchors[0].offsetMs;
    } else if (scaledLiveTime >= anchors[anchors.length - 1].sampleTimeMs) {
      alignmentOffsetMs = anchors[anchors.length - 1].offsetMs;
    } else {
      for (let index = 1; index < anchors.length; index += 1) {
        const right = anchors[index];
        if (scaledLiveTime > right.sampleTimeMs) continue;
        const left = anchors[index - 1];
        const span = Math.max(1, right.sampleTimeMs - left.sampleTimeMs);
        const progress = clamp((scaledLiveTime - left.sampleTimeMs) / span, 0, 1);
        alignmentOffsetMs = left.offsetMs + (right.offsetMs - left.offsetMs) * progress;
        break;
      }
    }
  }
  return Math.max(0, scaledLiveTime + CONFIG.lyricOffsetMs + alignmentOffsetMs);
}

function latestLiveTimeMs() {
  const latestBeatmap = latestTrackPayload ? beatmapMetadata(latestTrackPayload) : null;
  const latestTime = Number(latestBeatmap?.time?.live);
  return Number.isFinite(latestTime) && latestTime >= 0 ? latestTime : lastLiveTime;
}

function beatmapDuration(beatmap = {}, payload = {}) {
  const time = beatmap.time || payload.beatmap?.time || payload.menu?.bm?.time || {};
  const candidates = [
    time.full,
    time.mp3,
    time.lastObject,
    time.end,
    time.duration,
    beatmap.duration,
    beatmap.totalLength,
    beatmap.hitLength,
    beatmap.metadata?.duration,
  ];

  for (const value of candidates) {
    const duration = Number(value);
    if (Number.isFinite(duration) && duration > 0) return duration;
  }

  return 0;
}

function hasManualTrackOffset(result, cachedSong) {
  if (parseNumber(cachedSong?.lyricOffsetMs, 0) !== 0 && !isAutoOffsetEntry(cachedSong)) return true;
  if (cachedSong?.manual) return true;
  return parseNumber(result?.lyricOffsetMs, 0) !== 0;
}

async function applyAutoOffset(result, beatmap = {}, payload = {}, cachedSong = null) {
  if (!CONFIG.autoOffsetFromFirstObject || !result?.lines?.length) return result;
  if (hasManualTrackOffset(result, cachedSong)) return result;
  if (!window.LyricAlignment?.estimateOffset) return result;

  const firstObjectTime = await firstObjectTimeForAlignment(beatmap, payload);
  const speed = resolvedLyricSpeed(beatmap, {
    neteaseBpm: result.neteaseBpm,
    storedSpeedMultiplier: result.speedMultiplier,
  });
  const estimate = window.LyricAlignment.estimateOffset({
    lyricLines: result.lines,
    firstObjectTime,
    speed,
    maxOffsetMs: CONFIG.autoOffsetMaxMs,
    leadMs: CONFIG.autoOffsetLeadMs,
  });

  if (!estimate) return result;

  return {
    ...result,
    lyricOffsetMs: estimate.offset,
    autoOffsetMs: estimate.offset,
    autoOffsetSource: "first lyric to first object",
    firstLyricTimeMs: estimate.lyricTime,
    firstObjectTimeMs: estimate.firstObjectTime,
  };
}

function updateTimelineDuration(beatmap = {}, payload = {}, resetWhenMissing = false) {
  const duration = beatmapDuration(beatmap, payload);
  if (duration && duration !== currentDuration) {
    currentDuration = duration;
    lastTimelineBucket = -1;
  } else if (!duration && resetWhenMissing && currentDuration) {
    currentDuration = 0;
    lastTimelineBucket = -1;
  }
}
