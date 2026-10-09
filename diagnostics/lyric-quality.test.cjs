const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), path = require('node:path');
const { functionText } = require('./lib/overlay-source.cjs').createOverlaySource(path.join(__dirname, '../index.html'));
function context(extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, AbortController, CONFIG: { lyricSourcePriority: 'netease-first' },
    currentLyricResult: null, lyricQualityAbortController: null, currentMvSongId: '', lyricLoadToken: 1, currentTrackKey: 'track',
    latestTrackPayload: { key: 'track' }, trackInfoFromPayload: p => p, parseNumber: (x, d) => Number.isFinite(Number(x)) ? Number(x) : d,
    commits: [], commitLyricQualityResult(result) { this.commits.push(result); }, updateMvBackground: async () => {}, ...extra });
  const names = ['safeText', 'normalizeForSearch', 'normalizeForCompare', 'lyricIdentityText', 'lyricContentLines', 'lyricContentTimeline', 'alignLyricContent', 'lyricResultQuality', 'lyricTimelineBridge', 'mapLyricResultToClock', 'preferLyricQuality',
    'resultMvIdentity', 'retainNeteaseMv', 'restoreCandidateLyricRoles', 'associateTranslationLines', 'findLineIndex', 'splitInlineLyricTranslation'];
  vm.runInContext(names.map(functionText).join('\n'), ctx); return ctx;
}
function result(provider, translated = false, shift = 0) {
  const texts = ['君の声が聞こえる', 'いつまでもここで待っている', '夜が明けるまで歩こう', '光は僕たちを包む'];
  const translations = ['我听见你的声音', '一直在这里等候', '走到黎明到来', '光芒包裹着我们'];
  return { provider, providerSongId: provider === 'qq' ? 'qq-fixture' : '123', neteaseSongId: provider === 'netease' ? '123' : '',
    neteaseSongTitle: 'Fixture song', neteaseSongArtist: provider === 'qq' ? '罗马名' : 'Roman name', lyricOffsetMs: 75,
    audioMatchSpeed: 1.15, audioMatchSource: 'verified audio', audioMatchAlignmentAnchors: [{ sampleTimeMs: 1000, offsetMs: 75 }],
    lines: texts.map((text, index) => ({ text, time: index * 10000 + shift,
      words: [{ text, time: index * 10000 + shift, duration: 1000 }],
      translationSegments: translated ? [{ text: translations[index], time: index * 10000 + shift }] : [] })),
    translations: translated ? translations.map((text, index) => ({ text, time: index * 10000 + shift })) : [] };
}
test('a translated alternative wins without changing the verified clock, rate, original role or MV identity', () => {
  const ctx = context(), first = result('netease'), second = result('qq', true, 2000);
  const selected = ctx.preferLyricQuality(first, second);
  assert.equal(selected.provider, 'qq'); assert.equal(selected.neteaseSongId, ''); assert.equal(selected.mvNeteaseSongId, '123');
  assert.deepEqual(Array.from(selected.lines, x => x.time), first.lines.map(x => x.time));
  assert.deepEqual(Array.from(selected.lines, x => x.words[0].time), first.lines.map(x => x.time));
  assert.deepEqual(Array.from(selected.lines, x => x.translationSegments[0].time), first.lines.map(x => x.time));
  assert.equal(selected.audioMatchSpeed, 1.15); assert.equal(selected.lyricOffsetMs, 75);
  assert.equal(second.lines[0].time, 2000, 'provider data is not mutated');
});
test('QQ MV identity can complement a preferred Chinese original without replacing its lyrics or clock', async () => {
  const initial=result('netease');
  const texts=['我们一起追逐光芒','在漫长的夜晚相遇','记得每个温柔瞬间','直到明天依然歌唱'];
  initial.lines=initial.lines.map((line,index)=>({...line,text:texts[index],words:[{...line.words[0],text:texts[index]}]}));
  const other={...initial,provider:'qq',providerSongId:'qq-fixture',neteaseSongId:''};
  let searches=0;const mvs=[];
  const ctx=context({currentLyricResult:initial,CONFIG:{lyricSourcePriority:'netease-first',mvBackgroundEnabled:true,lyricLayout:'dashboard'},
    searchQqSongs:async()=>{searches++;return[{id:'qq-fixture',name:'Fixture song',artists:[]}];},
    loadQqLyricsBySong:async()=>other,
    updateMvBackground:async(id,meta)=>mvs.push({id,qqSongId:meta.qqSongId})});
  vm.runInContext(['findLyricQualityAlternative','refineLyricSourceQuality'].map(functionText).join('\n'),ctx);
  await ctx.refineLyricSourceQuality({title:'Fixture',beatmap:{}},1,'track');
  assert.equal(searches,1);assert.ok(mvs.some(mv=>mv.id==='123'&&mv.qqSongId==='qq-fixture'));
  assert.equal(ctx.commits.length,0);assert.equal(ctx.currentLyricResult,initial);
  assert.equal(ctx.currentLyricResult.lyricOffsetMs,75);assert.equal(ctx.currentLyricResult.lines[0].text,texts[0]);
  assert.equal(ctx.lyricQualityAbortController,null);
  ctx.CONFIG.mvBackgroundEnabled=false;
  await ctx.refineLyricSourceQuality({title:'Fixture',beatmap:{}},1,'track');assert.equal(searches,1);
});

test('when both sources have translations, configurable source priority breaks the tie', () => {
  const ctx = context(), ne = result('netease', true), qq = result('qq', true);
  assert.equal(ctx.preferLyricQuality(ne, qq), ne);
  assert.equal(ctx.preferLyricQuality(qq, ne).provider, 'netease');
  ctx.CONFIG.lyricSourcePriority = 'qq-first';
  assert.equal(ctx.preferLyricQuality(ne, qq).provider, 'qq');
  assert.equal(ctx.preferLyricQuality(qq, ne), qq);
});
test('source preference cannot discard substantially more complete translations', () => {
  const ctx = context(), ne = result('netease', true), qq = result('qq', true);
  ne.lines.slice(1).forEach(line => line.translationSegments = []);
  assert.equal(ctx.preferLyricQuality(qq, ne), qq);
  assert.equal(ctx.preferLyricQuality(ne, qq).provider, 'qq');
});
test('quality upgrades keep the current difficulty rate rather than reusing the previous difficulty audio rate', () => {
  let speedOptions;
  const ctx = context({ resolvedLyricSpeed: (_beatmap, options) => { speedOptions = options; return options.audioMatchSpeed || 1.3; },
    setAudioMatchState: () => {}, updateAudioMatchBadge: () => {}, updateOffsetBadge: () => {}, renderLyrics: () => {},
    latestLiveTimeMs: () => 1000, updateMvBackground: () => {}, setStatus: () => {}, currentAudioMatchState: 'success',
    CONFIG: { lyricSourcePriority: 'netease-first', audioMatchEnabled: true } });
  vm.runInContext(functionText('commitLyricQualityResult'), ctx);
  const first = result('netease'); first.sameSongSetReuse = true; first.speedMultiplier = 1;
  const selected = ctx.preferLyricQuality(first, result('qq', true));
  ctx.commitLyricQualityResult(selected, { beatmap: { version: '1.3x' } }, 'track');
  assert.equal(ctx.currentSpeedMultiplier, 1.3); assert.equal(speedOptions.audioMatchSpeed, null);
  assert.equal(ctx.currentTrackAlignmentAnchors.length, 0);
  const fresh = result('netease'); fresh.speedMultiplier = 1.2;
  ctx.commitLyricQualityResult(fresh, { beatmap: {} }, 'track');
  assert.equal(speedOptions.audioMatchSpeed, 1.15); assert.equal(speedOptions.storedSpeedMultiplier, 1);
});
test('missing lyrics do not outrank usable text; unavailable and instrumental remain different', () => {
  const ctx = context(), ne = result('netease'), empty = { lines: [], translations: [] };
  assert.equal(ctx.preferLyricQuality(ne, empty), ne);
  assert.equal(ctx.preferLyricQuality(empty, ne), ne);
  vm.runInContext(['normalizeForCompare', 'normalizeForSearch', 'parseLrc', 'parseYrc', 'coalesceSimultaneousLyricLines',
    'mergeTranslationLines', 'parseNeteaseLyricData'].map(functionText).join('\n'), ctx);
  const unavailable = ctx.parseNeteaseLyricData({ lrc: { lyric: '[00:00]暂无歌词' } });
  assert.equal(unavailable.lines.length, 0); assert.equal(unavailable.instrumental, false);
  const instrumental = ctx.parseNeteaseLyricData({ lrc: { lyric: '[00:00]纯音乐，请欣赏' } });
  assert.equal(instrumental.lines.length, 0); assert.equal(instrumental.instrumental, true);
});
test('a confirmed instrumental recording cannot be promoted into a vocal edition', () => {
  const ctx = context(), instrumental = { lines: [], instrumental: true, audioMatchSource: 'audio match' };
  assert.equal(ctx.preferLyricQuality(instrumental, result('qq', true)), instrumental);
});
test('an explicit instrumental response does not get overwritten by the legacy fallback endpoint', async () => {
  let requests = 0;
  const ctx = context({ fetchJson: async () => { requests++; return { nolyric: true }; },
    parseNeteaseLyricData: () => ({ lines: [], translations: [], instrumental: true, lyricFormat: 'lrc' }) });
  vm.runInContext(functionText('loadLyricsBySongId'), ctx);
  const loaded = await ctx.loadLyricsBySongId(123, 'fixture');
  assert.equal(requests, 1); assert.equal(loaded.instrumental, true);
});
test('unusable romanization/English alternatives are not scored as displayed Chinese translations', () => {
  const ctx = context(), original = result('netease', true);
  original.lines.forEach(line => line.translationSegments[0].text = 'An English alternative');
  assert.equal(ctx.lyricResultQuality(original).translated, 0);
});
test('language/version mismatches and drifting timestamps need audio verification', () => {
  const ctx = context(), original = result('netease'), foreign = result('qq', true);
  foreign.lines.forEach((x, i) => x.text = ['Different recording', 'English cover vocal', 'Do not replace the source', 'Another lyric edition'][i]);
  assert.equal(ctx.preferLyricQuality(original, foreign), original);
  const drifting = result('qq', true); drifting.lines.forEach((x, i) => x.time += i * 1500);
  assert.equal(ctx.preferLyricQuality(original, drifting), original);
  assert.equal(ctx.lyricTimelineBridge(original, { lines: original.lines.slice(0, 1) }), null);
});
test('B can improve timing while retaining a previously selected, better same-recording lyric stream', () => {
  const ctx = context(), current = result('qq', true, 1500), refined = result('netease');
  refined.lyricOffsetMs = -450; refined.audioMatchSpeed = 1.3;
  const selected = ctx.preferLyricQuality(refined, current);
  assert.equal(selected.provider, 'qq'); assert.equal(selected.lyricOffsetMs, -450); assert.equal(selected.audioMatchSpeed, 1.3);
  assert.equal(selected.lines[0].time, 0); assert.ok(selected.lines[0].translationSegments.length);
});
test('alternate catalogue lookup skips a translation masquerading as original and tries the next candidate', async () => {
  const first = result('netease'); let loads = 0;
  const ctx = context({ searchQqSongs: async () => [{ id: 'wrong', name: 'Song' }, { id: 'correct', name: 'Song' }],
    loadQqLyricsBySong: async song => { loads++; const data = result('qq', true, 2000);
      if (song.id === 'wrong') data.lines.forEach(line => line.text = '不匹配的另一首中文歌'); return data; } });
  vm.runInContext(functionText('findLyricQualityAlternative'), ctx);
  const selected = await ctx.findLyricQualityAlternative(first, { title: 'Song', artist: 'Romaji', beatmap: {} }, new AbortController().signal);
  assert.equal(selected.provider, 'qq'); assert.equal(loads, 2); assert.equal(selected.lines[0].time, 0);
});
test('late catalogue work cannot replace a switched track; abort controller is released', async () => {
  let resolve, committed = false;
  const ctx = context({ currentLyricResult: result('netease'), findLyricQualityAlternative: () => new Promise(r => resolve = r),
    commitLyricQualityResult: () => committed = true });
  vm.runInContext(functionText('refineLyricSourceQuality'), ctx);
  const work = ctx.refineLyricSourceQuality({ beatmap: {} }, 1, 'track');
  ctx.lyricLoadToken = 2; ctx.currentTrackKey = 'next'; ctx.lyricQualityAbortController.abort();
  resolve(result('qq', true)); await work;
  assert.equal(committed, false); assert.equal(ctx.lyricQualityAbortController, null);
});
test('a racing B result remains authoritative; unrelated old MV/lyrics cannot be committed', async () => {
  let resolve, committed = false, videos = 0;
  const initial = result('netease'), candidate = result('qq', true);
  const ctx = context({ currentLyricResult: initial, findLyricQualityAlternative: () => new Promise(r => resolve = r),
    commitLyricQualityResult: () => committed = true, updateMvBackground: () => videos++ });
  vm.runInContext(functionText('refineLyricSourceQuality'), ctx);
  const work = ctx.refineLyricSourceQuality({ beatmap: {} }, 1, 'track');
  const other = result('qq'); other.lines.forEach((x, i) => x.text = `A different verified recording number ${i}`);
  ctx.currentLyricResult = other; resolve({ ...candidate, mvNeteaseSongId: 'old-mv' }); await work;
  assert.equal(committed, false); assert.equal(videos, 0); assert.equal(ctx.lyricQualityAbortController, null);
});
test('both translated providers are compared in the background; single-provider modes still do not query the other source', async () => {
  let requests = 0;
  const ctx = context({ currentLyricResult: result('netease', true), findLyricQualityAlternative: async () => requests++ });
  vm.runInContext(functionText('refineLyricSourceQuality'), ctx);
  await ctx.refineLyricSourceQuality({}, 1, 'track'); assert.equal(requests, 1);
  ctx.currentLyricResult = result('netease'); ctx.CONFIG.lyricSourcePriority = 'netease-only';
  await ctx.refineLyricSourceQuality({}, 1, 'track'); assert.equal(requests, 1);
});
test('volume labels identify packs regardless of case without matching ordinary words', () => {
  const ctx = context(); vm.runInContext(functionText('isPackTitle'), ctx);
  for (const name of ['Anime vol.1', 'Song VOL.2', 'Vol.123', 'Tracks VoL. 10']) assert.equal(ctx.isPackTitle(name), true, name);
  for (const name of ['Revolution', 'Evolve', 'Volume of the ocean']) assert.equal(ctx.isPackTitle(name), false, name);
});

function splitResult(provider, translated = true, shift = 0) {
  const pieces = ['朝の光を見つけて', '君の声をたどって', '静かな街を歩いて', '空の色を覚えて', '新しい風に触れて', '昨日の夢を抱いて', '遠い星を眺めて', '明日の歌を信じて'];
  const lines = pieces.map((text, index) => ({ time: index * 5000 + shift, text,
    translationSegments: translated ? [{ time: index * 5000 + shift, text: '这是对应的中文译文' }] : [] }));
  return { ...result(provider), lines, translations: [] };
}

function mergedResult(provider, translated = true) {
  const split = splitResult(provider, translated);
  return { ...split, lines: split.lines.filter((_, index) => index % 2 === 0).map((line, index) => {
    const next = split.lines[index * 2 + 1];
    return { ...line, text: line.text + next.text, words: [{ text: line.text, time: line.time, duration: 5000 },
      { text: next.text, time: next.time, duration: 5000 }] };
  }) };
}

test('both translated providers prefer shorter complete sentences over configured provider priority', () => {
  const ctx = context(), merged = mergedResult('netease'), split = splitResult('qq', true, 1700);
  const bridge = ctx.lyricTimelineBridge(merged, split);
  assert.equal(bridge.complete, true); assert.equal(bridge.shift, -1700);
  const selected = ctx.preferLyricQuality(merged, split);
  assert.equal(selected.provider, 'qq'); assert.equal(selected.lines.length, 8);
  assert.equal(selected.lyricOffsetMs, merged.lyricOffsetMs); assert.equal(selected.audioMatchSpeed, merged.audioMatchSpeed);
  assert.equal(selected.mvNeteaseSongId, '123'); assert.equal(selected.lines[1].time, 5000);
  assert.equal(ctx.preferLyricQuality(selected, merged), selected, 'later comparison cannot flip back to longer preferred text');
});

test('shortness cannot discard a currently translated sentence or substitute a shorter untranslated version', () => {
  const ctx = context(), merged = mergedResult('netease'), partial = splitResult('qq');
  partial.lines.at(-1).translationSegments = [];
  assert.equal(ctx.preferLyricQuality(merged, partial), merged);
  assert.equal(ctx.preferLyricQuality(merged, splitResult('qq', false)), merged);
  const missing = splitResult('qq'); missing.lines = missing.lines.slice(0, 3);
  assert.equal(ctx.preferLyricQuality(merged, missing), merged);
});

test('split sentence matching tolerates minor spelling changes while preserving chorus order', () => {
  const ctx = context(), merged = mergedResult('netease'), split = splitResult('qq', true, 2000);
  split.lines[2].text = split.lines[2].text.replace('街', '町');
  const bridge = ctx.lyricTimelineBridge(merged, split);
  assert.equal(bridge.complete, true); assert.equal(bridge.shift, -2000);
  const repeated = mergedResult('netease'); repeated.lines[3] = { ...repeated.lines[0], time: 30000,
    words: repeated.lines[0].words.map(word => ({ ...word, time: word.time + 30000 })) };
  const other = splitResult('qq', true, 2000); other.lines[6] = { ...other.lines[0], time: 32000 }; other.lines[7] = { ...other.lines[1], time: 37000 };
  assert.equal(ctx.lyricTimelineBridge(repeated, other).shift, -2000);
});

test('a split source with growing clock errors is rejected even when all original text matches', () => {
  const ctx = context(), merged = mergedResult('netease'), split = splitResult('qq', true, 2000);
  split.lines.forEach((line, index) => { line.time += index * 2000; });
  assert.equal(ctx.lyricTimelineBridge(merged, split), null);
});

test('placeholder, copyright and credit-only QQ streams never count as available lyrics', async () => {
  const ctx = context({ fetchJson: async () => ({ lrc: { lyric: '[00:00]作词：测试\n[00:01]QQ音乐享有本翻译作品的著作权\n[00:02]暂无歌词' } }) });
  vm.runInContext(['parseLrc', 'parseYrc', 'coalesceSimultaneousLyricLines', 'mergeTranslationLines', 'parseNeteaseLyricData', 'loadQqLyricsBySong'].map(functionText).join('\n'), ctx);
  const candidate = await ctx.loadQqLyricsBySong({ id: 'qq-empty', name: 'Fixture song', artists: [] });
  assert.equal(candidate.lines.length, 0); assert.equal(candidate.instrumental, false);
  assert.equal(ctx.preferLyricQuality(result('netease', true), candidate).provider, 'netease');
});

test('a stale no-lyric flag cannot discard actual timed originals', () => {
  const ctx = context(); vm.runInContext(['parseLrc', 'parseYrc', 'coalesceSimultaneousLyricLines', 'mergeTranslationLines', 'parseNeteaseLyricData'].map(functionText).join('\n'), ctx);
  const candidate = ctx.parseNeteaseLyricData({ nolyric: true, lrc: { lyric: '[00:10]A real original sentence' } });
  assert.equal(candidate.instrumental, false); assert.equal(candidate.lines.length, 1);
  const merged = ctx.parseNeteaseLyricData({ nolyric: true, lrc: { lyric: '[00:00]作词：测试\n[00:00]最初の声が響く' } });
  assert.equal(merged.instrumental, false); assert.equal(merged.lines.length, 1, 'coalesced credit does not conceal actual vocals');
  const genuine = ctx.parseNeteaseLyricData({ nolyric: true, lrc: { lyric: '[00:00]作曲：测试\n[00:01]纯音乐，请欣赏' } });
  assert.equal(genuine.instrumental, true); assert.equal(genuine.lines.length, 0, 'real instrumental flag with credits retains its existing behavior');
});

test('coalesced credits at a vocal timestamp do not hide the first real sentence from quality evaluation', () => {
  const ctx = context(), line = { time: 0, text: '作词：测试\n始まりの歌が聞こえる',
    translationSegments: [{ time: 0, text: '听见最初的歌声' }] };
  const candidate = { provider: 'qq', lines: [line] };
  assert.equal(ctx.lyricResultQuality(candidate).available, true); assert.equal(ctx.lyricResultQuality(candidate).translated, 1);
  assert.equal(ctx.lyricContentLines(candidate)[0].text, '始まりの歌が聞こえる'); assert.equal(candidate.lines[0], line);
});

test('content alignment has a strict temporary-memory bound and does not force an oversized comparison', () => {
  const ctx = context(); assert.equal(ctx.alignLyricContent('a'.repeat(10000), 'a'.repeat(10000)), null);
  assert.equal(ctx.alignLyricContent('an unrelated recording', 'それは別の歌曲です'), null);
});

test('background lookup checks all three bounded candidates before choosing the shorter translated edition', async () => {
  const first = mergedResult('netease', false); let loads = 0;
  const ctx = context({ searchQqSongs: async () => [{ id: 'first', name: 'Fixture' }, { id: 'shorter', name: 'Fixture' }, { id: 'empty', name: 'Fixture' }],
    loadQqLyricsBySong: async song => { loads++; return song.id === 'first' ? mergedResult('qq') : song.id === 'shorter' ? splitResult('qq') : { lines: [], translations: [] }; } });
  vm.runInContext(functionText('findLyricQualityAlternative'), ctx);
  const selected = await ctx.findLyricQualityAlternative(first, { title: 'Fixture', artist: '', beatmap: {} }, new AbortController().signal);
  assert.equal(loads, 3); assert.equal(selected.lines.length, 8);
});
