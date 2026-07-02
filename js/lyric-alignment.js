(function () {
  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function valueAt(source, path) {
    let current = source;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object") return null;
      current = current[part];
    }
    return numberOrNull(current);
  }

  function firstNumber(source, paths) {
    for (const path of paths) {
      const value = valueAt(source, path);
      if (value !== null) return value;
    }
    return null;
  }

  function firstObjectTimeFromBeatmap(beatmap = {}, payload = {}) {
    const candidates = [
      "time.firstObject",
      "time.firstHitObject",
      "time.firstHit",
      "time.firstNote",
      "time.start",
      "firstObject",
      "firstObjectTime",
      "firstHitObject",
      "firstHitObjectTime",
      "firstHit",
      "firstNote",
      "objects.first",
      "objects.firstTime",
      "hitObjects.first",
      "hitObjects.firstTime",
      "metadata.firstObject",
      "metadata.firstObjectTime",
    ];

    return firstNumber(beatmap, candidates)
      ?? firstNumber(payload, [
        "beatmap.time.firstObject",
        "beatmap.time.firstHitObject",
        "menu.bm.time.firstObject",
        "menu.bm.time.firstHitObject",
      ]);
  }

  function firstObjectTimeFromOsu(osuText) {
    let inHitObjects = false;
    let answer = null;

    for (const rawLine of String(osuText || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;

      if (line.startsWith("[") && line.endsWith("]")) {
        inHitObjects = line.toLowerCase() === "[hitobjects]";
        continue;
      }

      if (!inHitObjects) continue;

      const parts = line.split(",");
      const time = numberOrNull(parts[2]);
      if (time === null) continue;
      answer = answer === null ? time : Math.min(answer, time);
    }

    return answer;
  }

  function firstLyricTime(lines = []) {
    for (const line of lines) {
      const time = numberOrNull(line?.time);
      if (time !== null && String(line?.text || "").trim()) return time;
    }
    return null;
  }

  function estimateOffset({ lyricLines = [], firstObjectTime = null, speed = 1, maxOffsetMs = 45000, leadMs = 0 } = {}) {
    const lyricTime = firstLyricTime(lyricLines);
    const objectTime = numberOrNull(firstObjectTime);
    const safeSpeed = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1;
    const limit = Math.max(0, Number(maxOffsetMs) || 0);
    const lead = Number.isFinite(Number(leadMs)) ? Number(leadMs) : 0;

    if (lyricTime === null || objectTime === null || !limit) return null;

    const offset = Math.round(lyricTime - objectTime * safeSpeed + lead);
    if (Math.abs(offset) > limit) return null;

    return {
      offset,
      lyricTime,
      firstObjectTime: objectTime,
      speed: safeSpeed,
    };
  }

  window.LyricAlignment = {
    firstObjectTimeFromBeatmap,
    firstObjectTimeFromOsu,
    firstLyricTime,
    estimateOffset,
  };
})();
