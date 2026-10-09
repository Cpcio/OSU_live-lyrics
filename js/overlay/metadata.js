// osu! metadata, pack/difficulty cleanup, aliases and search query variants.

const builtInAliases = {
  hakkenshawatashi: ["\u767a\u898b\u8005\u306f\u30ef\u30bf\u30b7"],
  tapimiruhakkenshawatashi: ["\u767a\u898b\u8005\u306f\u30ef\u30bf\u30b7"],
  hakkenshawatashitapimiru: ["\u767a\u898b\u8005\u306f\u30ef\u30bf\u30b7"],
  wodeguozhifenniyiban: ["\u6211\u7684\u679c\u6c41\u5206\u4f60\u4e00\u534a"],
  wodeguozhifenniyibanflowers: ["\u6211\u7684\u679c\u6c41\u5206\u4f60\u4e00\u534a"],
  flowerswodeguozhifenniyiban: ["\u6211\u7684\u679c\u6c41\u5206\u4f60\u4e00\u534a"],
  guozhifenniyiban: ["\u6211\u7684\u679c\u6c41\u5206\u4f60\u4e00\u534a"],
};

function titleVariants(title) {
  const original = safeText(title);
  const cleaned = normalizeForSearch(original);
  const noParens = original.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*]/g, " ").replace(/\s+/g, " ").trim();
  const beforeDash = original.split(/\s+-\s+|\s+[~]\s+/)[0];

  const noFeatured = cleaned.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, "").trim();
  const noEdition = noFeatured.replace(/\s*(?:\([^)]*(?:tv\s*size|game\s*(?:size|ver(?:sion)?)|short\s*(?:ver(?:sion)?|size)|cut)[^)]*\)|\b(?:tv\s*size|game\s*ver\.?|short\s*ver\.?|cut))\s*$/i, "").trim();
  return uniqueStrings([original, noFeatured, noEdition, cleaned, noParens, beforeDash]);
}

function isPackTitle(title) {
  return /\b(pack|packs|map\s*pack|mappack|mapset|collection|collections|practice|ln\s*feast|favorite\s*song\s*9?|zhong\s*wen\s*die\s*bao\s*#?\s*\d*|jack\s*house'?s|chordjacks?|acg\s*fantasy|malody\s*4k|compilation|anthlogy|anthology|lnex\s*\d+|vol\.\s*\d+)\b/i.test(safeText(title));
}

function isPackBeatmap(beatmap = {}) {
  return isPackTitle(beatmap.titleUnicode || "") || isPackTitle(beatmap.title || "");
}

function difficultyBpmTag(version) {
  const match = safeText(version).match(/[\[\u3010]\s*(\d{2,3})\s*[\]\u3011]/);
  const bpm = Number(match?.[1]);
  return Number.isFinite(bpm) && bpm >= 60 && bpm <= 400 ? bpm : 0;
}

function neteaseSongBpm(song = {}) {
  const bpm = Number(song.bpm || song.tempo || song.metadata?.bpm || 0);
  return Number.isFinite(bpm) && bpm >= 40 && bpm <= 500 ? bpm : 0;
}

function bpmDifficultyMultiplier(beatmap = {}, neteaseBpm = 0) {
  if (!CONFIG.bpmTagAudioMatchEnabled || isPackBeatmap(beatmap)) return 1;
  const taggedBpm = difficultyBpmTag(beatmap.version);
  const sourceBpm = Number(neteaseBpm);
  if (!taggedBpm || !Number.isFinite(sourceBpm) || sourceBpm <= 0) return 1;
  return clamp(taggedBpm / sourceBpm, 0.5, 2.5);
}

function stripBracketedText(value) {
  return safeText(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\u3010[^\u3011]*\u3011/g, " ")
    .replace(/\uFF08[^\uFF09]*\uFF09/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeDifficultyDecorations(value) {
  return safeText(value)
    .replace(/^\s*(?:easy|normal|hard|insane|expert|extra|extreme|master|lunatic|another|hyper|append|challenge|collab|marathon|finale)\s*[:\uFF1A-]\s*/i, "")
    .replace(/^\s*\d+\s*[:\uFF1A).-]\s*/, "")
    .replace(/\b(?:\d+(?:\.\d+)?\s*x|x\s*\d+(?:\.\d+)?)\b/gi, " ")
    .replace(/(?:^|\s|[\[（(])\d{2,3}(?:[.,]\d+)?\s*[%％]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeMapperSuffix(value) {
  return safeText(value)
    .replace(/\s+(?:mapped\s+)?by\s+[^-~|/]+$/i, "")
    .replace(/\s+[~]\s+[^-~|/]+$/i, "")
    .replace(/\s*[-\u2013\u2014]\s*(?:mapped\s+)?by\s+.+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeArtistTitle(value) {
  const text = safeText(value);
  if (!text || text.length > 220) return false;
  return /^.{1,90}?\s*[-\u2013\u2014\uff0d]\s*.{1,130}$/.test(text);
}

function removeMapperPrefix(value) {
  const text = safeText(value);
  const parts = text.split(/\s*\/\/\s*/).map(safeText).filter(Boolean);
  if (parts.length < 2) return text;

  const left = parts[0];
  const right = parts.slice(1).join(" // ").trim();
  const leftLooksSong = looksLikeArtistTitle(left);
  const rightLooksSong = looksLikeArtistTitle(right);

  if (leftLooksSong && !rightLooksSong) return left;
  if (rightLooksSong && !leftLooksSong) return right;
  if (rightLooksSong) return right;

  return right.length >= left.length ? right : left;
}

function mergedAliases() {
  return { ...builtInAliases, ...(externalAliases || {}) };
}

function aliasLookupKeys(title, artist) {
  const baseValues = [
    title,
    `${title}${artist}`,
    `${artist}${title}`,
  ];
  const keys = [];

  for (const value of baseValues) {
    const normalized = normalizeForCompare(value);
    if (!normalized) continue;

    keys.push(normalized);
    const tokens = normalizeForSearch(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const withoutParticles = tokens
      .filter((token) => !["wa", "ha", "no", "wo", "o", "ni", "de", "to", "ga", "e"].includes(token))
      .join("");
    if (withoutParticles) keys.push(withoutParticles);
  }

  return uniqueStrings(keys);
}

function aliasVariants(title, artist) {
  const aliasesByKey = mergedAliases();
  const keys = aliasLookupKeys(title, artist);
  const aliases = [];

  for (const key of keys) {
    if (aliasesByKey[key]) aliases.push(...aliasesByKey[key]);
  }

  return uniqueStrings(aliases);
}

function parseArtistTitle(value) {
  const text = safeText(value);
  const match = text.match(/^(.{1,80}?)\s*[-\u2013\u2014]\s*(.{1,120})$/);
  if (!match) return null;

  const artist = safeText(match[1]);
  const title = safeText(match[2]);
  if (!artist || !title) return null;

  return { title, artist };
}

function beatmapMetadata(payload = {}) {
  const beatmap = payload.beatmap || payload.menu?.bm || payload.menu?.beatmap || {};
  const metadata = beatmap.metadata || payload.menu?.bm?.metadata || {};

  return {
    ...beatmap,
    titleUnicode: beatmap.titleUnicode || beatmap.titleOriginal || metadata.titleOriginal || metadata.titleUnicode,
    title: beatmap.title || metadata.title || metadata.titleRoman || metadata.titleRomanized,
    artistUnicode: beatmap.artistUnicode || beatmap.artistOriginal || metadata.artistOriginal || metadata.artistUnicode,
    artist: beatmap.artist || metadata.artist || metadata.artistRoman || metadata.artistRomanized,
    version: beatmap.version || beatmap.difficulty || metadata.difficulty || metadata.version,
    checksum: beatmap.checksum || beatmap.md5 || beatmap.hash || metadata.checksum || metadata.md5,
    files: { ...(beatmap.files || {}), audio: beatmap.audio || beatmap.files?.audio || payload.files?.audio,
      osu: beatmap.files?.osu || payload.files?.beatmap },
  };
}

function deriveSearchMetaFromBeatmap(beatmap) {
  const rawTitle = safeText(beatmap.titleUnicode || beatmap.title);
  const rawRomanTitle = safeText(beatmap.title || rawTitle);
  const rawArtist = safeText(beatmap.artistUnicode || beatmap.artist);
  const version = safeText(beatmap.version);

  if (!isPackTitle(rawTitle) && !isPackTitle(rawRomanTitle)) {
    return {
      displayTitle: rawTitle,
      displayArtist: rawArtist,
      searchTitle: rawTitle,
      searchArtist: rawArtist,
      source: "beatmap",
    };
  }

  const cleanedVersion = removeMapperSuffix(removeMapperPrefix(removeDifficultyDecorations(stripBracketedText(version))));
  const parsed = parseArtistTitle(cleanedVersion);
  const searchTitle = parsed?.title || cleanedVersion || rawTitle;
  const searchArtist = parsed?.artist || "";

  return {
    displayTitle: searchTitle,
    displayArtist: searchArtist || rawArtist,
    searchTitle,
    searchArtist,
    source: "difficulty",
  };
}

function trackInfoFromPayload(payload = {}) {
  const beatmap = beatmapMetadata(payload);
  const meta = deriveSearchMetaFromBeatmap(beatmap);
  const searchTitle = meta.searchTitle;
  const searchArtist = meta.searchArtist;

  return {
    beatmap,
    meta,
    rawTitle: meta.displayTitle,
    rawArtist: meta.displayArtist,
    searchTitle,
    searchArtist,
    key: trackIdentityKey(beatmap, searchTitle, searchArtist),
  };
}

function searchQueries(title, artist) {
  const titles = uniqueStrings([...aliasVariants(title, artist), ...titleVariants(title)]);
  const cleanArtist = normalizeForSearch(artist);
  const queries = [];

  for (const item of titles) {
    if (cleanArtist) queries.push(`${item} ${cleanArtist}`);
    queries.push(item);
  }

  return uniqueStrings(queries);
}

function searchMetadataTitles(title, beatmap = {}) {
  return uniqueStrings([title, ...(!isPackBeatmap(beatmap) ? [beatmap.titleUnicode,
    beatmap.metadata?.titleOriginal, beatmap.metadata?.titleUnicode] : [])].filter(Boolean));
}

function metadataSearchQueries(titles, artist) {
  const groups = titles.map(title => searchQueries(title, artist));
  return uniqueStrings([...groups.flatMap(group => group.slice(0, 2)), ...groups.flatMap(group => group.slice(2))]).slice(0, 6);
}

function validOnlineId(value) {
  const text = safeText(value);
  if (!text) return "";

  const number = Number(text);
  if (Number.isFinite(number) && number > 0) return String(Math.trunc(number));

  return "";
}

function firstValidOnlineId(...values) {
  for (const value of values) {
    const id = validOnlineId(value);
    if (id) return id;
  }

  return "";
}

function beatmapDifficultyId(beatmap = {}) {
  return firstValidOnlineId(
    beatmap.id,
    beatmap.beatmapId,
    beatmap.beatmapID,
    beatmap.onlineId,
    beatmap.onlineID,
    beatmap.beatmap_id,
    beatmap.metadata?.beatmapId,
    beatmap.metadata?.beatmapID
  );
}

function beatmapSetId(beatmap = {}) {
  return firstValidOnlineId(
    typeof beatmap.set === "object" ? beatmap.set?.id : beatmap.set,
    beatmap.setId,
    beatmap.setID,
    beatmap.beatmapSetId,
    beatmap.beatmapSetID,
    beatmap.beatmapsetId,
    beatmap.beatmapsetID,
    beatmap.beatmapset_id,
    beatmap.metadata?.beatmapSetId,
    beatmap.metadata?.beatmapsetId
  );
}
