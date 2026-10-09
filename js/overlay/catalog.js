// Provider search/lyric adapters, candidate ranking and existing song-result storage.
// Same-set reuse stays in the bounded session store; this adds no persistent cache.

function sameSongSetReuseKey(beatmap = {}) {
  if (!CONFIG.reuseSameSongSet || isPackBeatmap(beatmap)) return "";
  const audio = safeText(
    beatmap.audio
    || beatmap.audioFile
    || beatmap.audioFilename
    || beatmap.files?.audio
    || beatmap.files?.mp3
    || beatmap.path?.audio
    || beatmap.path?.mp3,
  ).replaceAll("\\", "/").toLowerCase();
  const setId = beatmapSetId(beatmap);
  if (setId) {
    // Different difficulties in one set can point at different MP3 files.
    // Reuse only when the audio identity is known to be the same; otherwise
    // keep the result scoped to this difficulty and let audio matching run.
    return audio
      ? `set:${setId}:audio:${audio}`
      : `set:${setId}:difficulty:${beatmapDifficultyId(beatmap) || "unknown"}`;
  }

  const folder = safeText(
    beatmap.path?.folder
    || beatmap.folders?.beatmap
    || beatmap.files?.folder
    || beatmap.folder,
  );
  if (folder) return `folder:${folder}`;

  if (audio) return `audio:${audio}`;

  const mapPath = safeText(beatmap.path?.full || beatmap.filename || beatmap.file || beatmap.files?.osu);
  const parentPath = mapPath.replace(/[\\/][^\\/]+$/, "");
  if (parentPath) return `folder:${parentPath}`;

  const title = normalizeForCompare(beatmap.titleUnicode || beatmap.title || "");
  const artist = normalizeForCompare(beatmap.artistUnicode || beatmap.artist || "");
  return title ? `metadata:${artist}::${title}` : "";
}

function rememberSameSongSetResult(beatmap, result) {
  const key = sameSongSetReuseKey(beatmap);
  if (!key || !(result?.providerSongId || result?.neteaseSongId) || !result.lines?.length) return;

  sameSongSetResults.delete(key);
  sameSongSetResults.set(key, {
    ...result,
    lines: result.lines || [],
    translations: result.translations || [],
    reuseBeatmap: { setId: beatmapSetId(beatmap), title: normalizeForCompare(beatmap.titleUnicode || beatmap.title),
      rate: explicitDifficultySpeed(beatmap.version), audioKey: key, duration: Number(beatmap.time?.mp3Length || 0) },
  });
  while (sameSongSetResults.size > 12) {
    sameSongSetResults.delete(sameSongSetResults.keys().next().value);
  }
}

function sameSongSetResult(beatmap) {
  const key = sameSongSetReuseKey(beatmap);
  let saved = key ? sameSongSetResults.get(key) : null;
  if (!saved && key && beatmapSetId(beatmap) && explicitDifficultySpeed(beatmap.version) !== null) {
    // Reuse only this bounded existing result store; packs never enter it.
    const rate = explicitDifficultySpeed(beatmap.version), duration = Number(beatmap.time?.mp3Length || 0);
    saved = [...sameSongSetResults.values()].reverse().find(item => {
      const previous = item.reuseBeatmap;
      if (!previous || previous.setId !== beatmapSetId(beatmap) || previous.rate === null
        || previous.title !== normalizeForCompare(beatmap.titleUnicode || beatmap.title)) return false;
      const expected = previous.duration * previous.rate;
      return !duration || !expected || Math.abs(duration * rate - expected) <= Math.max(1500, expected * 0.015);
    });
  }
  if (!saved) return null;

  sameSongSetResults.delete(key);
  sameSongSetResults.set(key, saved);
  while (sameSongSetResults.size > 12) sameSongSetResults.delete(sameSongSetResults.keys().next().value);
  const savedMatchStartMs = Number(saved.audioMatchStartTimeMs);
  const savedSampleStartMs = Number(saved.audioMatchSampleStartMs);
  const currentMatchSpeed = resolvedLyricSpeed(beatmap, { neteaseBpm: saved.neteaseBpm });
  const savedMatchSpeed = Number(saved.audioMatchSpeed);
  const matchSpeedChanged = Boolean(
    saved.audioMatchSource
    && Number.isFinite(savedMatchSpeed)
    && savedMatchSpeed > 0
    && Number.isFinite(currentMatchSpeed)
    && Math.abs(savedMatchSpeed - currentMatchSpeed) >= 0.01,
  );
  // An explicit sibling rate can reuse the song identity immediately.
  // Unmarked rate changes still need fresh matching; B rechecks reused audio.
  if (matchSpeedChanged && explicitDifficultySpeed(beatmap.version) === null) return null;
  const changedAudio = saved.reuseBeatmap?.audioKey && saved.reuseBeatmap.audioKey !== key;
  const canRemapAudioOffset = saved.audioMatchSource
    && saved.audioMatchStartTimeMs !== null
    && saved.audioMatchStartTimeMs !== undefined
    && saved.audioMatchSampleStartMs !== null
    && saved.audioMatchSampleStartMs !== undefined
    && Number.isFinite(savedMatchStartMs)
    && Number.isFinite(savedSampleStartMs)
    && savedMatchStartMs >= 0
    && savedSampleStartMs >= 0
    && Number.isFinite(currentMatchSpeed)
    && currentMatchSpeed > 0;
  const remappedOffset = canRemapAudioOffset && !changedAudio
    ? Math.round(savedMatchStartMs - savedSampleStartMs * currentMatchSpeed)
    : parseNumber(saved.lyricOffsetMs, 0);
  return {
    ...saved,
    lines: saved.lines || [],
    translations: saved.translations || [],
    source: `set reuse ${saved.providerSongId || saved.neteaseSongId}`,
    sameSongSetReuse: true,
    audioMatchConfidence: changedAudio || matchSpeedChanged ? null : saved.audioMatchConfidence,
    // startTime is on the source-song timeline while sampleStart is on the
    // current beatmap audio timeline. Rebuild the fixed offset when a
    // sibling difficulty uses another rate; carrying the old offset alone
    // makes the first difficulty work and later rate variants drift.
    lyricOffsetMs: canRemapAudioOffset && audioMatchOffsetInRange(remappedOffset)
      ? remappedOffset
      : parseNumber(saved.lyricOffsetMs, 0),
    // The source match may have been made for another difficulty. Keep the
    // song identity and lyric timestamps, but do not carry over its
    // difficulty-specific rate or segmented alignment anchors.
    audioMatchSpeed: 1,
    audioMatchAlignmentAnchors: [],
    speedMultiplier: 1,
  };
}

function trackKeys(title, artist, beatmap = {}) {
  const checksum = safeText(beatmap.checksum);
  const difficultyId = beatmapDifficultyId(beatmap);
  const setId = beatmapSetId(beatmap);
  return uniqueStrings([
    difficultyId && `beatmap:${difficultyId}`,
    setId && `set:${setId}`,
    checksum,
    `${normalizeForCompare(artist)}::${normalizeForCompare(title)}`,
    normalizeForCompare(title),
  ].filter(Boolean));
}

function strictTrackKeys(beatmap = {}) {
  const checksum = safeText(beatmap.checksum);
  const difficultyId = beatmapDifficultyId(beatmap);

  return uniqueStrings([
    difficultyId && `beatmap:${difficultyId}`,
    checksum,
  ].filter(Boolean));
}

function trackIdentityKey(beatmap = {}, title = "", artist = "") {
  const metadata = beatmap.metadata || {};
  const files = beatmap.files || {};
  const pathInfo = beatmap.path || {};
  const folders = beatmap.folders || {};

  return uniqueStrings([
    ...strictTrackKeys(beatmap),
    beatmapSetId(beatmap) && `set:${beatmapSetId(beatmap)}`,
    safeText(beatmap.audio || beatmap.audioFile || beatmap.audioFilename || files.audio || files.mp3),
    safeText(beatmap.filename || beatmap.file || files.osu || pathInfo.file || pathInfo.full),
    safeText(pathInfo.audio || pathInfo.mp3 || pathInfo.folder || folders.beatmap),
    normalizeForCompare(artist),
    normalizeForCompare(title),
    safeText(beatmap.version || metadata.version || metadata.difficulty),
  ].filter(Boolean)).join("::");
}

function getSongCacheEntry(title, artist, beatmap) {
  const keys = trackKeys(title, artist, beatmap);
  const tracks = songCacheIndex.tracks || {};

  for (const key of keys) {
    if (!key || !tracks[key]) continue;
    const entry = tracks[key];
    if (key.startsWith("set:") && !entry.manual) continue;
    if (!key.startsWith("beatmap:") && key !== safeText(beatmap.checksum) && !entry.manual) continue;
    return entry;
  }

  return null;
}

function isAutoOffsetEntry(entry) {
  return Boolean(entry?.autoOffsetSource || entry?.audioMatchSource || parseNumber(entry?.autoOffsetMs, 0) !== 0);
}

function audioMatchOffsetInRange(offset) {
  const value = parseNumber(offset, 0);
  return value >= CONFIG.audioMatchMinOffsetMs && value <= CONFIG.audioMatchMaxOffsetMs;
}

function cacheLyricOffset(entry) {
  if (!entry) return 0;
  const offset = parseNumber(entry.lyricOffsetMs, 0);
  if (entry.audioMatchSource) return CONFIG.audioMatchEnabled && audioMatchOffsetInRange(offset) ? offset : 0;
  if (!isAutoOffsetEntry(entry)) return offset;
  return CONFIG.autoOffsetFromFirstObject ? offset : 0;
}

async function writeSongCacheIndex(title, artist, beatmap, result) {
  if (!CONFIG.songCacheWriteEndpoint || !result?.neteaseSongId || !result?.lines?.length) return;

  const keys = strictTrackKeys(beatmap);
  if (!keys.length) return;

  const payload = {
    keys,
    primaryKey: keys[0] || "",
    neteaseSongId: result.neteaseSongId,
    neteaseDurationMs: parseNumber(result.neteaseDurationMs, 0),
    neteaseBpm: parseNumber(result.neteaseBpm, 0),
    title,
    artist,
    beatmapId: beatmapDifficultyId(beatmap),
    beatmapSetId: beatmapSetId(beatmap),
    checksum: beatmap.checksum || "",
    lyricOffsetMs: parseNumber(result.lyricOffsetMs, 0),
    speedMultiplier: parseNumber(result.speedMultiplier, 1),
    autoOffsetMs: parseNumber(result.autoOffsetMs, 0),
    autoOffsetSource: result.autoOffsetSource || "",
    audioMatchSource: result.audioMatchSource || "",
    audioMatchStartTimeMs: parseNumber(result.audioMatchStartTimeMs, 0),
    audioMatchSampleStartMs: parseNumber(result.audioMatchSampleStartMs, 0),
    audioMatchEffectiveSampleStartMs: parseNumber(result.audioMatchEffectiveSampleStartMs, 0),
    audioMatchSpeed: parseNumber(result.audioMatchSpeed, 1),
    audioMatchConfidence: result.audioMatchConfidence || "",
    firstLyricTimeMs: parseNumber(result.firstLyricTimeMs, 0),
    firstObjectTimeMs: parseNumber(result.firstObjectTimeMs, 0),
    source: result.source || "",
  };

  try {
    await requestJson(CONFIG.songCacheWriteEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify(payload),
    });
    if (payload.primaryKey) {
      songCacheIndex.tracks ||= {};
      songCacheIndex.tracks[payload.primaryKey] = payload;
    }
  } catch {
    // Static counters can run without a cache writer.
  }
}

async function loadSongCacheIndex() {
  try {
    const response = await fetch(CONFIG.songCachePath, { cache: "no-store" });
    if (!response.ok) {
      songCacheIndex = {};
      return;
    }
    const cache = await response.json();
    songCacheIndex = cache && typeof cache === "object" ? cache : {};
  } catch {
    songCacheIndex = {};
  }
}

async function loadSongAliases() {
  if (!CONFIG.aliasPath) {
    externalAliases = {};
    return;
  }

  try {
    const response = await fetch(CONFIG.aliasPath, { cache: "no-store" });
    if (!response.ok) {
      externalAliases = {};
      return;
    }
    const aliases = await response.json();
    externalAliases = aliases && typeof aliases === "object" ? aliases : {};
  } catch {
    externalAliases = {};
  }
}

function scoreSong(song, title, artist) {
  const targetTitle = normalizeForCompare(title);
  const targetArtist = normalizeForCompare(artist);
  const targetVariants = titleVariants(title).map(normalizeForCompare).filter(Boolean);
  const songTitle = normalizeForCompare(song.name);
  const songAlbum = normalizeForCompare(song.album?.name || song.al?.name || "");
  const songArtists = normalizeForCompare((song.artists || song.ar || []).map((item) => item.name).join(" "));

  let score = 0;
  const alternateNames = uniqueStrings([song.alias, song.alia, song.tns, song.transNames]
    .flatMap(value => Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
  if (alternateNames.some(name => targetVariants.some(variant => variant && normalizeForCompare(name) === variant))) score += 68;

  if (songTitle === targetTitle) score += 80;
  else if (songTitle.includes(targetTitle) || targetTitle.includes(songTitle)) score += 45;

  for (const variant of targetVariants) {
    if (songTitle === variant) score += 72;
    else if (songTitle.includes(variant)) score += 52;
    else if (variant.includes(songTitle)) score += 32;
    if (songAlbum.includes(variant)) score += 14;
  }

  if (songArtists === targetArtist) score += 50;
  else if (songArtists.includes(targetArtist) || targetArtist.includes(songArtists)) score += 28;
  else if (!targetArtist) score += 8;

  // Edition evidence is a preference, never an artist-name exclusion.
  // Keep long recordings available for unlabelled cuts and TV-size maps.
  const versionMismatch = /\b(?:english|instrumental|karaoke|off\s*vocal|live|remix)\b/i;
  const candidateEdition = String(song.name || "").match(versionMismatch)?.[0]?.toLowerCase();
  if (candidateEdition && !String(title).toLowerCase().includes(candidateEdition)) score -= 24;

  return score;
}

async function searchNeteaseSongs(title, artist, beatmap = {}, options = {}) {
  const titles = searchMetadataTitles(title, beatmap);
  const queries = metadataSearchQueries(titles, artist);
  const byId = new Map();
  let lastError = null;

  let completedQueries = 0;
  const deadline = Date.now() + (options.searchBudgetMs || 12000);
  for (const keywords of queries) {
    for (const endpoint of CONFIG.searchEndpoints) {
      if (Date.now() >= deadline) break;
      try {
        const data = await fetchJson(endpoint, {
          keywords,
          limit: String(CONFIG.searchLimit),
          type: "1",
        }, options);

        const songs = data.result?.songs || [];
        for (const song of songs) {
          if (!song?.id || byId.has(song.id)) continue;
          byId.set(song.id, song);
        }
        if (songs.length) break; // The second endpoint is a fallback for this query.
      } catch (error) {
        if (String(error.message).includes("audio match aborted")) throw error;
        lastError = error;
        if (error.kind === "rate_limited") {
          if (!byId.size) throw error;
          break;
        }
        // Continue with the next query or endpoint.
      }
    }
    completedQueries++;
    if (Date.now() >= deadline) break;
    if (completedQueries >= Math.min(queries.length, Math.max(2, titles.length * 2)) && byId.size >= CONFIG.searchLimit) break;
  }

  if (!byId.size && lastError) throw lastError;
  const scored = [...byId.values()]
    .map((song) => ({ song, score: Math.max(...titles.map(name => scoreSong(song, name, artist))) }))
    .sort((a, b) => b.score - a.score);

  return scored.map((item) => item.song);
}

async function loadLyricsBySongId(songId, source, offset = 0, speed = 1, options = {}) {
  let parsed = { lines: [], translations: [], lyricFormat: "" };

  try {
    const data = await fetchJson("/lyric/new", { id: String(songId) }, options);
    parsed = parseNeteaseLyricData(data);
  } catch (error) {
    if (String(error.message).includes("audio match aborted")) throw error;
    // Older API deployments may not expose the enhanced lyric endpoint.
  }

  if (!parsed.lines.length && !parsed.instrumental) {
    const data = await fetchJson("/lyric", { id: String(songId) }, options);
    parsed = parseNeteaseLyricData(data);
  }

  return {
    provider: "netease",
    providerSongId: String(songId),
    neteaseSongId: songId,
    lines: parsed.lines,
    translations: parsed.translations,
    source,
    lyricFormat: parsed.lyricFormat,
    instrumental: parsed.instrumental,
    lyricOffsetMs: offset,
    speedMultiplier: speed,
  };
}

async function loadLyricsByAudioMatchResult(title, artist, match) {
  const song = match.song;
  const provider = song.provider || "netease";
  const result = match.prefetchedLyrics ? { ...match.prefetchedLyrics } : provider === "qq" ? await loadQqLyricsBySong(song) : await loadLyricsBySongId(
    song.id,
    `audio match ${song.id}: ${song.name || title}`,
    match.offsetMs,
    1
  );
  result.lyricOffsetMs = match.offsetMs;
  result.speedMultiplier = 1;

  result.neteaseSongTitle = song.name || title;
  result.neteaseSongArtist = (song.artists || song.ar || []).map((item) => item?.name).filter(Boolean).join("/") || artist;
  result.neteaseDurationMs = parseNumber(song.dt || song.duration || song.durationMs, 0);
  result.neteaseBpm = neteaseSongBpm(song);
  result.audioMatchSource = match.alignmentMode === "reference"
    ? `${provider} reference audio alignment`
    : "netease audio match";
  result.audioMatchStartTimeMs = match.startTimeMs;
  result.audioMatchSampleStartMs = match.sampleStartMs;
  result.audioMatchEffectiveSampleStartMs = match.effectiveSampleStartMs;
  result.audioMatchSpeed = match.speed;
  result.audioMatchAlignmentMode = match.alignmentMode || "fixed";
  result.audioMatchAlignmentAnchors = match.alignmentAnchors || [];
  result.audioMatchDebug = formatAudioMatchDebug(match.debugWindows || [match], match.decision || "selected");
  result.audioMatchConfidence = match.confidence || "";
  result.autoOffsetMs = match.offsetMs;
  result.autoOffsetSource = "netease audio match";
  return result;
}

async function searchQqSongs(title, artist, beatmap = {}, options = {}) {
  const names = searchMetadataTitles(title, beatmap);
  const queries = metadataSearchQueries(names, artist);
  const byId = new Map();
  let lastError;
  let completedQueries = 0;
  const deadline = Date.now() + (options.searchBudgetMs || 12000);
  for (const keywords of queries) {
    if (Date.now() >= deadline) break;
    try {
      const data = await fetchJson("/qq/search", { keywords, limit: String(CONFIG.searchLimit) }, options);
      for (const song of data.result?.songs || []) byId.set(song.id, song);
      completedQueries++;
      if (byId.size && completedQueries >= Math.min(queries.length, Math.max(2, names.length * 2))) break;
    } catch (error) {
      if (String(error.message).includes("audio match aborted")) throw error;
      lastError = error;
      if (error.kind === "rate_limited") break;
    }
  }
  if (!byId.size && lastError) throw lastError;
  return [...byId.values()].sort((a, b) => Math.max(...names.map(name => scoreSong(b, name, artist))) - Math.max(...names.map(name => scoreSong(a, name, artist))));
}

async function loadQqLyricsBySong(song, options = {}) {
  const data = await fetchJson("/qq/lyric", { id: String(song.id), numericId: song.numericId || "" }, options);
  const parsed = parseNeteaseLyricData(data);
  const result = { ...parsed, provider: "qq", providerSongId: String(song.id), providerSong: song,
    neteaseSongId: "", neteaseSongTitle: song.name,
    neteaseSongArtist: (song.artists || []).map(a => a.name).join("/"),
    source: `QQ: ${song.name}`, lyricOffsetMs: 0, speedMultiplier: 1 };
  return !parsed.instrumental && !lyricResultQuality(result).available ? { ...result, lines: [], translations: [] } : result;
}

async function loadQqLyrics(title, artist, beatmap) {
  const candidates = await searchQqSongs(title, artist, beatmap);
  let lastError;
  let bestEmpty;
  for (const song of candidates) {
    try { const result = await loadQqLyricsBySong(song); if (lyricResultQuality(result).available) return result;
      if (!bestEmpty || result.instrumental) bestEmpty = result; }
    catch (error) { if (String(error.message).includes("audio match aborted")) throw error; lastError = error; }
  }
  if (bestEmpty) return { ...bestEmpty, reason: bestEmpty.instrumental ? "QQ instrumental" : "QQ has no synced lyrics" };
  if (lastError) throw lastError;
  return { lines: [], translations: [], provider: "qq", reason: "QQ has no synced lyrics" };
}

function rankSongsByBeatmapDuration(songs, beatmapDurationMs = 0, title = "", artist = "", titles = [title]) {
  const target = Number(beatmapDurationMs) || 0;
  if (target < 30000) return songs;

  return [...songs].sort((left, right) => {
    const durationPenalty = (song) => {
      const duration = parseNumber(song.dt || song.duration || song.durationMs, 0);
      if (duration < 30000) return 0;
      const difference = Math.abs(duration - target);
      // Duration is only a tie-breaker: TV-size and cut maps remain valid.
      return difference <= 9000 ? 0 : Math.min(18, (difference - 9000) / Math.max(1, target) * 35);
    };
    // Keep the metadata match as the primary signal. Duration only resolves
    // close title matches, so a TV-size chart can still select its full-song
    // source instead of being displaced by an unrelated short track.
    const leftScore = Math.max(...titles.map(name => scoreSong(left, name, artist))) - durationPenalty(left);
    const rightScore = Math.max(...titles.map(name => scoreSong(right, name, artist))) - durationPenalty(right);
    return rightScore - leftScore;
  });
}

async function loadNeteaseLyrics(title, artist, beatmapDurationMs = 0, beatmap = {}) {
  const songs = rankSongsByBeatmapDuration(await searchNeteaseSongs(title, artist, beatmap), beatmapDurationMs, title, artist,
    searchMetadataTitles(title, beatmap));
  if (!songs.length) {
    return { lines: [], translations: [], source: "", reason: "no NetEase candidates found" };
  }

  let bestEmpty = null;
  let lastError = null;

  for (const song of songs.slice(0, Math.max(1, CONFIG.searchLimit))) {
    try {
      const loaded = await loadLyricsBySongId(song.id, `${song.name} - ${(song.artists || song.ar || []).map((item) => item.name).join("/")}`);
      const result = {
        neteaseSongId: song.id,
        neteaseSongTitle: song.name || title,
        neteaseSongArtist: (song.artists || song.ar || []).map((item) => item?.name).filter(Boolean).join("/") || artist,
        neteaseDurationMs: parseNumber(song.dt || song.duration || song.durationMs, 0),
        neteaseBpm: neteaseSongBpm(song),
        lines: loaded.lines,
        translations: loaded.translations,
        source: loaded.source,
        lyricFormat: loaded.lyricFormat,
        instrumental: loaded.instrumental,
      };

      if (result.lines.length) {
        return result;
      }

      bestEmpty ||= result;
    } catch (error) {
      if (String(error.message).includes("audio match aborted")) throw error;
      lastError = error;
      // Try another candidate. Some songs have no lyric endpoint result.
    }
  }

  if (bestEmpty) {
    bestEmpty.reason = `candidate has no synced LRC: ${bestEmpty.source || bestEmpty.neteaseSongId || "unknown"}`;
    return bestEmpty;
  }

  if (lastError) throw lastError;
  return { lines: [], translations: [], source: "", reason: "no synced LRC returned by candidates" };
}
