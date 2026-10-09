// Lyric DOM roles, progress, status badges and fade/roll transitions.
// Geometry is committed through layout.js after content changes.

function clearDisplayedLyrics(message = "", options = {}) {
  currentLyricResult = null;
  lyricLines = [];
  translatedLines = [];
  if (!options.keepTrackState) {
    loadedLyricsTrackKey = "";
    loadingLyricsTrackKey = "";
  }
  lastRenderedLyricIndex = -2;
  lastTimelineBucket = -1;
  currentTrackOffsetMs = 0;
  currentTrackAlignmentAnchors = [];
  currentAutoOffsetSource = "";
  updateOffsetBadge();
  clearLyricTransitionEffects();
  beforeLinesEl.textContent = "";
  delete currentLineEl.dataset.lyricKey;
  delete currentLineEl.dataset.lyricText;
  delete currentLineEl.dataset.introIndex;
  lyricsEl?.classList.remove("is-before-first");
  currentLyricProgressUnits = [];
  currentLyricEllipsis = null;
  lastLyricProgressRenderAt = 0;
  currentLineEl.textContent = message;
  currentLineEl.style.removeProperty("--lyric-progress");
  currentTimeEl.textContent = "";
  translationEl.textContent = "";
  translationEl.title = "";
  lyricsEl?.classList.add("no-translation");
  afterLinesEl.textContent = "";
  flushOverlayLayout();
}

function setStatus(text) {
  const fullText = String(text || "").replace(/\s+/g, " ").trim();
  const primary = fullText
    .replace(/^lyrics:\s*/i, "")
    .replace(/^background:\s*/i, "bg: ")
    .split(";")[0]
    .trim();
  statusEl.textContent = primary.length > 52 ? `${primary.slice(0, 51)}…` : primary;
  statusEl.title = fullText;
}

function updateOffsetBadge() {
  const total = parseNumber(CONFIG.lyricOffsetMs, 0) + parseNumber(currentTrackOffsetMs, 0);
  offsetBadgeEl.textContent = formatSignedMs(total);
  offsetBadgeEl.title = currentAutoOffsetSource || "Lyric offset";
}

function updateAudioMatchBadge() {
  if (!audioMatchBadgeEl) return;

  const windows = /^windows:([0-3])\/3$/.exec(currentAudioMatchConfidence || "");
  const historical = /^([1-4])\/[1-4]$/.test(currentAudioMatchConfidence || "");
  const verified = windows ? `${windows[1]}/3` : historical ? "OK" : "TXT";
  const labels = {
    idle: "IDLE",
    matching: "A",
    refining: windows ? `B ${windows[1]}/3` : "B",
    success: verified,
    fallback: verified,
    empty: "N/A",
    disabled: "OFF",
  };
  audioMatchBadgeEl.textContent = labels[currentAudioMatchState] || labels.idle;
  audioMatchBadgeEl.title = windows
    ? `三个标准音频采样位置中，有 ${windows[1]} 个独立片段支持当前歌曲及时间模型；不是识别成功概率。`
    : historical
      ? "沿用历史识别结果；旧版混合评分无法准确换算音频核验数量，重新识别后显示核验 n/3。"
      : "音频核验尚未完成；标题搜索或暂无音频结果时不虚构核验数量。";
  if (currentAudioMatchState === "refining") audioMatchBadgeEl.title += " B 正在后台校正，保留当前歌词。";
  audioMatchBadgeEl.className = "audio-match-badge";
  if (CONFIG.showAudioMatchBadge) audioMatchBadgeEl.classList.add("is-visible");
  if (currentAudioMatchState === "success") audioMatchBadgeEl.classList.add("is-success");
  if (["fallback", "disabled", "empty"].includes(currentAudioMatchState)) audioMatchBadgeEl.classList.add("is-fallback");
}

function setAudioMatchState(state) {
  currentAudioMatchState = state;
  updateAudioMatchBadge();
}

function renderTimeline(liveTime) {
  const duration = Number(currentDuration) || 0;
  const horizontal = overlayEl?.classList.contains("layout-dashboard") || overlayEl?.classList.contains("layout-subtitle");
  if (!duration) {
    if (lastTimelineBucket !== 0) {
      lastTimelineBucket = 0;
      document.documentElement.style.setProperty("--progress", "0");
      timelineFillEl.style.height = horizontal ? "100%" : "0%";
      timelineFillEl.style.width = horizontal ? "0%" : "100%";
    }
    renderTimelineVisualizer(liveTime, 0);
    return;
  }

  const progress = clamp((Number(liveTime) || 0) / duration, 0, 1);
  const bucket = Math.round(progress * 1000);
  if (bucket === lastTimelineBucket) {
    renderTimelineVisualizer(liveTime, progress);
    return;
  }

  lastTimelineBucket = bucket;
  document.documentElement.style.setProperty("--progress", String(progress));
  timelineFillEl.style.height = horizontal ? "100%" : `${progress * 100}%`;
  timelineFillEl.style.width = horizontal ? `${progress * 100}%` : "100%";
  renderTimelineVisualizer(liveTime, progress);
}

function renderContext(container, lines) {
  const children = [...container.children];
  if (children.length === lines.length && children.every((element, index) => (
    element.dataset.lyricKey === lines[index].key && element.textContent === lines[index].text
  ))) return;
  container.textContent = "";

  for (const lineData of lines) {
    const line = document.createElement("div");
    line.className = "line context-line";
    line.dataset.lyricKey = lineData.key;
    line.textContent = lineData.text;
    line.title = lineData.text;
    container.appendChild(line);
  }
}

function setCurrentLine(lineData) {
  const previousText = currentLineEl.dataset.lyricText;
  currentLineEl.dataset.lyricKey = lineData.key;
  currentLineEl.dataset.lyricText = lineData.text;
  currentLineEl.title = lineData.text;

  const timedWords = Array.isArray(lineData.words) ? lineData.words.filter((word) => word?.text) : [];
  const wordText = timedWords.map((word) => word.text).join("");
  const units = timedWords.length && wordText === lineData.text
    ? timedWords.flatMap(word => {
      const glyphs = splitLyricGraphemes(word.text);
      return glyphs.map((text, index) => ({ text, time: word.time + word.duration * index / glyphs.length,
        duration: word.duration / glyphs.length }));
    })
    : splitLyricGraphemes(lineData.text || "").map((text) => ({ text }));
  const reuse = previousText === lineData.text && currentLineEl.textContent === lineData.text
    && currentLineEl.querySelector(".lyric-main-row") && units.length === currentLyricProgressUnits.length
    && units.every((unit, index) => unit.text === currentLyricProgressUnits[index].text);
  if (reuse) {
    units.forEach((unit, index) => {
      const previous = currentLyricProgressUnits[index];
      if (previous.time !== unit.time || previous.duration !== unit.duration) {
        previous.time = unit.time; previous.duration = unit.duration;
        delete previous.progressStep;
      }
      if (!CONFIG.lyricProgressEnabled) {
        previous.element.style.transition = "none";
        previous.element.style.opacity = "1";
        delete previous.progressStep;
      }
    });
    lastLyricProgressRenderAt = 0;
    return;
  }
  currentLineEl.textContent = "";
  currentLyricProgressUnits = [];
  lastLyricProgressRenderAt = 0;
  const mainRow = document.createElement("span");
  mainRow.className = "lyric-main-row";
  const tailRow = document.createElement("span");
  tailRow.className = "lyric-tail-row";
  currentLineEl.append(mainRow, tailRow);

  for (const unit of units) {
    const element = document.createElement("span");
    element.className = "lyric-progress-unit";
    element.textContent = unit.text;
    mainRow.appendChild(element);
    currentLyricProgressUnits.push({ ...unit, element });
  }
}

function splitLyricGraphemes(text) {
  return typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(item => item.segment)
    : Array.from(text);
}

function lyricProgressForLine(line, nextLine, time) {
  if (!line) return 0;

  if (Array.isArray(line.words) && line.words.length) {
    const totalUnits = line.words.reduce((sum, word) => sum + Math.max(1, Array.from(word.text || "").length), 0);
    let completedUnits = 0;
    for (const word of line.words) {
      const units = Math.max(1, Array.from(word.text || "").length);
      const start = Number(word.time) || line.time;
      const duration = Math.max(1, Number(word.duration) || 1);
      if (time >= start + duration) {
        completedUnits += units;
      } else if (time > start) {
        completedUnits += units * clamp((time - start) / duration, 0, 1);
        break;
      } else {
        break;
      }
    }
    return clamp(completedUnits / Math.max(1, totalUnits), 0, 1);
  }

  const start = Number(line.time) || 0;
  const end = Number(nextLine?.time) || (start + Math.max(750, Number(line.duration) || 3500));
  return clamp((time - start) / Math.max(1, end - start), 0, 1);
}

function updateLyricEllipsisProgress(line, nextLine, time) {
  if (!currentLyricEllipsis || !line) return;
  const units = currentLyricProgressUnits, first = units[currentLyricEllipsis.index], last = units[units.length - 1];
  const timed = units.every(unit => Number.isFinite(Number(unit.time)) && Number(unit.duration) >= 0);
  const progress = timed
    ? (time - Number(first.time)) / Math.max(1, Number(last.time) + Number(last.duration) - Number(first.time))
    : (lyricProgressForLine(line, nextLine, time) * units.length - currentLyricEllipsis.index)
      / Math.max(1, units.length - currentLyricEllipsis.index);
  const dim = clamp(Number(CONFIG.lyricProgressUnplayedOpacity), 0.12, 0.9);
  const opacity = (CONFIG.lyricProgressEnabled ? dim + (1 - dim) * clamp(progress, 0, 1) : 1).toFixed(3);
  if (Number(currentLyricEllipsis.element.style.getPropertyValue("--ellipsis-opacity")) !== Number(opacity)) {
    currentLyricEllipsis.element.style.setProperty("--ellipsis-opacity", opacity);
  }
}

function updateCurrentLineProgress(line, nextLine, time) {
  if (!CONFIG.lyricProgressEnabled || !line || currentLineEl.dataset.lyricKey === undefined) return;
  const units = currentLyricProgressUnits;
  if (!units.length) return;

  const now = performance.now();
  if (now - lastLyricProgressRenderAt < 33) return;
  lastLyricProgressRenderAt = now;

  const dimOpacity = clamp(Number(CONFIG.lyricProgressUnplayedOpacity), 0.12, 0.9);
  const applyUnitProgress = (unit, progress) => {
    const stepped = Math.round(clamp(progress, 0, 1) * 24) / 24;
    const opacity = (dimOpacity + (1 - dimOpacity) * stepped).toFixed(3);
    if (unit.progressStep === stepped && Number(unit.element.style.opacity) === Number(opacity)) return;
    // A new/time-corrected glyph starts at its actual playback progress.
    // Only subsequent movement fades; initialization must not flash dim.
    unit.element.style.transition = unit.progressStep === undefined ? "none" : "";
    unit.progressStep = stepped;
    unit.element.style.opacity = opacity;
  };

  const hasWordTiming = units.every((unit) => Number.isFinite(Number(unit.time)) && Number(unit.duration) >= 0);
  updateLyricEllipsisProgress(line, nextLine, time);
  if (hasWordTiming) {
    for (const unit of units) {
      const start = Number(unit.time);
      const duration = Math.max(1, Number(unit.duration));
      applyUnitProgress(unit, (time - start) / duration);
    }
    return;
  }

  const lineProgress = lyricProgressForLine(line, nextLine, time);
  const completedUnits = lineProgress * units.length;
  for (let index = 0; index < units.length; index += 1) {
    applyUnitProgress(units[index], completedUnits - index);
  }
}

function hasCjkText(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ""));
}

function hasJapaneseKana(value) {
  return /[\u3040-\u30ff\uff66-\uff9f]/u.test(String(value || ""));
}

function isChineseOriginalLyric(value) {
  if (!hasCjkText(value)) return false;
  // Japanese lyrics often contain a few kanji-only lines (for example a
  // one-word refrain). Classifying each line independently hides only those
  // translations. Use the track's lyric corpus to retain the language
  // context established by its other kana-containing lines.
  const trackUsesJapaneseKana = lyricLines.some((line) => hasJapaneseKana(line?.text));
  return !trackUsesJapaneseKana && !hasJapaneseKana(value);
}

function shouldDisplayTranslation(current, translation) {
  const text = safeText(translation);
  // NetEase translations for this overlay are normally Chinese. Do not add
  // a second row when the lyric is already Chinese or the returned field is
  // an untranslated/empty non-Chinese alternative.
  return Boolean(text) && !isChineseOriginalLyric(current?.text) && hasCjkText(text);
}

function applyLyricDom({ before, current, timeText, translation, after }) {
  lyricsEl?.classList.toggle("is-before-first", Boolean(current.intro));
  if (!current.intro) delete currentLineEl.dataset.introIndex;
  renderContext(beforeLinesEl, before);
  setCurrentLine(current);
  currentTimeEl.textContent = timeText;
  const showTranslation = shouldDisplayTranslation(current, translation);
  translationEl.textContent = showTranslation ? translation : "";
  translationEl.title = showTranslation ? translation : "";
  lyricsEl?.classList.toggle("no-translation", !showTranslation);
  renderContext(afterLinesEl, after);
  flushOverlayLayout();
}

function captureLyricRects() {
  const rects = new Map();
  if (!lyricsEl) return rects;

  for (const element of lyricsEl.querySelectorAll(".line[data-lyric-key]")) {
    if (element.hidden) continue;
    const style = getComputedStyle(element);
    rects.set(element.dataset.lyricKey, {
      rect: element.getBoundingClientRect(),
      className: element.className,
      text: element.dataset.lyricText || element.textContent || "",
      style: {
        color: style.color,
        opacity: style.opacity,
      },
    });
  }

  return rects;
}

function animateLyricRoll(previousRects) {
  if (!lyricsEl || typeof Element === "undefined") return;

  const duration = 280;
  const easing = "cubic-bezier(.2,.75,.18,1)";
  const nextKeys = new Set();

  for (const element of lyricsEl.querySelectorAll(".line[data-lyric-key]")) {
    if (element.hidden) continue;
    const key = element.dataset.lyricKey;
    nextKeys.add(key);
    const previous = previousRects.get(key);
    const next = element.getBoundingClientRect();
    const nextStyle = getComputedStyle(element);
    // Keep the current lyric group centred and fully visible.
    // Context lines still roll; provider updates cannot stack opacity
    // animations on the single reused original-line element.
    if (element === currentLineEl) continue;

    if (previous && typeof element.animate === "function") {
      const dx = previous.rect.left - next.left;
      const dy = previous.rect.top - next.top;
      element.animate([
        {
          transform: `translate(${dx}px, ${dy}px)`,
          opacity: previous.style.opacity || 0.78,
          color: previous.style.color,
        },
        {
          transform: "none",
          opacity: nextStyle.opacity || 1,
          color: nextStyle.color,
        },
      ], { duration, easing });
    } else if (typeof element.animate === "function") {
      element.animate([
        { transform: "translateY(18px)", opacity: 0 },
        { transform: "none", opacity: nextStyle.opacity || 1 },
      ], { duration, easing });
    }
  }

  const lyricsRect = lyricsEl.getBoundingClientRect();
  for (const [key, previous] of previousRects.entries()) {
    if (nextKeys.has(key)) continue;
    // The current original is replaced in place, not rolled out. A copy
    // carrying .current has its own positioning rules and can cover the
    // newly committed source/translation during a provider replacement.
    if (previous.className.split(/\s+/).includes("current")) continue;

    const ghost = document.createElement("div");
    ghost.className = `${previous.className} line-ghost`;
    ghost.textContent = previous.text;
    ghost.style.left = `${previous.rect.left - lyricsRect.left}px`;
    ghost.style.top = `${previous.rect.top - lyricsRect.top}px`;
    ghost.style.width = `${previous.rect.width}px`;
    lyricsEl.appendChild(ghost);

    if (typeof ghost.animate === "function") {
      const animation = ghost.animate([
        { transform: "translateY(0)", opacity: getComputedStyle(ghost).opacity || 0.78 },
        { transform: "translateY(-18px)", opacity: 0 },
      ], { duration, easing });
      animation.onfinish = () => ghost.remove();
    } else {
      ghost.remove();
    }
  }
}

function captureOutgoingLyricBlock() {
  if (!currentLineEl.dataset.lyricKey || !currentLineEl.textContent) return null;
  const block = currentLineEl.parentElement;
  const rect = block.getBoundingClientRect();
  const area = lyricsEl.getBoundingClientRect();
  const clone = block.cloneNode(true);
  clone.classList.add("lyric-outgoing");
  clone.setAttribute("aria-hidden", "true");
  for (const element of clone.querySelectorAll("[id], [data-lyric-key], [data-lyric-text]")) {
    element.removeAttribute("id");
    element.removeAttribute("data-lyric-key");
    element.removeAttribute("data-lyric-text");
  }
  for (const property of ["--lyric-color", "--lyric-color-start", "--lyric-color-end",
    "--presentation-lyric-line-height", "--presentation-translation-line-height"]) {
    clone.style.setProperty(property, getComputedStyle(block).getPropertyValue(property));
  }
  const originalRows = block.querySelectorAll(".line, .translation, .meta-row");
  clone.querySelectorAll(".line, .translation, .meta-row").forEach((element, index) => {
    const style = getComputedStyle(originalRows[index]);
    for (const property of ["font-size", "line-height", "display", "white-space", "text-wrap",
      "max-height", "overflow", "text-overflow", "position", "top", "right", "bottom", "left",
      "width", "height", "margin-top", "transform"]) {
      element.style.setProperty(property, style.getPropertyValue(property));
    }
  });
  const originalGlyphs = block.querySelectorAll(".lyric-progress-unit");
  clone.querySelectorAll(".lyric-progress-unit").forEach((element, index) => {
    element.style.transition = "none";
    element.style.opacity = getComputedStyle(originalGlyphs[index]).opacity;
  });
  Object.assign(clone.style, { position: "absolute", left: `${rect.left - area.left}px`, right: "auto",
    top: `${rect.top - area.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, pointerEvents: "none",
    opacity: String(clamp(Number(getComputedStyle(block).opacity), 0.35, 1)) });
  return clone;
}

function animateCurrentLyricTransition(mode, outgoing) {
  const duration = mode === "fade" ? 200 : 280;
  // Animate the group, not the reused source element. Explicit endpoints
  // and cancellation prevent inherited near-zero opacity on rapid seeks.
  currentLineEl.parentElement.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration, easing: "ease-out" });
  if (outgoing) {
    lyricsEl.appendChild(outgoing);
    const animation = outgoing.animate?.([
      { opacity: Number(outgoing.style.opacity), transform: "translateY(0)" },
      { opacity: 0, transform: mode === "fade" ? "translateY(0)" : "translateY(-10px)" },
    ], { duration, easing: "ease-out" });
    if (animation) animation.onfinish = () => outgoing.remove();
    else outgoing.remove();
  }
  if (mode === "fade") {
    for (const element of lyricsEl.querySelectorAll(".context-line")) {
      if (element.hidden) continue;
      element.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration, easing: "ease-out" });
    }
  }
}

function updateLyricDom(view) {
  const mode = String(CONFIG.lyricTransitionMode || "roll").toLowerCase();
  const sameCurrent = currentLineEl.dataset.lyricKey === view.current.key
    || (Boolean(view.current.text) && currentLineEl.dataset.lyricText === view.current.text);
  const hasPreviousLyric = Boolean(currentLineEl.dataset.lyricKey && currentLineEl.dataset.lyricText);
  if (sameCurrent && mode !== "off" && mode !== "none") {
    // A B-result confirmation/live refresh of the same sentence must not
    // cancel the animation that just started for that sentence.
    applyLyricDom(view);
    return;
  }
  clearTimeout(lyricTransitionTimer);
  lyricTransitionTimer = 0;
  const generation = ++lyricTransitionGeneration;
  if (lyricAnimationFrame) cancelAnimationFrame(lyricAnimationFrame);
  lyricAnimationFrame = 0;

  // Capture before cancelling, then reset animations to their CSS state.
  // Reading nextStyle while an old animation is running can inherit its
  // near-zero opacity as the next animation's final opacity.
  const previousRects = mode === "roll" || mode === "slide" ? captureLyricRects() : null;
  const outgoing = !sameCurrent && mode !== "off" && mode !== "none" ? captureOutgoingLyricBlock() : null;
  lyricsEl?.querySelectorAll(".line, .current-block, .lyric-outgoing").forEach(element => {
    element.getAnimations?.().forEach(animation => animation.cancel());
  });
  lyricsEl?.querySelectorAll(".line-ghost, .lyric-outgoing").forEach(element => element.remove());

  if (sameCurrent || !hasPreviousLyric || mode === "off" || mode === "none" || !lyricsEl) {
    lyricsEl?.classList.remove("is-transitioning");
    applyLyricDom(view);
    return;
  }

  lyricsEl.classList.remove("is-transitioning");
  // Commit roles atomically, then crossfade a correctly positioned,
  // short-lived snapshot. The current anchor never moves during the fade.
  applyLyricDom(view);
  lyricAnimationFrame = requestAnimationFrame(() => {
    lyricAnimationFrame = 0;
    if (generation !== lyricTransitionGeneration) return;
    if (previousRects) animateLyricRoll(previousRects);
    animateCurrentLyricTransition(mode === "slide" ? "roll" : mode, outgoing);
  });
}

function clearLyricTransitionEffects() {
  clearTimeout(lyricTransitionTimer);
  lyricTransitionTimer = 0;
  lyricTransitionGeneration += 1;
  if (lyricAnimationFrame) cancelAnimationFrame(lyricAnimationFrame);
  lyricAnimationFrame = 0;
  lyricsEl?.querySelectorAll(".line, .current-block, .lyric-outgoing").forEach(element => element.getAnimations?.().forEach(animation => animation.cancel()));
  lyricsEl?.classList.remove("is-transitioning");
  lyricsEl?.querySelectorAll(".line-ghost, .lyric-outgoing").forEach(element => element.remove());
}

function firstSungLyricIndex() {
  // Skip provider credits and unavailable/instrumental markers without
  // altering the source rows, translation associations or timestamps.
  if (currentLyricResult?.instrumental) return -1;
  return lyricLines.findIndex(line => lyricContentLines({ ...currentLyricResult, lines: [line] }).length > 0);
}

function updateLyricIntroProgress(firstLine, adjustedTime) {
  let progressEl = currentLineEl.querySelector(".lyric-intro-progress");
  if (!progressEl) {
    progressEl = document.createElement("span");
    progressEl.className = "lyric-intro-progress";
    progressEl.setAttribute("role", "progressbar");
    progressEl.setAttribute("aria-label", "等待第一句歌词");
    progressEl.setAttribute("aria-valuemin", "0");
    progressEl.setAttribute("aria-valuemax", "100");
    for (let i = 0; i < 5; i++) {
      const dot = document.createElement("span");
      dot.className = "lyric-intro-dot";
      dot.setAttribute("aria-hidden", "true");
      progressEl.appendChild(dot);
    }
    currentLineEl.replaceChildren(progressEl);
  }
  // Use the same offset/rate/anchor model as lyric selection. No timer or
  // independent playback clock: pausing and seeking update from tosu.
  const start = Math.min(effectiveLyricTime(0), Number(firstLine.time) - 1);
  const progress = clamp((adjustedTime - start) / Math.max(1, Number(firstLine.time) - start), 0, 1);
  const percent = String(Math.round(progress * 100));
  if (progressEl.getAttribute("aria-valuenow") !== percent) progressEl.setAttribute("aria-valuenow", percent);
  [...progressEl.children].forEach((dot, index) => {
    const opacity = progress >= (index + 1) / 5 ? "1" : "0.22";
    if (Number(dot.style.opacity) !== Number(opacity)) dot.style.opacity = opacity;
  });
}

function renderLyrics(time, force = false) {
  if (loadedLyricsTrackKey !== currentTrackKey) return;
  if (!lyricLines.length) return;

  const adjustedTime = effectiveLyricTime(time);
  const index = findLineIndex(lyricLines, adjustedTime);
  const subtitle = CONFIG.lyricLayout === "subtitle";
  const firstIndex = subtitle ? -1 : firstSungLyricIndex();
  const firstLine = lyricLines[firstIndex];
  if (firstLine && adjustedTime < Number(firstLine.time)) {
    const key = `before-first|${firstLine.time}|${firstIndex}`;
    const needsCommit = force || currentLineEl.dataset.lyricKey !== key
      || !currentLineEl.querySelector(".lyric-intro-progress");
    lastRenderedLyricIndex = -1;
    if (currentLineEl.dataset.introIndex !== String(firstIndex)) currentLineEl.dataset.introIndex = String(firstIndex);
    if (needsCommit) {
      clearLyricTransitionEffects();
      const afterCount = CONFIG.autoContextLinesEnabled ? 1 : Math.max(1, clamp(Number(CONFIG.contextAfter), 0, 8));
      applyLyricDom({ before: [], current: { key, text: "", words: [], intro: true },
        timeText: formatTime(adjustedTime), translation: "",
        after: lyricLines.slice(firstIndex, firstIndex + afterCount).map((line, offset) => ({
          key: `${line.time}|${firstIndex + offset}|${line.text}`, text: line.text,
        })) });
    }
    updateLyricIntroProgress(firstLine, adjustedTime);
    return;
  }
  if (index < 0) {
    if (lastRenderedLyricIndex === -1 && !force && !lyricsEl.classList.contains("is-before-first")) return;
    lastRenderedLyricIndex = -1;
    const afterCount = subtitle || CONFIG.autoContextLinesEnabled ? 0 : clamp(Number(CONFIG.contextAfter), 0, 8);
    const toViewLine = (line, lineIndex) => ({
      key: `${line.time}|${lineIndex}|${line.text}`,
      text: line.text,
      words: line.words || [],
    });
    updateLyricDom({
      before: [],
      current: { key: `before-first|empty`, text: "", words: [] },
      timeText: formatTime(adjustedTime),
      translation: "",
      after: lyricLines.slice(0, afterCount).map(toViewLine),
    });
    return;
  }

  const currentIndex = index;
  const currentLine = lyricLines[currentIndex];
  const nextLine = lyricLines[currentIndex + 1];
  const sourceIsCommitted = currentLineEl.dataset.lyricKey === `${currentLine.time}|${currentIndex}|${currentLine.text}`
    && currentLineEl.dataset.lyricText === currentLine.text && currentLineEl.textContent === currentLine.text;
  if (currentIndex === lastRenderedLyricIndex && !force && sourceIsCommitted) {
    currentTimeEl.textContent = formatTime(lyricLines[currentIndex]?.time || adjustedTime);
    const translation = pickTranslation(adjustedTime, currentLine, nextLine, currentIndex);
    const showTranslation = shouldDisplayTranslation(currentLine, translation);
    const text = showTranslation ? translation : "";
    const translationChanged = translationEl.textContent !== text
      || lyricsEl.classList.contains("no-translation") === showTranslation;
    if (translationEl.textContent !== text) translationEl.textContent = text;
    translationEl.title = text;
    lyricsEl?.classList.toggle("no-translation", !showTranslation);
    if (translationChanged) flushOverlayLayout();
    updateCurrentLineProgress(currentLine, nextLine, adjustedTime);
    return;
  }

  lastRenderedLyricIndex = currentIndex;
  const beforeCount = subtitle || CONFIG.autoContextLinesEnabled ? 0 : clamp(Number(CONFIG.contextBefore), 0, 8);
  const afterCount = subtitle || CONFIG.autoContextLinesEnabled ? 0 : clamp(Number(CONFIG.contextAfter), 0, 8);
  const beforeStart = Math.max(0, currentIndex - beforeCount);
  const toViewLine = (line, lineIndex) => ({
    key: `${line.time}|${lineIndex}|${line.text}`,
    text: line.text,
    words: line.words || [],
  });
  const before = lyricLines
    .slice(beforeStart, currentIndex)
    .map((line, index) => toViewLine(line, beforeStart + index));
  const after = lyricLines
    .slice(currentIndex + 1, currentIndex + 1 + afterCount)
    .map((line, index) => toViewLine(line, currentIndex + 1 + index));

  updateLyricDom({
    before,
    current: toViewLine(currentLine || { time: adjustedTime, text: "" }, currentIndex),
    timeText: formatTime(lyricLines[currentIndex]?.time || adjustedTime),
    translation: pickTranslation(adjustedTime, currentLine, nextLine, currentIndex),
    after,
  });
  updateCurrentLineProgress(currentLine, nextLine, adjustedTime);
}
