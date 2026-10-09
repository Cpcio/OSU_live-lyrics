// Song header measurement and responsive lyric/cover geometry.
// Auto context allocation changes presentation only; lyric clocks live in lyrics.js.

function updateSongHeader(title, artist) {
  const safeTitle = title || "Unknown title";
  const safeArtist = artist || "Unknown artist";
  const singleLine = CONFIG.songHeaderFormat === "single-line";
  const nextTitle = singleLine ? `${safeTitle} / ${safeArtist}` : safeTitle;
  const nextArtist = singleLine ? "" : safeArtist;
  // Live time packets do not change song metadata. In dashboard mode the
  // displayed title is split across rows, so comparing its DOM text to the
  // full title would otherwise rewrite it and relayout on every packet.
  if (dashboardHeaderTitle === nextTitle && dashboardHeaderArtist === nextArtist) return;

  dashboardHeaderTitle = nextTitle;
  dashboardHeaderArtist = nextArtist;
  if (titleEl.textContent !== nextTitle) titleEl.textContent = nextTitle;
  artistEl.hidden = singleLine;
  if (!singleLine && artistEl.textContent !== safeArtist) artistEl.textContent = safeArtist;
  scheduleOverlayLayout();
}

function createHeaderTextMeasurer(element) {
  const style = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return text => context.measureText(text).width;
}

function headerTextWidth(element, text, measure = null) {
  return (measure || createHeaderTextMeasurer(element))(text);
}

function fittingCharacterCount(characters, maxWidth, element, measure = null) {
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (headerTextWidth(element, characters.slice(0, middle).join(""), measure) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return low;
}

function truncateHeaderText(text, maxWidth, element, measure = null) {
  if (headerTextWidth(element, text, measure) <= maxWidth) return text;
  const ellipsis = "…";
  const characters = Array.from(text);
  const count = fittingCharacterCount(characters, Math.max(0, maxWidth - headerTextWidth(element, ellipsis, measure)), element, measure);
  return count ? `${characters.slice(0, count).join("")}${ellipsis}` : ellipsis;
}

function layoutDashboardSongHeader() {
  if (!songCopyEl) return;
  if (!overlayEl?.classList.contains("layout-dashboard")) {
    titleEl.textContent = dashboardHeaderTitle;
    titleTailEl.textContent = "";
    artistEl.textContent = dashboardHeaderArtist;
    artistEl.hidden = !dashboardHeaderArtist;
    return;
  }

  const computed = getComputedStyle(songCopyEl);
  const maxHeight = Number.parseFloat(computed.maxHeight);
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) return;

  const headerWidth = songCopyEl.clientWidth;
  if (headerWidth <= 0) return;
  const titleLineHeight = Number.parseFloat(getComputedStyle(titleEl).lineHeight) || 26;
  const availableLines = Math.max(1, Math.floor(maxHeight / titleLineHeight));
  // Capture each font once per layout, and reuse its measurement context
  // while finding line breaks. No text-width history is retained.
  const titleMeasure = createHeaderTextMeasurer(titleEl);
  const tailMeasure = createHeaderTextMeasurer(titleTailEl);
  const artistMeasure = createHeaderTextMeasurer(artistEl);
  const prefixLines = [];
  let finalLine = dashboardHeaderTitle;
  while (prefixLines.length < availableLines - 1 && headerTextWidth(titleTailEl, finalLine, tailMeasure) > headerWidth) {
    const characters = Array.from(finalLine);
    const firstCount = fittingCharacterCount(characters, headerWidth, titleEl, titleMeasure);
    if (!firstCount) break;
    prefixLines.push(characters.slice(0, firstCount).join(""));
    finalLine = characters.slice(firstCount).join("");
  }

  // The title owns both available lines. Only text beyond that capacity is
  // shortened; the artist consumes whatever remains on the final line.
  finalLine = truncateHeaderText(finalLine, headerWidth, titleTailEl, tailMeasure);
  const gap = 8;
  const titleWidth = headerTextWidth(titleTailEl, finalLine, tailMeasure);
  const availableArtistWidth = Math.max(0, headerWidth - titleWidth - gap);
  const requestedArtistWidth = headerTextWidth(artistEl, dashboardHeaderArtist, artistMeasure);
  const artistWidth = Math.min(requestedArtistWidth, availableArtistWidth);
  const artistText = artistWidth >= headerTextWidth(artistEl, "…", artistMeasure)
    ? truncateHeaderText(dashboardHeaderArtist, artistWidth, artistEl, artistMeasure)
    : "";

  titleEl.textContent = prefixLines.join("\n");
  titleTailEl.textContent = finalLine;
  artistEl.textContent = artistText;
  artistEl.hidden = !artistText;
  songCopyEl.style.setProperty("--dashboard-artist-width", artistText ? `${artistWidth}px` : "0px");
  songCopyEl.style.setProperty("--dashboard-artist-slot", artistText ? `${artistWidth + gap}px` : "0px");
}

function scheduleOverlayLayout() {
  if (dashboardHeaderResizeFrame) return;
  dashboardHeaderResizeFrame = requestAnimationFrame(() => {
    dashboardHeaderResizeFrame = 0;
    layoutOverlayPresentation();
  });
}

function flushOverlayLayout() {
  // A new lyric/message must not paint using the preceding block's top
  // or fitted font sizes. Commit geometry with the content transaction.
  if (dashboardHeaderResizeFrame) cancelAnimationFrame(dashboardHeaderResizeFrame);
  dashboardHeaderResizeFrame = 0;
  layoutOverlayPresentation();
}

function alignToDevicePixel(value) {
  const ratio = Number(window.devicePixelRatio) || 1;
  return Math.round(value * ratio) / ratio;
}

function layoutOverlayPresentation() {
  const shell = document.querySelector(".lyrics-shell");
  const timeline = document.querySelector(".timeline");
  const song = document.querySelector(".song");
  const icon = document.getElementById("songIcon");
  if (!overlayEl || !shell || !timeline || !song || !icon) return;
  const layout = CONFIG.lyricLayout;
  const dashboard = layout === "dashboard";
  const subtitle = layout === "subtitle";
  const autoContext = CONFIG.autoContextLinesEnabled && !subtitle;
  // Restore full metadata before measuring a non-dashboard header. Doing
  // this after fitting changes the lyric viewport after its anchor commits.
  if (!dashboard) layoutDashboardSongHeader();
  const style = overlayEl.style;
  // Re-evaluate the temporary single-line fallback as the host is resized
  // or a shorter sentence arrives. Never change the user's wrap setting.
  overlayEl.classList.remove("current-group-single-line");
  const width = overlayEl.clientWidth;
  const viewportKey = [width, window.innerWidth, window.innerHeight, window.devicePixelRatio, layout,
    CONFIG.overlayHeightPx, CONFIG.lyricFontScale, CONFIG.contextFontScale, CONFIG.translationFontScale,
    CONFIG.titleFontScale, CONFIG.artistFontScale, CONFIG.timeFontScale, CONFIG.offsetFontScale,
    CONFIG.audioMatchBadgeFontScale, CONFIG.showDebugStatus,
    CONFIG.showAudioMatchBadge, CONFIG.timelineVisualizerEnabled, CONFIG.lyricSingleLineEnabled,
    CONFIG.translatedLyricWrapEnabled, CONFIG.dashboardLeftColumnPercent, CONFIG.customFontPath].join("|");
  if (viewportKey !== lyricViewportLayoutKey) {
    clearLyricTransitionEffects();
    lyricViewportLayoutKey = viewportKey;
  }
  const availableHeight = Math.max(80, window.innerHeight - 32);
  const effectiveHeight = Math.min(Number(CONFIG.overlayHeightPx) > 0 ? Number(CONFIG.overlayHeightPx) : availableHeight, availableHeight);
  const shortPanel = effectiveHeight < 220;
  overlayEl.classList.toggle("is-short", shortPanel);
  const paddingSize = shortPanel ? 12 : Math.round(clamp(width * 0.022, 12, 24));
  style.setProperty("--panel-padding", `${paddingSize}px`);
  style.setProperty("--column-inset", width < 560 ? "12px" : "24px");
  style.setProperty("--column-gap", width < 560 ? "14px" : "24px");
  overlayEl.classList.toggle("is-compact", width < 600 || effectiveHeight < 300);
  const spectrumSize = layout === "subtitle" ? (shortPanel ? 16 : 24) : (shortPanel ? 20 : 34);
  style.setProperty("--spectrum-height", `${spectrumSize}px`);
  const spectrumHeight = subtitle ? 0 : CONFIG.timelineVisualizerEnabled && dashboard ? spectrumSize : 7;
  style.setProperty("--timeline-height", `${spectrumHeight}px`);
  const contentWidth = lyricsEl.clientWidth;
  const currentBlock = currentLineEl.parentElement;
  currentBlock.style.removeProperty("left"); currentBlock.style.removeProperty("right");
  const naturalLeft = currentBlock.getBoundingClientRect().left;
  const offset = alignToDevicePixel(naturalLeft) - naturalLeft;
  const blockStyle = getComputedStyle(currentBlock);
  currentBlock.style.left = `${(Number.parseFloat(blockStyle.left) || 0) + offset}px`;
  currentBlock.style.right = `${(Number.parseFloat(blockStyle.right) || 0) - offset}px`;
  let density = clamp(contentWidth / (dashboard ? 470 : layout === "subtitle" ? 800 : 640), 0.65, 1);
  applyPresentationFontSizes(layout, density);
  const detachedBadgeHeight = layout === "lazer" && !CONFIG.showDebugStatus
    ? song.querySelector(".song-badges").getBoundingClientRect().height : 0;
  const lazerFooterReserve = Math.max(16, detachedBadgeHeight + 8);
  style.setProperty("--lazer-footer-reserve", `${lazerFooterReserve}px`);
  const statusStyle = getComputedStyle(statusEl);
  const footerHeight = statusEl.getBoundingClientRect().height + (Number.parseFloat(statusStyle.marginTop) || 0);
  const songStyle = getComputedStyle(song);
  const headerHeight = dashboard || subtitle ? 0 : song.getBoundingClientRect().height + (Number.parseFloat(songStyle.marginBottom) || 0);
  const preferredLyricsHeight = clamp(Number(CONFIG.lyricsHeightPx), 132, 620);
  const autoHeight = preferredLyricsHeight + paddingSize * 2 + footerHeight + headerHeight
    + (layout === "lazer" ? lazerFooterReserve : subtitle ? 0 : spectrumHeight + 24);
  const requestedHeight = Number(CONFIG.overlayHeightPx) > 0 ? clamp(Number(CONFIG.overlayHeightPx), 160, 1600) : autoHeight;
  const panelHeight = Math.round(Math.min(requestedHeight, Math.max(80, window.innerHeight - 32)));
  style.setProperty("--panel-height", `${panelHeight}px`);
  if (layout === "lazer" && !CONFIG.showDebugStatus) {
    const badges = song.querySelector(".song-badges");
    const top = overlayEl.getBoundingClientRect().bottom - paddingSize - 1
      - badges.getBoundingClientRect().height - song.getBoundingClientRect().top;
    style.setProperty("--lazer-badge-top", `${top}px`);
  }

  // Left-column geometry is a property of the panel and song header, not
  // of the currently active lyric, translation or surrounding sentences.
  if (dashboard) {
    const timeRect = currentTimeEl.getBoundingClientRect();
    const footerSize = Math.max(spectrumHeight, Math.ceil(timeRect.height));
    style.setProperty("--timestamp-width", `${Math.ceil(timeRect.width)}px`);
    style.setProperty("--dashboard-footer-height", `${footerSize}px`);
    style.setProperty("--timestamp-bottom", `${(footerSize - timeRect.height) / 2}px`);
    const songRect = song.getBoundingClientRect();
    const badges = song.querySelector(".song-badges");
    const footerTop = badges.getBoundingClientRect().height > 0
      ? badges.getBoundingClientRect().top - songRect.top : songRect.height;
    const titleLineHeight = Number.parseFloat(getComputedStyle(titleTailEl).lineHeight) || 27;
    style.setProperty("--dashboard-header-max-height", `${Math.max(titleLineHeight, Math.floor(footerTop * 0.36))}px`);
    layoutDashboardSongHeader();
    const headerBottom = songCopyEl.getBoundingClientRect().bottom - songRect.top;
    const iconCenter = (headerBottom + footerTop) / 2;
    const inset = Number.parseFloat(songStyle.paddingRight) || 0;
    const requestedSize = Number(CONFIG.dashboardSongIconSizePx) > 0 ? clamp(Number(CONFIG.dashboardSongIconSizePx), 64, 320) : 320;
    const coverHeight = Math.max(0, footerTop - headerBottom - 16);
    const iconSize = Math.max(0, Math.floor(Math.min(requestedSize, Math.max(0, song.clientWidth - inset - 8), coverHeight) / 2) * 2);
    icon.style.borderWidth = iconSize > 0 ? "1px" : "0px";
    style.setProperty("--dashboard-icon-display-size", `${iconSize}px`);
    style.setProperty("--dashboard-icon-top", `${iconCenter - iconSize / 2}px`);
    style.setProperty("--dashboard-icon-left", `${Math.round((song.clientWidth - inset - iconSize) / 2)}px`);
  }

  // Shrink rendered text only when its configured size cannot fit the
  // available viewport. The user's font settings remain unchanged.
  let lyricHeight = lyricsEl.getBoundingClientRect().height;
  const blockHeight = currentLineEl.parentElement.getBoundingClientRect().height;
  const currentBlockFits = () => {
    const block = currentLineEl.parentElement.getBoundingClientRect().height;
    return block <= lyricsEl.clientHeight - 16;
  };
  if (!currentBlockFits() && blockHeight > 0) {
    // Wrapping changes in whole lines; proportional shrinking can make
    // text unnecessarily tiny when two lines become one.
    let low = density * 0.2;
    let high = density;
    for (let pass = 0; pass < 6; pass += 1) {
      const middle = (low + high) / 2;
      applyPresentationFontSizes(layout, middle, dashboard);
      if (currentBlockFits()) low = middle;
      else high = middle;
    }
    applyPresentationFontSizes(layout, low, dashboard);
    lyricHeight = lyricsEl.getBoundingClientRect().height;
  }
  const contextFooterSpace = 0;
  if (autoContext
    && currentLineEl.parentElement.getBoundingClientRect().height > lyricHeight - contextFooterSpace) {
    // At minimum legible sizes, two wrapped source/translation rows may
    // still exceed a very short viewport. Preserve both roles in one row
    // each rather than place the centred group outside the lyric area.
    overlayEl.classList.add("current-group-single-line");
  }
  const currentHeight = currentLineEl.getBoundingClientRect().height;
  const renderedBlockHeight = currentLineEl.parentElement.getBoundingClientRect().height;
  const translationHeight = lyricsEl.classList.contains("no-translation") || currentLineEl.parentElement.classList.contains("lyric-shared-second-row") ? 0
    : translationEl.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(translationEl.parentElement).marginTop) || 0);
  const lyricGap = Number.parseFloat(getComputedStyle(lyricsEl).getPropertyValue("--context-clearance")) || 8;
  const minCenter = currentHeight / 2 + lyricGap;
  const maxCenter = Math.max(minCenter, lyricHeight - currentHeight / 2 - translationHeight - lyricGap);
  lyricsEl.style.setProperty("--context-footer-space", `${contextFooterSpace}px`);
  // The active group belongs to the lyric area above the progress footer.
  // An absent translation contributes no height to that group.
  let center = dashboard || subtitle || autoContext
    ? (lyricHeight - contextFooterSpace - renderedBlockHeight + currentHeight) / 2
    : clamp((lyricHeight - (layout === "lazer" ? translationHeight : 0)) / 2, minCenter, maxCenter);

  // Prefer complete configured context when it fits, instead of leaving
  // spare space above while hiding the second following sentence below.
  const contextHeight = container => {
    const items = [...container.children].filter(element => element.classList.contains("context-line"));
    const gap = Number.parseFloat(getComputedStyle(container).rowGap) || 0;
    for (const element of items) element.hidden = false;
    return items.reduce((sum, element) => sum + element.getBoundingClientRect().height,
      Math.max(0, items.length - 1) * gap);
  };
  // Re-read the natural CSS gap after settings/viewport changes; a
  // bounded adjustment for the preceding rows is applied after fitting.
  beforeLinesEl.style.removeProperty("row-gap");
  if (autoContext) syncAutoContextCandidates();
  const beforeHeight = contextHeight(beforeLinesEl);
  const afterHeight = contextHeight(afterLinesEl);
  const contextMin = minCenter + beforeHeight;
  const contextMax = maxCenter - afterHeight - contextFooterSpace;
  if (!dashboard && !subtitle && !autoContext && contextMin <= contextMax) center = clamp(center, contextMin, contextMax);
  const areaTop = lyricsEl.getBoundingClientRect().top;
  const currentTop = alignToDevicePixel(areaTop + center - currentHeight / 2) - areaTop;
  center = currentTop + currentHeight / 2;
  const beforeSpace = Math.max(0, currentTop - lyricGap);
  lyricsEl.style.setProperty("--before-space", `${beforeSpace}px`);
  lyricsEl.style.setProperty("--current-top", `${currentTop}px`);
  lyricsEl.style.setProperty("--after-top", `${center + currentHeight / 2 + translationHeight + lyricGap}px`);
  if (autoContext) fitAutoContextLines();
  else {
    fitContextLines(beforeLinesEl, true);
    fitContextLines(afterLinesEl, false);
  }
  layoutLyricGradientUnits();
  if (lastRenderedLyricIndex >= 0) updateLyricEllipsisProgress(lyricLines[lastRenderedLyricIndex],
    lyricLines[lastRenderedLyricIndex + 1], effectiveLyricTime(lastLiveTime));
  shell.style.setProperty("--horizontal-timeline-width", `${timeline.getBoundingClientRect().width}px`);
  if (dashboard) {
    const iconRect = icon.getBoundingClientRect();
    icon.title = `Cover ${Math.round(iconRect.width)}px (fits available panel space)`;
  }
}

function fitContextLines(container, before) {
  // Retain the nearest complete lines; never clip half a sentence against
  // the current original/translation when the panel is short.
  const lines = [...container.children].filter(element => element.classList.contains("context-line"));
  const gap = Number.parseFloat(getComputedStyle(container).rowGap) || 0;
  const available = container.clientHeight;
  let used = 0;
  let count = 0;
  for (const line of before ? lines.reverse() : lines) {
    line.hidden = false;
    const height = line.offsetHeight;
    const next = used + height + (count ? gap : 0);
    line.hidden = next > available + 0.5;
    if (!line.hidden) { used = next; count += 1; }
  }
  if (before && CONFIG.lyricLayout === "dashboard" && count > 1) {
    // Leave a little room at the top when possible, without stretching
    // a pair of sentences across a tall panel. The nearest row stays
    // beside the active group and gap growth is capped at five pixels.
    const extraGap = Math.min(5, Math.max(0, available - used - 6) / (count - 1));
    container.style.rowGap = `${gap + extraGap}px`;
  }
}

function syncAutoContextCandidates() {
  if (CONFIG.lyricLayout === "subtitle") return;
  if (loadedLyricsTrackKey !== currentTrackKey || !lyricLines.length) return;
  const beforeFirst = lyricsEl.classList.contains("is-before-first");
  const index = beforeFirst ? Number(currentLineEl.dataset.introIndex) - 1 : lastRenderedLyricIndex;
  const line = lyricLines[index];
  if (!beforeFirst && (!line || currentLineEl.dataset.lyricKey !== `${line.time}|${index}|${line.text}`)) return;
  // Candidate count follows the viewport, with an absolute bound for
  // the maximum panel height. Wrapping can only reduce
  // the number that fits; it cannot make a row shorter than one line.
  const fontSize = Number.parseFloat(getComputedStyle(overlayEl).getPropertyValue("--presentation-context-size")) || 12;
  const limit = Math.min(48, Math.ceil(lyricsEl.clientHeight / (fontSize * 1.24 * 2)) + 1);
  const beforeStart = Math.max(0, index - limit);
  const toView = (item, itemIndex) => ({ key: `${item.time}|${itemIndex}|${item.text}`, text: item.text });
  renderContext(beforeLinesEl, beforeFirst ? [] : lyricLines.slice(beforeStart, index).map((item, offset) => toView(item, beforeStart + offset)));
  renderContext(afterLinesEl, lyricLines.slice(index + 1, index + 1 + limit).map((item, offset) => toView(item, index + 1 + offset)));
}

function chooseAutoContextCounts(beforeCapacity, afterCapacity) {
  const common = Math.min(beforeCapacity, afterCapacity);
  return {
    before: common + (afterCapacity === 0 && beforeCapacity > 0 ? 1 : 0),
    after: common + (afterCapacity > common ? 1 : 0),
  };
}

function fitAutoContextLines() {
  const measure = (container, reverse) => {
    const rows = [...container.children].filter(element => element.classList.contains("context-line"));
    if (reverse) rows.reverse();
    const gap = Number.parseFloat(getComputedStyle(container).rowGap) || 0;
    const available = container.getBoundingClientRect().height;
    const heights = rows.map(row => row.getBoundingClientRect().height);
    let used = 0;
    let capacity = 0;
    for (const height of heights) {
      const next = used + height + (capacity ? gap : 0);
      if (next > available + 0.5) break;
      used = next;
      capacity += 1;
    }
    return { rows, capacity };
  };
  const before = measure(beforeLinesEl, true);
  const after = measure(afterLinesEl, false);
  const counts = chooseAutoContextCounts(before.capacity, after.capacity);
  before.rows.forEach((row, index) => { row.hidden = index >= counts.before; });
  after.rows.forEach((row, index) => { row.hidden = index >= counts.after; });
}

function applyPresentationFontSizes(layout, density, lyricsOnly = false) {
  const base = layout === "subtitle" ? [13, 13, 34, 16] : layout === "dashboard" ? [22, 14, 32, 18] : [24, 14, 32, 18];
  const fields = [
    ["title", base[0], CONFIG.titleFontScale, 12],
    ["artist", base[1], CONFIG.artistFontScale, 10],
    ["lyric", base[2], CONFIG.lyricFontScale, overlayEl.classList.contains("is-short") ? 14 : 16],
    ["context", base[3], CONFIG.contextFontScale, 12],
    ["translation", 18, CONFIG.translationFontScale, 12],
    ["audio-match-badge", 13, CONFIG.audioMatchBadgeFontScale, 8],
    ["offset", 13, CONFIG.offsetFontScale, 8],
    ["time", 13, CONFIG.timeFontScale, 10],
    ["status", 11, CONFIG.statusFontScale, 10],
  ];
  for (const [name, size, scale, minimum] of fields) {
    if (lyricsOnly && !["lyric", "context", "translation"].includes(name)) continue;
    overlayEl.style.setProperty(`--presentation-${name}-size`, `${Math.max(minimum, Math.round(size * clamp(Number(scale), 0.5, 3) * density))}px`);
    const factor = { lyric: 1.2, context: 1.24, translation: 1.25 }[name];
    if (factor) {
      const fontSize = Number.parseFloat(overlayEl.style.getPropertyValue(`--presentation-${name}-size`));
      overlayEl.style.setProperty(`--presentation-${name}-line-height`, `${alignToDevicePixel(fontSize * factor)}px`);
    }
  }
  layoutCurrentLyricRows();
}

function layoutCurrentLyricRows() {
  currentLyricEllipsis = null;
  currentLineEl.querySelectorAll("[data-lyric-ellipsis]").forEach(element => delete element.dataset.lyricEllipsis);
  delete currentLineEl.dataset.lyricEllipsis;
  currentLyricProgressUnits.forEach(unit => unit.element.classList.remove("lyric-elided-unit"));
  const block = currentLineEl.parentElement;
  const main = currentLineEl.querySelector(".lyric-main-row");
  const tail = currentLineEl.querySelector(".lyric-tail-row");
  if (!main || !tail) { block.classList.remove("lyric-shared-second-row"); return; }
  const glyphs = currentLyricProgressUnits;
  const characters = glyphs.map(unit => unit.text);
  const measure = createHeaderTextMeasurer(currentLineEl);
  const width = block.clientWidth;
  // Keep the original's full row width. Only the translation/tail row
  // receives extra breathing room at the dashboard's outer edge.
  const translationInset = CONFIG.lyricLayout === "dashboard" ? Math.round(clamp(width * 0.035, 8, 20)) : 0;
  block.style.setProperty("--shared-translation-inset", `${translationInset}px`);
  const translated = !lyricsEl.classList.contains("no-translation") && Boolean(translationEl.textContent);
  const share = CONFIG.translatedLyricWrapEnabled && CONFIG.lyricLayout !== "subtitle" && translated
    && !overlayEl.classList.contains("current-group-single-line") && width > 0 && measure(characters.join("")) > width;
  block.classList.toggle("lyric-shared-second-row", Boolean(share));
  let count = characters.length;
  if (share) {
    count = Math.max(1, fittingCharacterCount(characters, width - 2, currentLineEl, measure));
    const translationWidth = createHeaderTextMeasurer(translationEl)(translationEl.textContent);
    const gap = 12;
    const secondRowWidth = Math.max(0, width - translationInset);
    // Reserve the translation's natural width first, except for the minimum
    // space needed to show an original tail/ellipsis in extremely narrow UI.
    const minimumTail = Math.min(secondRowWidth * 0.3, measure(characters[count] || "…") + measure("…"));
    const rightWidth = Math.min(translationWidth, Math.max(0, secondRowWidth - gap - minimumTail));
    block.style.setProperty("--shared-translation-width", `${Math.ceil(rightWidth)}px`);
    block.style.setProperty("--shared-tail-width", `${Math.max(0, Math.floor(secondRowWidth - rightWidth - gap))}px`);
    const originalHeight = Number.parseFloat(getComputedStyle(currentLineEl).lineHeight) || 24;
    const translatedHeight = Number.parseFloat(getComputedStyle(translationEl).lineHeight) || 18;
    block.style.setProperty("--shared-row-height", `${Math.ceil(Math.max(originalHeight, translatedHeight))}px`);
    block.style.setProperty("--shared-translation-bottom", "0px");
  }
  // Move existing glyphs rather than rebuild them; full text, timings and
  // progress steps survive resize, translation updates and shape changes.
  if (main.childNodes.length !== count || tail.childNodes.length !== characters.length - count) {
    const first = document.createDocumentFragment(), last = document.createDocumentFragment();
    glyphs.forEach((unit, index) => (index < count ? first : last).appendChild(unit.element));
    main.replaceChildren(first); tail.replaceChildren(last);
  }
  if (share && glyphs[count]) {
    // Align actual text bottoms rather than equally sized boxes: the
    // original and translation deliberately use different font sizes.
    const range = document.createRange(); range.selectNodeContents(translationEl);
    const offset = range.getBoundingClientRect().bottom - glyphs[count].element.getBoundingClientRect().bottom;
    block.style.setProperty("--shared-translation-bottom", `${offset}px`);
  }
  const target = share ? tail : getComputedStyle(currentLineEl).whiteSpace === "nowrap" ? currentLineEl : null;
  const start = share ? count : 0;
  if (target && target.clientWidth > 0 && measure(characters.slice(start).join("")) > target.clientWidth + 0.5) {
    const visible = fittingCharacterCount(characters.slice(start), Math.max(0, target.clientWidth - measure("…") - 2), currentLineEl, measure);
    const index = start + visible;
    target.dataset.lyricEllipsis = "";
    target.style.setProperty("--ellipsis-opacity", CONFIG.lyricProgressEnabled ? String(CONFIG.lyricProgressUnplayedOpacity) : "1");
    glyphs.slice(index).forEach(unit => unit.element.classList.add("lyric-elided-unit"));
    currentLyricEllipsis = { element: target, index };
    lastLyricProgressRenderAt = 0;
  }
}

function layoutLyricGradientUnits() {
  if (!CONFIG.lyricColorGradientEnabled || !currentLyricProgressUnits.length) return;
  const rect = currentLineEl.getBoundingClientRect();
  const positions = currentLyricProgressUnits.map(unit => unit.element.getBoundingClientRect().left - rect.left);
  currentLineEl.style.setProperty("--lyric-gradient-width", `${rect.width}px`);
  currentLyricProgressUnits.forEach((unit, index) => unit.element.style.setProperty("--lyric-gradient-x", `${-positions[index]}px`));
}

function updateSongHeaderFromLatestPayload() {
  if (!latestTrackPayload) return;
  const info = trackInfoFromPayload(latestTrackPayload);
  updateSongHeader(info.rawTitle, info.rawArtist);
}
