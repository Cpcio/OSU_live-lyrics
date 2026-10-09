const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { Worker: NativeWorker } = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const proxyRoot = path.join(root, fs.existsSync(path.join(root, 'lyrics-proxy/src')) ? 'lyrics-proxy' : 'proxy-source');
const { createOverlaySource } = require('./lib/overlay-source.cjs');
const { functionText } = createOverlaySource(path.join(root, 'index.html'));
function context(values = {}) {
  const ctx = vm.createContext({ console, URL, AbortController, Float32Array, fetch,
    setTimeout, clearTimeout, currentLyricResult: null, lyricQualityAbortController: null, lyricRequestController: null,
    refineLyricSourceQuality() {}, resetMvTrackIdentity() {}, ...values });
  ctx.clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  ctx.parseNumber = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  return ctx;
}
function load(ctx, ...names) {
  if (names.some(name => ['audioMatchCurrentBeatmap', 'audioMatchReferenceBeatmap', 'audioMatchWindowResult'].includes(name))) names.push('audioMatchTask');
  if (names.some(name => ['resolvedLyricSpeed', 'parseSpeedMultiplier', 'sameSongSetResult'].includes(name))) names.push('explicitDifficultySpeed');
  if (names.includes('parseNeteaseLyricData')) names.push('splitInlineLyricTranslation');
  if (names.includes('renderLyrics') && !names.includes('firstSungLyricIndex')) names.push('firstSungLyricIndex');
  if ((names.includes('audioMatchCurrentBeatmap') || names.includes('audioMatchReferenceBeatmap')) && !names.includes('audioMatchConfidence')) names.push('audioMatchConfidence');
  if (names.includes('refineLyricsWithReferenceAudio') && !names.includes('restoreCandidateLyricRoles')) names.push('restoreCandidateLyricRoles');
  if (names.includes('parseNeteaseLyricData') && !names.includes('associateTranslationLines')) names.push('associateTranslationLines');
  if (names.includes('refineLyricsWithReferenceAudio') || names.includes('audioMatchReferenceBeatmap') || names.includes('refreshTrack') || names.includes('loadQqLyricsBySong') || names.includes('loadQqLyrics') || names.includes('renderLyrics')) {
    for (const name of ['safeText', 'normalizeForSearch', 'normalizeForCompare', 'lyricIdentityText', 'lyricContentLines', 'lyricContentTimeline', 'alignLyricContent', 'lyricResultQuality', 'lyricTimelineBridge', 'mapLyricResultToClock', 'canCommitInstrumentalLyrics',
      'preferLyricQuality', 'resultMvIdentity', 'retainNeteaseMv']) if (!names.includes(name)) names.push(name);
  }
  if (names.includes('loadLyricsForTrack') && !names.includes('retainNeteaseMv')) names.push('retainNeteaseMv');
  vm.runInContext(names.map(functionText).join('\n'), ctx);
}

// Execute the actual browser worker entrypoint in a worker thread, including
// its importScripts dependency, rather than replacing the alignment algorithm.
class BrowserWorker {
  static alive = 0;
  constructor() {
    BrowserWorker.alive++;
    this.worker = new NativeWorker(`const {parentPort}=require('node:worker_threads');
      const fs=require('node:fs'),vm=require('node:vm');
      global.self=global;global.postMessage=data=>parentPort.postMessage(data);
      global.importScripts=file=>vm.runInThisContext(fs.readFileSync(${JSON.stringify(path.join(root, 'js'))}+'/'+file,'utf8'));
      const code=fs.readFileSync(${JSON.stringify(path.join(root, 'js/audio-reference-worker.js'))},'utf8')
        .replace("import('./soundtouch.js')", "import("+JSON.stringify(${JSON.stringify(require('node:url').pathToFileURL(path.join(root, 'js/soundtouch.js')).href)})+")");
      new Function(code)();
      parentPort.on('message',data=>global.onmessage({data}));`, { eval: true });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message }));
  }
  postMessage(data, transfers) { this.worker.postMessage(data, transfers); }
  terminate() { if (!this.ended) { this.ended = true; BrowserWorker.alive--; this.worker.terminate(); } }
}

test('response-body timeout remains active until JSON is consumed', async () => {
  let cleared = false;
  const ctx = context({ CONFIG: { fetchTimeoutMs: 4500 }, lyricRequestController: null,
    timeoutSignal: () => ({ done: () => { cleared = true; } }),
    fetch: async () => ({ ok: true, json: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(cleared, false);
      return { code: 200 };
    } }) });
  load(ctx, 'requestJson');
  await ctx.requestJson('http://localhost/test', {});
  assert.equal(cleared, true);
});

test('business errors are rejected instead of becoming empty lyrics', async () => {
  const ctx = context({ CONFIG: { fetchTimeoutMs: 4500 }, lyricRequestController: null,
    timeoutSignal: () => ({ done() {} }), fetch: async () => ({ ok: true, json: async () => ({ code: 405 }) }) });
  load(ctx, 'requestJson');
  await assert.rejects(ctx.requestJson('http://localhost/test', {}), /upstream code 405/);
});

test('upstream cancellation is propagated and never retried', async () => {
  const { upstreamJson, requests } = require(path.join(proxyRoot, 'src/upstream'));
  const previous = global.fetch;
  let calls = 0;
  global.fetch = (_, options) => { calls++; return new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }); };
  try {
    const controller = new AbortController();
    const pending = requests.run({ signal: controller.signal }, () => upstreamJson('https://test.invalid/'));
    controller.abort();
    await assert.rejects(pending, error => error.kind === 'cancelled');
    assert.equal(calls, 1);
  } finally { global.fetch = previous; }
});

test('empty result recovery has three attempts and ignores a switched track', () => {
  const tasks = [];
  const ctx = context({ currentTrackKey: 'a', lyricRetryTimer: 0, lyricRetryKey: '', lyricRetryAttempts: 0,
    lyricLines: [],
    latestTrackPayload: { key: 'a' }, loadedLyricsTrackKey: 'a',
    trackInfoFromPayload: p => p, refreshTrack: () => Promise.resolve(),
    setStatus() {}, setTimeout: (fn, delay) => { tasks.push({ fn, delay }); return tasks.length; } });
  load(ctx, 'scheduleLyricRetry');
  for (let i = 0; i < 4; i++) { ctx.lyricRetryTimer = 0; ctx.scheduleLyricRetry('a'); }
  assert.deepEqual(tasks.map(task => task.delay), [2000, 5000, 10000]);
  ctx.latestTrackPayload = { key: 'b' };
  tasks[0].fn();
  assert.equal(ctx.loadedLyricsTrackKey, 'a');
});

function referenceSignal(seconds) {
  const result = new Float32Array(seconds * 8000);
  for (let i = 0; i < result.length; i++) {
    const t = i / 8000;
    const envelope = .45 + .22 * Math.sin(t * 1.713) + .15 * Math.cos(t * 2.941);
    result[i] = envelope * (.4 * Math.sin(2 * Math.PI * (190 * t + 9 * t * t))
      + .2 * Math.sin(2 * Math.PI * (950 * t - 3 * t * t))
      + .12 * Math.sin(2 * Math.PI * (1800 * t + 13 * Math.sin(t * .36))));
  }
  return result;
}

function referenceContext(source, reference) {
  const buffer = samples => ({ sampleRate: 8000, duration: samples.length / 8000, getChannelData: () => samples });
  const ctx = context({ document: { baseURI: 'http://localhost/index.html' }, Worker: BrowserWorker,
    CONFIG: { audioMatchMultiWindowEnabled: true, audioMatchStartSeconds: -1, audioMatchDurationSeconds: 5,
      audioMatchReferenceCandidateCount: 3, audioMatchConsensusOffsetMs: 200, lyricSourcePriority: 'netease-only' },
    lyricRequestController: new AbortController(), audioMatchAbortController: null,
    searchNeteaseSongs: async () => [{ id: '123', name: 'Fixture' }],
    abortAudioMatchWork() {}, audioMatchSpeed: () => 1, setStatus() {},
    currentBeatmapAudioBuffer: async () => source, fetchArrayBuffer: async () => reference,
    decodeAudioBuffer: async samples => buffer(samples), audioMatchReferenceProxyUrl: () => 'fixture',
    throwIfAudioMatchAborted: signal => { if (signal.aborted) throw Error('audio match aborted'); },
    audioMatchOffsetInRange: () => true,
    audioMatchWindow: (audio) => ({ fraction: .5, actualStartSeconds: audio.duration * .5 - 2.5,
      actualDurationSeconds: 5, targetStartSeconds: audio.duration * .5 - 2.5, targetDurationSeconds: 5 }),
    audioMatchWindowAtFraction: (audio, fraction) => ({ fraction, actualStartSeconds: audio.duration * fraction - 2.5,
      actualDurationSeconds: 5, targetStartSeconds: audio.duration * fraction - 2.5, targetDurationSeconds: 5 }),
    audioMatchSamples: (audio, start, duration) => audio.getChannelData(0).slice(Math.round(start * 8000), Math.round((start + duration) * 8000)) });
  load(ctx, 'safeText', 'normalizeForSearch', 'normalizeForCompare', 'stripBracketedText',
    'audioMatchReferenceCandidateList', 'audioMatchReferenceWindowList', 'referenceAlignmentCluster',
    'alignReferenceInWorker', 'audioMatchReferenceBeatmap');
  return ctx;
}

test('B recovers a cut recording after A failed, through the actual worker', async () => {
  const reference = referenceSignal(48);
  const source = reference.slice(2560 * 8, 2560 * 8 + 32 * 8000);
  const ctx = referenceContext(source, reference);
  const match = await ctx.audioMatchReferenceBeatmap({}, {}, {}, null, new Error('A no result'));
  assert.equal(match.alignmentMode, 'reference');
  assert.ok(Math.abs(match.offsetMs - 2560) <= 128, String(match.offsetMs));
  assert.equal(match.debugWindows.length, 3);
  assert.equal(match.alignmentAnchors.length, 0);
  assert.equal(BrowserWorker.alive, 0);
});

test('B does not promote unavailable audio into a successful refinement', async () => {
  const reference = referenceSignal(15);
  const ctx = referenceContext(reference, reference);
  ctx.fetchArrayBuffer = async () => { throw Error('reference audio HTTP 404'); };
  let cuts=0;ctx.audioMatchSamples=()=>{cuts++;throw Error('unavailable references need no query clips');};
  await assert.rejects(ctx.audioMatchReferenceBeatmap({}, {}, {}, null, new Error('A failed')), /HTTP 404/);
  assert.equal(cuts,0);
  assert.equal(BrowserWorker.alive, 0);
});

test('B restores speed-tagged recordings and runs the optional pitch-preserving branch', async () => {
  const reference = referenceSignal(48);
  const speed = 1.3;
  const offset = 2.56;
  const source = new Float32Array(Math.floor(24 * 8000));
  for (let i = 0; i < source.length; i++) {
    const position = offset * 8000 + i * speed;
    const left = Math.floor(position), fraction = position - left;
    source[i] = reference[left] * (1 - fraction) + reference[left + 1] * fraction;
  }
  const ctx = referenceContext(source, reference);
  ctx.CONFIG.audioMatchPitchPreserving = true;
  ctx.audioMatchSpeed = () => speed;
  const windowAtFraction = (audio, fraction) => {
    const start = audio.duration * fraction - 2.5;
    return { fraction, actualStartSeconds: start, actualDurationSeconds: 5,
      targetStartSeconds: start * speed, targetDurationSeconds: 5 * speed };
  };
  ctx.audioMatchWindowAtFraction = windowAtFraction;
  ctx.audioMatchWindow = audio => windowAtFraction(audio, .5);
  const match = await ctx.audioMatchReferenceBeatmap({}, {}, {}, null, new Error('A failed'));
  assert.equal(match.speed, speed);
  assert.ok(Math.abs(match.offsetMs - offset * 1000) <= 160, String(match.offsetMs));
  assert.equal(BrowserWorker.alive, 0);
});

test('foreground upstream failures do not prevent B recovery from starting', async () => {
  const ctx = context({ CONFIG: { audioMatchMode: 'b', audioMatchEnabled: true, lyricSourcePriority: 'netease-only' },
    bpmAudioMatchContext: async () => null,
    loadLyricsByAudioMatch: async () => { throw Error('A failed'); },
    loadLyricsByMetadata: async () => { throw Error('title service HTTP 500'); }, setStatus() {} });
  load(ctx, 'loadLyricsForTrack');
  const result = await ctx.loadLyricsForTrack('Fixture', 'Artist', {});
  assert.equal(result.lines.length, 0);
  assert.ok(result.audioMatchBackgroundContext);
  assert.equal(result.audioMatchBackgroundContext.coarseError.message, 'A failed');
});

test('a fingerprint recording without lyrics survives metadata fallback as the B reference, without borrowing its offset', async () => {
  const match={song:{id:'recording',name:'Song'},offsetMs:-1378,debugWindows:[{},{},{}]};
  const ctx=context({CONFIG:{audioMatchMode:'b',audioMatchEnabled:true,lyricSourcePriority:'netease-only'},
    bpmAudioMatchContext:async()=>({difficultySpeedMultiplier:1.15}),setStatus(){},
    loadLyricsByAudioMatch:async()=>({lines:[],translations:[],audioMatchBackgroundContext:{title:'Song',artist:'Roman Artist',beatmap:{},
      options:{difficultySpeedMultiplier:1.15},coarseMatch:match}}),
    loadLyricsByMetadata:async()=>({lines:[{time:5000,text:'Available lyric'}],translations:[],neteaseSongId:'lyric-donor',lyricOffsetMs:0})});
  load(ctx,'loadLyricsForTrack');
  const result=await ctx.loadLyricsForTrack('Song','Roman Artist',{});
  assert.equal(result.audioMatchBackgroundContext.coarseMatch,match);
  assert.equal(result.audioMatchBackgroundContext.options.difficultySpeedMultiplier,1.15);
  assert.equal(result.audioMatchBackgroundContext.options.extraCandidates[0].id,'lyric-donor');
  assert.equal(result.lyricOffsetMs,0,'offset belongs to the matched recording, not a different lyric donor');
  ctx.loadLyricsByAudioMatch=async()=>{const error=Error('lyric HTTP 503');error.audioMatchCoarseResult=match;throw error};
  const afterError=await ctx.loadLyricsForTrack('Song','Roman Artist',{});
  assert.equal(afterError.audioMatchBackgroundContext.coarseMatch,match);
});

test('background colour helpers exactly retain the original pre-1.8 treatment',()=>{
  const names=['rgbToHex','blendColor','readableAccent','luminance','saturation','brightenColor','boostSaturation','makeTimelineColor','colorDistance','separateGradientEnds'];
  const ctx=context();load(ctx,...names);
  const previous=context();
  load(previous,...names.filter(name=>!['readableAccent','separateGradientEnds'].includes(name)));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'fixtures/background-colour-pre18.js'),'utf8'),previous);
  for(const [a,b] of [[{r:160,g:160,b:160},{r:160,g:160,b:160}],
    [{r:210,g:25,b:25},{r:210,g:25,b:25}], [{r:20,g:70,b:180},{r:220,g:160,b:30}]]) {
    assert.equal(JSON.stringify(ctx.separateGradientEnds(a,b)),JSON.stringify(previous.separateGradientEnds(a,b)));
    assert.equal(ctx.readableAccent(a),previous.readableAccent(a));
  }
});

test('an unverified high score cannot mask a multi-window usable B candidate', async () => {
  const reference = referenceSignal(48);
  const ctx = referenceContext(referenceSignal(32), reference);
  ctx.searchNeteaseSongs = async () => [{ id: 'bad', name: 'Fixture' }, { id: 'good', name: 'Fixture' }];
  let candidate = 0;
  let sampleCuts = 0;
  const cutSamples = ctx.audioMatchSamples;
  ctx.audioMatchSamples = (...args) => { sampleCuts++; return cutSamples(...args); };
  let firstQueries;
  ctx.alignReferenceInWorker = async (reference, queries) => {
    if (!firstQueries) firstQueries = queries;
    else assert.equal(queries, firstQueries, 'candidate comparisons share this transaction\'s unchanged query clips');
    const windowStarts = [5.5, 13.5, 21.5];
    const offsets = candidate++ === 0 ? [0, 10000, 20000] : [2560, 2560, 2560];
    return offsets.map((offset, i) => ({ startMs: windowStarts[i] * 1000 + offset,
      score: candidate === 1 ? .8 : .72, margin: .03 }));
  };
  const match = await ctx.audioMatchReferenceBeatmap({}, {}, {}, null, new Error('A failed'));
  assert.equal(match.song.id, 'good');
  assert.equal(match.offsetMs, 2560);
  assert.equal(sampleCuts, 3, 'each source window is cut once regardless of candidate count');
});

test('B starts independent provider searches together and never decodes audio after cancellation', async () => {
  const ctx = referenceContext(referenceSignal(15), referenceSignal(20));
  ctx.CONFIG.lyricSourcePriority = 'netease-first';
  const started = [];
  let resolveNetease, resolveQq, sourceReads = 0;
  ctx.searchNeteaseSongs = () => { started.push('netease'); return new Promise(resolve => resolveNetease = resolve); };
  ctx.searchQqSongs = () => { started.push('qq'); return new Promise(resolve => resolveQq = resolve); };
  ctx.currentBeatmapAudioBuffer = async () => { sourceReads++; throw Error('must not read cancelled audio'); };
  const pending = ctx.audioMatchReferenceBeatmap({}, {}, {}, null, new Error('A failed'));
  assert.deepEqual(started, ['netease', 'qq'], 'neither provider waits for the other provider\'s response');
  ctx.lyricRequestController.abort();
  resolveNetease([]); resolveQq([]);
  await assert.rejects(pending, /audio match aborted/);
  assert.equal(sourceReads, 0);
  assert.equal(BrowserWorker.alive, 0);
});

test('A mandatory windows overlap title search while optional early confirmation keeps its original behavior', async () => {
  for(const allWindows of [true,false]) {
    const ctx=referenceContext(referenceSignal(20),referenceSignal(25));
    ctx.CONFIG.audioMatchEnabled=true;ctx.CONFIG.audioMatchAlwaysUseAllWindows=allWindows;
    ctx.GenerateFP=()=>{throw Error('window transport is stubbed for this scheduling test');};
    let resolveTitles;const visited=[];
    ctx.searchNeteaseSongs=()=>new Promise(resolve=>resolveTitles=resolve);
    ctx.audioMatchWindowResult=async(audio,windowInfo)=>{visited.push(windowInfo.fraction);return {
      song:{id:'123'},offsetMs:2560,windowInfo,effectiveSampleStartMs:windowInfo.targetStartSeconds*1000};};
    ctx.selectAudioMatchEntries=entries=>entries;
    load(ctx,'audioMatchConsensus','audioMatchConfidence','audioMatchCurrentBeatmap');
    const pending=ctx.audioMatchCurrentBeatmap({},{});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(visited,allWindows?[.5,.25,.75]:[.5]);
    resolveTitles([{id:'123'}]);const result=await pending;
    assert.equal(result.offsetMs,2560);assert.equal(result.debugWindows.length,allWindows?3:1);
    assert.equal(result.confidence,allWindows?'windows:3/3':'windows:1/3');
  }
});

test('A cannot return a stale full-window result if cancelled while its title search completes', async()=>{
  const ctx=referenceContext(referenceSignal(20),referenceSignal(25));
  ctx.CONFIG.audioMatchEnabled=true;ctx.CONFIG.audioMatchAlwaysUseAllWindows=true;
  ctx.GenerateFP=()=>{throw Error('window transport is stubbed for this scheduling test');};
  let resolveTitles;ctx.searchNeteaseSongs=()=>new Promise(resolve=>resolveTitles=resolve);
  ctx.audioMatchWindowResult=async(audio,windowInfo)=>({song:{id:'123'},offsetMs:2560,windowInfo});
  load(ctx,'audioMatchCurrentBeatmap');
  const pending=ctx.audioMatchCurrentBeatmap({},{});
  await new Promise(resolve=>setImmediate(resolve));ctx.audioMatchAbortController.abort();resolveTitles([{id:'123'}]);
  await assert.rejects(pending,/audio match aborted/);
});

test('repeated metadata leaves split dashboard text untouched while real title/artist changes still update', () => {
  let writes = 0, layouts = 0;
  const element = text => ({ value: text, get textContent() { return this.value; }, set textContent(value) { writes++; this.value = value; } });
  const ctx = context({CONFIG:{songHeaderFormat:'two-line'}, dashboardHeaderTitle:'A long title', dashboardHeaderArtist:'Artist',
    titleEl:element('A long'), artistEl:element('Artist…'), scheduleOverlayLayout:()=>layouts++});
  load(ctx, 'updateSongHeader');
  for(let index=0;index<120;index++)ctx.updateSongHeader('A long title','Artist');
  assert.equal(writes,0);assert.equal(layouts,0);assert.equal(ctx.titleEl.textContent,'A long');
  ctx.updateSongHeader('Next song','Artist');
  assert.equal(ctx.dashboardHeaderTitle,'Next song');assert.equal(layouts,1);
  ctx.updateSongHeader('Next song','New artist');assert.equal(layouts,2);assert.equal(ctx.artistEl.textContent,'New artist');
  ctx.CONFIG.songHeaderFormat='single-line';ctx.updateSongHeader('Next song','New artist');
  assert.equal(ctx.dashboardHeaderTitle,'Next song / New artist');assert.equal(ctx.dashboardHeaderArtist,'');assert.equal(layouts,3);
});

test('worker cancellation releases the worker and rejects old track work', async () => {
  const ctx = referenceContext(referenceSignal(10), referenceSignal(10));
  const controller = new AbortController();
  const pending = ctx.alignReferenceInWorker(referenceSignal(120), [referenceSignal(20)], 1, controller.signal);
  controller.abort();
  await assert.rejects(pending, /audio match aborted/);
  assert.equal(BrowserWorker.alive, 0);
});

test('B result updates displayed lines and timing, and stale results cannot replace them', async () => {
  let rendered = 0;
  const ctx = context({ CONFIG: { audioMatchMode: 'b', audioMatchEnabled: true },
    lyricLoadToken: 4, currentTrackKey: 'a', latestTrackPayload: { key: 'a' },
    trackInfoFromPayload: p => p, lyricLines: [{ time: 0, text: 'old' }],
    translatedLines: [], currentAudioMatchConfidence: null, currentLineEl: {},
    lyricRetryTimer: 0, lyricRetryAttempts: 3,
    audioMatchReferenceBeatmap: async () => ({ alignmentMode: 'reference', offsetMs: 2560 }),
    loadLyricsByAudioMatchResult: async () => ({ lines: [{ time: 5000, text: 'refined' }], translations: [],
      lyricOffsetMs: 2560, audioMatchSpeed: 1, source: 'fixture reference' }),
    rememberSameSongSetResult() {}, resolvedLyricSpeed: () => 1, updateOffsetBadge() {},
    setAudioMatchState() {}, setStatus() {}, latestLiveTimeMs: () => 2440,
    renderLyrics: () => rendered++, requestAnimationFrame: fn => fn(), isRetryableLyricError: () => false,
    updateMvBackground: async () => {}, scheduleLyricRetry() {} });
  load(ctx, 'refineLyricsWithReferenceAudio', 'effectiveLyricTime');
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {}, title: 'fixture' }, 4, 'a');
  assert.equal(ctx.lyricLines[0].text, 'refined');
  assert.equal(ctx.currentTrackOffsetMs, 2560);
  assert.equal(ctx.loadedLyricsTrackKey, 'a');
  assert.ok(rendered >= 1);
  assert.equal(ctx.lyricRetryAttempts, 3, 'same-track success must not reopen the retry budget');
  ctx.CONFIG.lyricOffsetMs = 0;
  assert.equal(ctx.effectiveLyricTime(2440), 5000);
  ctx.lyricLoadToken = 5;
  ctx.lyricLines = [{ text: 'new track' }];
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {} }, 4, 'a');
  assert.equal(ctx.lyricLines[0].text, 'new track');
});

test('QQ foreground uses its own ID and never enters the NetEase MV/song ID slot', async () => {
  const ctx = context({ fetchJson: async () => ({ lrc: { lyric: '[00:01.00]Hello' }, tlyric: { lyric: '[00:01.00]Translation' } }),
    parseNeteaseLyricData: data => ({ lines: [{ time: 1000, text: data.lrc.lyric }], translations: [] }) });
  load(ctx, 'loadQqLyricsBySong');
  const result = await ctx.loadQqLyricsBySong({ id: '003qRXxC4PDLtf', name: 'Song', artists: [] });
  assert.equal(result.provider, 'qq');
  assert.equal(result.providerSongId, '003qRXxC4PDLtf');
  assert.equal(result.neteaseSongId, '');
});

test('B cannot replace established original sentences with their translations, and recovers proven swapped streams', () => {
  const ctx = context({ safeText: v => String(v || '').trim() });
  load(ctx, 'restoreCandidateLyricRoles', 'associateTranslationLines', 'findLineIndex');
  const source = ['ぜんぶ天気のせいでいいよ', 'この気まずさも倦怠感も', '太陽は隠れながら知らんぷり']
    .map((text, i) => ({ time: i * 3000, text }));
  const translated = ['全都怪天气就好', '这份尴尬以及倦怠感', '太阳隐于云层佯装不知']
    .map((text, i) => ({ time: i * 3000, text }));
  assert.equal(ctx.restoreCandidateLyricRoles({ lines: translated, translations: [] }, source, translated), null);
  const recovered = ctx.restoreCandidateLyricRoles({ lines: translated, translations: source, provider: 'qq' }, source, translated);
  assert.deepEqual(Array.from(recovered.lines, line => line.text), source.map(line => line.text));
  assert.deepEqual(Array.from(recovered.lines, line => line.translationSegments[0].text), translated.map(line => line.text));
  const unrelatedChinese = { lines: ['这是新的中文歌曲', '不能根据文字语言排除', '艺术家可能使用罗马字'].map(text => ({ text })), translations: [] };
  assert.equal(ctx.restoreCandidateLyricRoles(unrelatedChinese, source, translated), unrelatedChinese);
  const sameChinese = { lines: translated, translations: [] };
  assert.equal(ctx.restoreCandidateLyricRoles(sameChinese, translated, translated), sameChinese);
  assert.equal(ctx.restoreCandidateLyricRoles(sameChinese, [], []), sameChinese, 'A failure does not block B recovery');
});

test('B role validation retains foreground timing, tries alternatives, and commits a recovered original atomically', async () => {
  const source = ['ぜんぶ天気のせいでいいよ', 'この気まずさも倦怠感も', '太陽は隠れながら知らんぷり']
    .map((text, i) => ({ time: i * 3000, text }));
  const translated = ['全都怪天气就好', '这份尴尬以及倦怠感', '太阳隐于云层佯装不知'].map((text, i) => ({ time: i * 3000, text }));
  let swapped = false, alternatives = false, calls = 0, renders = 0, retries = 0;
  const statuses = [];
  const ctx = context({ CONFIG: { audioMatchMode: 'b', audioMatchEnabled: true }, safeText: v => String(v || '').trim(),
    lyricLoadToken: 1, currentTrackKey: 'a', loadedLyricsTrackKey: 'a', latestTrackPayload: { key: 'a' }, trackInfoFromPayload: p => p,
    lyricLines: source, translatedLines: translated, currentTrackOffsetMs: 45, currentAudioMatchConfidence: '3/4',
    currentLineEl: {}, lyricRetryTimer: 0, setAudioMatchState() {}, setStatus: text => statuses.push(text),
    updateOffsetBadge() {}, rememberSameSongSetResult() {}, resolvedLyricSpeed: () => 1,
    updateMvBackground: async () => {}, latestLiveTimeMs: () => 5000, renderLyrics: () => renders++, requestAnimationFrame: fn => fn(),
    scheduleLyricRetry: () => retries++, isRetryableLyricError: () => false,
    audioMatchReferenceBeatmap: async () => ({ alignmentMode: 'reference', referenceScore: .95,
      referenceAlternatives: alternatives ? [{ alignmentMode: 'reference', useOriginal: true }] : [] }),
    loadLyricsByAudioMatchResult: async (title, artist, match) => {
      calls++;
      return { provider: 'qq', providerSongId: 'candidate', lyricOffsetMs: 2500,
        lines: match.useOriginal ? source : translated, translations: swapped ? source : [] };
    } });
  load(ctx, 'refineLyricsWithReferenceAudio', 'associateTranslationLines', 'findLineIndex');
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {} }, 1, 'a');
  assert.equal(ctx.lyricLines, source);
  assert.equal(ctx.currentTrackOffsetMs, 45, 'rejected replacement must not update timing');
  assert.equal(renders, 0);
  assert.match(statuses.at(-1), /duplicates translation/);
  alternatives = true;
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {} }, 1, 'a');
  assert.equal(calls, 3, 'B tries the next aligned candidate after role rejection');
  assert.equal(ctx.currentTrackOffsetMs, 2500);
  swapped = true; alternatives = false; ctx.translatedLines = translated;
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {} }, 1, 'a');
  assert.deepEqual(Array.from(ctx.lyricLines, line => line.text), source.map(line => line.text));
  assert.deepEqual(Array.from(ctx.translatedLines, line => line.text), translated.map(line => line.text));
  assert.equal(retries, 0, 'content rejection is terminal, not a retry loop');
});

test('split translations advance by time without stacking or borrowing missing neighbors', () => {
  const ctx = context({ CONFIG: { showTranslation: true }, safeText: value => String(value || '').trim(), normalizeForCompare: value => String(value || '').trim(), translatedLines: [] });
  load(ctx, 'parseLrc', 'parseYrc', 'coalesceSimultaneousLyricLines', 'mergeTranslationLines',
    'parseNeteaseLyricData', 'findLineIndex', 'pickTranslation');
  const data = ctx.parseNeteaseLyricData({ lrc: { lyric: '[00:00.00]One\n[00:10.00]Two\n[00:20.00]Three' },
    tlyric: { lyric: '[00:00.00]First part\n[00:04.00]Second part\n[00:20.00]Last' } });
  assert.equal(ctx.pickTranslation(2000, data.lines[0]), 'First part');
  assert.equal(ctx.pickTranslation(8000, data.lines[0]), 'Second part');
  assert.equal(ctx.pickTranslation(12000, data.lines[1]), '');
  assert.equal(ctx.pickTranslation(50000, data.lines[2]), 'Last');
});

test('alternative translation timelines do not get concatenated', () => {
  const ctx = context({ CONFIG: { showTranslation: true }, safeText: String, normalizeForCompare: String });
  load(ctx, 'parseLrc', 'parseYrc', 'coalesceSimultaneousLyricLines', 'mergeTranslationLines', 'parseNeteaseLyricData', 'findLineIndex', 'pickTranslation');
  const result = ctx.parseNeteaseLyricData({ lrc: { lyric: '[00:01.00]One\n[00:10.00]Two' },
    tlyric: { lyric: '[00:01.00]Primary\n[00:10.00]Missing filled' },
    ytlrc: { lyric: '[00:01.00]Alternative\n[00:05.00]Alternative part' } });
  assert.equal(ctx.pickTranslation(5000, result.lines[0]), 'Primary');
  ctx.CONFIG.showTranslation = false;
  assert.equal(ctx.pickTranslation(5000, result.lines[0]), '');
});

test('coarse YRC sentences are split at matching LRC boundaries with word timing retained', () => {
  const ctx = context({ CONFIG: { showTranslation: true }, safeText: String, normalizeForCompare: String });
  load(ctx, 'parseLrc', 'parseYrc', 'coalesceSimultaneousLyricLines', 'mergeTranslationLines', 'parseNeteaseLyricData', 'findLineIndex', 'pickTranslation');
  const result = ctx.parseNeteaseLyricData({ lrc: { lyric: '[00:01.00]One\n[00:05.00]Two' },
    yrc: { lyric: '[1000,8000](1000,1000,0)One(5000,1000,0)Two' },
    tlyric: { lyric: '[00:01.00]First\n[00:05.00]Second' } });
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[1].text, 'Two');
  assert.equal(result.lines[1].words[0].time, 5000);
  assert.equal(ctx.pickTranslation(6000, result.lines[1]), 'Second');
});

test('equal sentence counts with stable independent clocks keep each translation with its source', () => {
  const ctx = context({ CONFIG: { showTranslation: true }, safeText: String });
  load(ctx, 'associateTranslationLines', 'findLineIndex', 'pickTranslation');
  const originals = Array.from({ length: 5 }, (_, i) => ({ time: i * 10000, text: `Source ${i}` }));
  const translated = Array.from({ length: 5 }, (_, i) => ({ time: i * 10000 + 3000, text: `Translation ${i}` }));
  const lines = ctx.associateTranslationLines(originals, translated);
  for (let i = 0; i < lines.length; i++) {
    assert.equal(lines[i].text, originals[i].text);
    assert.equal(ctx.pickTranslation(lines[i].time + 100, lines[i]), translated[i].text);
  }
});

test('an exact timestamp is never stolen by a following sentence less than 700ms away', () => {
  const ctx = context({ CONFIG: { showTranslation: true }, safeText: String });
  load(ctx, 'associateTranslationLines', 'findLineIndex', 'pickTranslation');
  const lines = ctx.associateTranslationLines([{ time: 0, text: 'A' }, { time: 300, text: 'B' }],
    [{ time: 0, text: 'First' }, { time: 300, text: 'Second' }]);
  assert.equal(ctx.pickTranslation(0, lines[0]), 'First');
  assert.equal(ctx.pickTranslation(300, lines[1]), 'Second');
});

test('unique shared words prove sentence order when translation timestamps diverge', () => {
  const ctx = context({ CONFIG: { showTranslation: true }, safeText: String });
  load(ctx, 'associateTranslationLines', 'findLineIndex', 'pickTranslation');
  const source = [{ time: 0, text: 'Source Signal' }, { time: 10000, text: 'Source' }, { time: 50000, text: 'Source Melody' }, { time: 60000, text: 'Source' }];
  const translations = [{ time: 10, text: '译 Signal' }, { time: 15000, text: '译二' }, { time: 20000, text: '译 Melody' }, { time: 35000, text: '译四' }];
  const lines = ctx.associateTranslationLines(source, translations);
  assert.equal(ctx.pickTranslation(10001, lines[1]), '译二');
  assert.equal(ctx.pickTranslation(50001, lines[2]), '译 Melody');
  assert.equal(ctx.pickTranslation(60001, lines[3]), '译四');
});

test('repeated chorus words still prove order when their full occurrence patterns agree', () => {
  const ctx = context({ CONFIG: { showTranslation: true }, safeText: String });
  load(ctx, 'associateTranslationLines', 'findLineIndex', 'pickTranslation');
  const lines = ctx.associateTranslationLines([{ time: 0, text: 'Melody' }, { time: 10000, text: 'Rhythm' }, { time: 50000, text: 'Melody' }, { time: 60000, text: 'Rhythm' }],
    [{ time: 10, text: '译 Melody' }, { time: 15000, text: '译 Rhythm' }, { time: 20000, text: '译 Melody' }, { time: 35000, text: '译 Rhythm' }]);
  assert.equal(ctx.pickTranslation(10001, lines[1]), '译 Rhythm');
  assert.equal(ctx.pickTranslation(50001, lines[2]), '译 Melody');
  assert.equal(ctx.pickTranslation(60001, lines[3]), '译 Rhythm');
});

test('equal counts without timing or shared-word evidence do not force ordinal pairing', () => {
  const ctx = context({ safeText: String });
  load(ctx, 'associateTranslationLines', 'findLineIndex');
  const lines = ctx.associateTranslationLines([{ time: 0, text: 'A' }, { time: 10000, text: 'B' }, { time: 50000, text: 'C' }, { time: 60000, text: 'D' }],
    [{ time: 1000, text: '甲' }, { time: 2000, text: '乙' }, { time: 15000, text: '丙' }, { time: 55000, text: '丁' }]);
  assert.equal(lines[0].translationSegments.length, 2);
  assert.equal(lines[3].translationSegments.length, 0);
});

test('equal counts can still contain split translations and a missing sentence', () => {
  const ctx = context({ safeText: String });
  load(ctx, 'associateTranslationLines', 'findLineIndex');
  const lines = ctx.associateTranslationLines([{ time: 0, text: 'One' }, { time: 10000, text: 'Two' }, { time: 20000, text: 'Three' }, { time: 30000, text: 'Four' }],
    [{ time: 0, text: 'First part' }, { time: 4000, text: 'Second part' }, { time: 20000, text: 'Third' }, { time: 30000, text: 'Fourth' }]);
  assert.equal(lines[0].translationSegments.length, 2);
  assert.equal(lines[1].translationSegments.length, 0);
  assert.equal(lines[2].translationSegments[0].text, 'Third');
});

test('same original sentence refreshes the active translation during playback and seeks', () => {
  let layouts = 0;
  const ctx = context({ CONFIG: { showTranslation: true }, currentTrackKey: 'a', loadedLyricsTrackKey: 'a',
    lyricLines: [{ time: 0, text: 'One', translationSegments: [{ time: 0, text: 'First' }, { time: 4000, text: 'Second' }] }],
    lastRenderedLyricIndex: 0, lyricTransitionTimer: 1, effectiveLyricTime: time => time,
    currentLineEl: { dataset: { lyricKey: '0|0|One', lyricText: 'One' }, textContent: 'One' },
    currentTimeEl: {}, translationEl: { textContent: 'Previous original translation' }, lyricsEl: { classList: { toggle() {}, contains: () => false } },
    formatTime: String, shouldDisplayTranslation: () => true, updateCurrentLineProgress() {},
    flushOverlayLayout: () => layouts++ });
  load(ctx, 'findLineIndex', 'pickTranslation', 'renderLyrics');
  ctx.renderLyrics(5000);
  assert.equal(ctx.translationEl.textContent, 'Second', 'committed original can refresh translation while context fades');
  assert.equal(layouts, 1, 'changed translation is centred in the same transaction');
  ctx.lyricTransitionTimer = 0;
  ctx.renderLyrics(5000);
  assert.equal(ctx.translationEl.textContent, 'Second');
  assert.equal(layouts, 1, 'unchanged translation does not relayout on every packet');
  ctx.renderLyrics(1000);
  assert.equal(ctx.translationEl.textContent, 'First');
  assert.equal(layouts, 2, 'reverse seek to another translation commits its geometry immediately');
});

test('B no-match and unavailable lyrics are terminal; only transient errors schedule a retry', async () => {
  let retries = 0;
  const ctx = context({ CONFIG: { audioMatchMode: 'b', audioMatchEnabled: true },
    lyricLoadToken: 1, currentTrackKey: 'a', latestTrackPayload: { key: 'a' }, trackInfoFromPayload: p => p,
    lyricLines: [], currentAudioMatchConfidence: null, setAudioMatchState() {}, setStatus() {},
    scheduleLyricRetry: () => retries++, audioMatchReferenceBeatmap: async () => null });
  load(ctx, 'isRetryableLyricError', 'refineLyricsWithReferenceAudio');
  const request = { beatmap: {} };
  await ctx.refineLyricsWithReferenceAudio(request, 1, 'a');
  assert.equal(retries, 0);
  ctx.audioMatchReferenceBeatmap = async () => { throw Error('reference alignment inconclusive'); };
  await ctx.refineLyricsWithReferenceAudio(request, 1, 'a');
  assert.equal(retries, 0);
  ctx.audioMatchReferenceBeatmap = async () => ({ alignmentMode: 'reference' });
  ctx.loadLyricsByAudioMatchResult = async () => ({ lines: [] });
  await ctx.refineLyricsWithReferenceAudio(request, 1, 'a');
  assert.equal(retries, 0);
  ctx.audioMatchReferenceBeatmap = async () => { throw Error('fetch failed'); };
  await ctx.refineLyricsWithReferenceAudio(request, 1, 'a');
  assert.equal(retries, 1);
});

test('repeated tosu packets do not restart identification after an empty terminal result', async () => {
  let requests = 0;
  const ctx = context({ currentTrackKey: 'a', loadedLyricsTrackKey: 'a', loadingLyricsTrackKey: '',
    trackInfoFromPayload: () => ({ beatmap: {}, rawTitle: 'Fixture', rawArtist: '', key: 'a' }),
    updateTimelineDuration() {}, updateSongHeader() {}, updateBeatmapColor: async () => {},
    loadLyricsForTrack: async () => { requests++; throw Error('should not be called'); } });
  load(ctx, 'refreshTrack');
  for (let i = 0; i < 100; i++) await ctx.refreshTrack({});
  assert.equal(requests, 0);
});

test('multiple locations from one window cannot pretend to be independent votes', () => {
  const ctx = context({ CONFIG: { audioMatchConsensusOffsetMs: 200 } });
  load(ctx, 'referenceAlignmentCluster');
  const locations = [1000, 1010, 1020].map(offsetMs => ({ offsetMs, score: .9, windowInfo: { fraction: .5 } }));
  assert.equal(ctx.referenceAlignmentCluster(locations).length, 1);
});

test('catalogue search visits Unicode metadata even when the first query returns enough songs', async () => {
  const queries = [];
  const ctx = context({ CONFIG: { searchLimit: 2, searchEndpoints: ['/search'] }, externalAliases: {}, builtInAliases: {},
    fetchJson: async (_, params) => { queries.push(params.keywords); return { result: { songs: [
      { id: 1, name: 'Roman Name', artists: [] }, { id: 2, name: 'Wrong', artists: [] }] } }; } });
  load(ctx, 'safeText', 'normalizeForSearch', 'normalizeForCompare', 'uniqueStrings', 'titleVariants', 'isPackTitle',
    'isPackBeatmap', 'aliasLookupKeys', 'mergedAliases', 'aliasVariants', 'searchQueries', 'searchMetadataTitles',
    'metadataSearchQueries', 'scoreSong', 'searchNeteaseSongs');
  await ctx.searchNeteaseSongs('Roman Name', '', { titleUnicode: '\u98db\u884c\u8247' });
  assert.ok(queries.includes('\u98db\u884c\u8247'));
  assert.ok(ctx.titleVariants('Title feat. Singer').includes('Title'));
});

test('translation names help song ranking without excluding a romanized artist', () => {
  const ctx = context();
  load(ctx, 'safeText', 'normalizeForSearch', 'normalizeForCompare', 'uniqueStrings', 'titleVariants', 'scoreSong');
  const song = { name: 'Original name', tns: ['Romanized Title'], artists: [{ name: '\u6b4c\u624b' }] };
  assert.ok(ctx.scoreSong(song, 'Romanized Title', 'Romaji Artist') > ctx.scoreSong({ name: 'Unrelated', artists: [] }, 'Romanized Title', 'Romaji Artist'));
});

test('QQ and NetEase pure-instrumental markers do not become timed lyric sentences', () => {
  const ctx = context();
  load(ctx, 'safeText', 'normalizeForSearch', 'normalizeForCompare', 'parseLrc', 'parseYrc',
    'coalesceSimultaneousLyricLines', 'mergeTranslationLines', 'parseNeteaseLyricData', 'findLineIndex');
  const parsed = ctx.parseNeteaseLyricData({ lrc: { lyric: '[00:00:00]\u6b64\u6b4c\u66f2\u4e3a\u6ca1\u6709\u586b\u8bcd\u7684\u7eaf\u97f3\u4e50\uff0c\u8bf7\u60a8\u6b23\u8d4f' } });
  assert.equal(parsed.instrumental, true);
  assert.equal(parsed.lines.length, 0);
});

test('high-confidence instrumental refinement can clear wrong foreground lyrics', async () => {
  const ctx = context({ CONFIG: { audioMatchMode: 'b', audioMatchEnabled: true },
    lyricLoadToken: 1, currentTrackKey: 'a', latestTrackPayload: { key: 'a' }, trackInfoFromPayload: p => p,
    lyricLines: [{ text: 'wrong vocals' }], translatedLines: [], currentLineEl: {}, currentAudioMatchConfidence: null,
    lyricRetryTimer: 0, setAudioMatchState() {}, setStatus() {}, updateOffsetBadge() {}, rememberSameSongSetResult() {},
    resolvedLyricSpeed: () => 1, updateMvBackground: async () => {},
    audioMatchReferenceBeatmap: async () => ({ alignmentMode: 'reference', referenceScore: .98, debugWindows: [{}, {}, {}] }),
    loadLyricsByAudioMatchResult: async () => ({ instrumental: true, lines: [], translations: [], lyricOffsetMs: 0 }) });
  load(ctx, 'refineLyricsWithReferenceAudio');
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {} }, 1, 'a');
  assert.equal(ctx.lyricLines.length, 0);
  assert.equal(ctx.currentLineEl.textContent, '\u7eaf\u97f3\u4e50\uff0c\u8bf7\u6b23\u8d4f');
});

test('QQ generic instrumental/no-lyric responses cannot erase an existing NetEase vocal stream', async () => {
  const existing = { provider: 'netease', neteaseSongId: 'existing', lines: [{ time: 1000, text: 'Existing original',
    translationSegments: [{ time: 1000, text: '\u539f\u6709\u7ffb\u8bd1' }] }], translations: [], lyricOffsetMs: 350, audioMatchSource: 'accepted A' };
  let remembered = 0, rendered = 0;
  const statuses = [], ctx = context({ CONFIG: { audioMatchMode: 'b', audioMatchEnabled: true },
    lyricLoadToken: 1, currentTrackKey: 'a', latestTrackPayload: { key: 'a' }, trackInfoFromPayload: p => p,
    currentLyricResult: existing, lyricLines: existing.lines, translatedLines: [], currentLineEl: { textContent: 'Existing original' },
    currentAudioMatchConfidence: 'windows:3/3', lyricRetryTimer: 0, setAudioMatchState() {}, setStatus: text => statuses.push(text), updateOffsetBadge() {},
    rememberSameSongSetResult: () => remembered++, renderLyrics: () => rendered++, resolvedLyricSpeed: () => 1,
    updateMvBackground: async () => {}, audioMatchReferenceBeatmap: async () => ({ alignmentMode: 'reference', referenceScore: .99, debugWindows: [{}, {}, {}] }),
    loadLyricsByAudioMatchResult: async () => ({ provider: 'qq', instrumental: true, lines: [], translations: [], lyricOffsetMs: -2000 }) });
  load(ctx, 'refineLyricsWithReferenceAudio');
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {} }, 1, 'a');
  assert.equal(ctx.currentLyricResult, existing); assert.equal(ctx.lyricLines, existing.lines);
  assert.equal(ctx.currentLineEl.textContent, 'Existing original'); assert.equal(remembered, 0); assert.equal(rendered, 0);
  assert.match(statuses.at(-1), /foreground result retained/);
});

test('B skips empty QQ lyrics and can adopt the next verified NetEase clock without blanking the foreground', async () => {
  const initial = { provider: 'netease', lines: [{ time: 1000, text: 'Existing original' }], translations: [], audioMatchSource: 'accepted A' };
  const matched = { alignmentMode: 'reference', referenceScore: .99, debugWindows: [{}, {}, {}], song: { provider: 'qq', id: 'qq' } };
  const alternative = { ...matched, song: { provider: 'netease', id: 'ne' } };
  const visited = [], ctx = context({ CONFIG: { audioMatchMode: 'b', audioMatchEnabled: true },
    lyricLoadToken: 1, currentTrackKey: 'a', latestTrackPayload: { key: 'a' }, trackInfoFromPayload: p => p,
    currentLyricResult: initial, lyricLines: initial.lines, translatedLines: [], currentLineEl: { textContent: 'Existing original' },
    currentAudioMatchConfidence: 'windows:3/3', lyricRetryTimer: 0, setAudioMatchState() {}, setStatus() {}, updateOffsetBadge() {},
    rememberSameSongSetResult() {}, renderLyrics() {}, latestLiveTimeMs: () => 5000, requestAnimationFrame: fn => fn(),
    resolvedLyricSpeed: () => 1.15, updateMvBackground: async () => {}, audioMatchReferenceBeatmap: async () => ({ ...matched, referenceAlternatives: [alternative] }),
    loadLyricsByAudioMatchResult: async (_title, _artist, candidate) => {
      visited.push(candidate.song.provider);
      return candidate.song.provider === 'qq' ? { provider: 'qq', instrumental: true, lines: [], translations: [] }
        : { provider: 'netease', lines: initial.lines, translations: [], lyricOffsetMs: -325, audioMatchSpeed: 1.15, audioMatchConfidence: 'windows:3/3' };
    } });
  load(ctx, 'refineLyricsWithReferenceAudio');
  await ctx.refineLyricsWithReferenceAudio({ beatmap: {} }, 1, 'a');
  assert.deepEqual(visited, ['qq', 'netease']); assert.equal(ctx.currentProvider, 'netease');
  assert.equal(ctx.currentTrackOffsetMs, -325); assert.equal(ctx.currentSpeedMultiplier, 1.15); assert.equal(ctx.lyricLines.length, 1);
});

test('a paid-song trial is identified as a clip rather than a complete reference recording', async () => {
  const previous = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ code: 200,
    data: [{ url: 'https://test.invalid/trial.mp3', time: 30000, freeTrialInfo: { start: 60000, end: 90000 } }] }) });
  try {
    const { songAudioUrl } = require(path.join(proxyRoot, 'src/netease'));
    const result = await songAudioUrl({ id: 1 });
    assert.equal(result.trial, true);
  } finally { global.fetch = previous; }
});

test('auto context counts balance both sides, prefer the next sentence and handle boundaries without invented lines', () => {
  const ctx = context();
  load(ctx, 'chooseAutoContextCounts');
  for (const [before, after, expected] of [[4, 4, [4, 4]], [4, 6, [4, 5]], [6, 4, [4, 4]],
    [0, 8, [0, 1]], [8, 0, [1, 0]], [0, 0, [0, 0]]]) {
    const result = ctx.chooseAutoContextCounts(before, after);
    assert.deepEqual([result.before, result.after], expected);
  }
});

test('percentage difficulty rates include normal/slower edits and do not treat BPM or level numbers as rates', () => {
  const ctx = context(); load(ctx, 'safeText', 'parseSpeedMultiplier');
  for (const [name, rate] of [['Hard 100%',1], ['95%',.95], ['110%',1.1], ['【125％】',1.25], ['95.5%',.955], ['0.85x',.85], ['x1,15',1.15], ['[195] Hard',1], ['Level 12',1], ['500%',1]]) {
    assert.equal(ctx.parseSpeedMultiplier(name), rate, name);
  }
});

test('explicit 100 percent overrides a BPM-derived or inherited rate', () => {
  const ctx = context({ CONFIG:{speedMultiplier:1,autoSpeedFromDifficulty:true}, bpmDifficultyMultiplier:()=>1.3 });
  load(ctx,'safeText','parseSpeedMultiplier','resolvedLyricSpeed');
  assert.equal(ctx.resolvedLyricSpeed({version:'100%'}),1);
  assert.equal(ctx.resolvedLyricSpeed({version:'Hard'}),1.3);
});

test('tosu top-level audio hashes become the same-set audio identity', () => {
  const ctx = context(); load(ctx,'beatmapMetadata');
  assert.equal(ctx.beatmapMetadata({beatmap:{title:'Song'},files:{audio:'a/hash'}}).files.audio,'a/hash');
});

test('same-song speed edits reuse QQ lyrics, retain source origin and remain bounded; packs and unrelated cuts do not reuse', () => {
  const ctx = context({ CONFIG:{reuseSameSongSet:true,audioMatchMinOffsetMs:-40000,audioMatchMaxOffsetMs:100000}, sameSongSetResults:new Map() });
  load(ctx,'safeText','normalizeForSearch','normalizeForCompare','isPackTitle','isPackBeatmap','validOnlineId','firstValidOnlineId','beatmapSetId','beatmapDifficultyId',
    'sameSongSetReuseKey','rememberSameSongSetResult','sameSongSetResult','parseSpeedMultiplier','audioMatchOffsetInRange');
  ctx.resolvedLyricSpeed = beatmap => ctx.parseSpeedMultiplier(beatmap.version);
  const old = {set:100,title:'Fixture song',version:'1.15x',files:{audio:'old.mp3'},time:{mp3Length:180000/1.15}};
  const result = {provider:'qq',providerSongId:'qqmid',lines:[{time:1000,text:'Source'}],translations:[],audioMatchSource:'accepted',
    audioMatchSpeed:1.15,audioMatchStartTimeMs:11750,audioMatchSampleStartMs:10000,lyricOffsetMs:250,audioMatchConfidence:'windows:3/3'};
  ctx.rememberSameSongSetResult(old,result);
  const next = {...old,version:'130%',files:{audio:'new.mp3'},time:{mp3Length:180000/1.3}};
  const reused = ctx.sameSongSetResult(next);
  assert.equal(reused.providerSongId,'qqmid'); assert.equal(reused.lyricOffsetMs,250); assert.equal(reused.sameSongSetReuse,true);
  assert.equal(reused.audioMatchConfidence,null); assert.equal(reused.audioMatchAlignmentAnchors.length,0);
  assert.equal(ctx.sameSongSetResult({...next,files:{audio:'cut.mp3'},time:{mp3Length:30000}}),null);
  assert.equal(ctx.sameSongSetResult({...next,title:'Fixture Mappack'}),null);
  for(let n=0;n<25;n++) ctx.sameSongSetResult({...next,files:{audio:'variant'+n+'.mp3'}});
  assert.ok(ctx.sameSongSetResults.size<=12);
});

test('a hung audio stage rejects on deadline, aborts promptly and consumes late failures', async () => {
  const ctx = context(); load(ctx,'audioMatchTask');
  await assert.rejects(ctx.audioMatchTask(new Promise(()=>{}),null,5,'fingerprint'), /fingerprint timed out/);
  const controller=new AbortController(); let rejectLate;
  const pending=ctx.audioMatchTask(new Promise((_,reject)=>rejectLate=reject),controller.signal,10000,'decode');
  controller.abort(); await assert.rejects(pending,/audio match aborted/); rejectLate(new Error('late decode'));
  assert.equal(await ctx.audioMatchTask(Promise.resolve('ok'),null,10000,'decode'),'ok');
});

test('cancelled native decoding closes its AudioContext', async () => {
  let closed=0; const controller=new AbortController();
  const ctx=context({window:{AudioContext:class {decodeAudioData(){return new Promise(()=>{});} close(){closed++;}}}});
  load(ctx,'audioMatchTask','decodeAudioBuffer'); const pending=ctx.decodeAudioBuffer(new ArrayBuffer(1),8000,controller.signal);
  controller.abort(); await assert.rejects(pending,/audio match aborted/); assert.equal(closed,1);
});

test('embedded foreign-original/slash/Chinese-translation rows keep only originals and preserve word timing', () => {
  const ctx=context();load(ctx,'safeText','normalizeForSearch','normalizeForCompare','parseLrc','parseYrc','coalesceSimultaneousLyricLines','mergeTranslationLines','associateTranslationLines','findLineIndex','parseNeteaseLyricData');
  const parsed=ctx.parseNeteaseLyricData({lrc:{lyric:'[00:01.00]君の声/你的声音\n[00:05.00]Your voice / 你的话语'}});
  assert.equal(parsed.lines[0].text,'君の声'); assert.equal(parsed.lines[1].text,'Your voice');
  assert.equal(parsed.lines[0].translationSegments[0].text,'你的声音');
  const yrc=ctx.splitInlineLyricTranslation({time:1000,text:'君の声/你的声音',words:[{time:1000,duration:100,text:'君の声'},{time:1100,duration:100,text:'/你的声音'}]});
  assert.equal(yrc.words.length,1); assert.equal(yrc.words[0].time,1000);
  assert.equal(ctx.splitInlineLyricTranslation({text:'AC/DC stays loud'}).text,'AC/DC stays loud');
});

test('embedded translations do not interfere with an independently offset complete translation clock', () => {
  const ctx=context({CONFIG:{showTranslation:true}});
  load(ctx,'safeText','normalizeForSearch','normalizeForCompare','parseLrc','parseYrc','coalesceSimultaneousLyricLines','mergeTranslationLines','associateTranslationLines','findLineIndex','parseNeteaseLyricData','pickTranslation');
  const parsed=ctx.parseNeteaseLyricData({lrc:{lyric:'[00:01]君の声/你的声音\n[00:03]次の空/下一片天空\n[00:05]歩こうよ/我们一起走'},
    tlyric:{lyric:'[00:05]你的声音\n[00:07]下一片天空\n[00:09]我们一起走'}});
  assert.deepEqual(Array.from(parsed.lines,line=>ctx.pickTranslation(line.time,line)),['你的声音','下一片天空','我们一起走']);
});

test('an empty B lyric refresh of the exact foreground recording refines its clock without discarding original/translation', async () => {
  const initial={provider:'netease',providerSongId:'123',neteaseSongId:'123',lines:[{time:1000,text:'Existing original'}],translations:[{time:1000,text:'翻译'}]};
  let state=''; const ctx=context({CONFIG:{audioMatchMode:'b',audioMatchEnabled:true},lyricLoadToken:1,currentTrackKey:'a',latestTrackPayload:{key:'a'},trackInfoFromPayload:p=>p,
    currentLyricResult:initial,lyricLines:initial.lines,translatedLines:initial.translations,currentAudioMatchConfidence:'windows:3/3',lyricRetryTimer:0,
    audioMatchReferenceBeatmap:async()=>({alignmentMode:'reference',song:{id:'123'},referenceScore:.99,debugWindows:[{},{},{}]}),
    loadLyricsByAudioMatchResult:async()=>({provider:'netease',providerSongId:'123',neteaseSongId:'123',lines:[],translations:[],lyricOffsetMs:32,audioMatchSpeed:1,audioMatchSource:'reference'}),
    setAudioMatchState:value=>state=value,setStatus(){},rememberSameSongSetResult(){},resolvedLyricSpeed:()=>1,updateOffsetBadge(){},renderLyrics(){},latestLiveTimeMs:()=>5000,
    requestAnimationFrame:fn=>fn(),updateMvBackground:async()=>{},isRetryableLyricError:()=>false,scheduleLyricRetry(){}});
  load(ctx,'refineLyricsWithReferenceAudio');await ctx.refineLyricsWithReferenceAudio({beatmap:{}},1,'a');
  assert.equal(ctx.currentTrackOffsetMs,32); assert.equal(ctx.lyricLines[0].text,'Existing original'); assert.equal(ctx.translatedLines[0].text,'翻译'); assert.equal(state,'success');
  ctx.currentLyricResult=null;ctx.lyricLines=[];ctx.translatedLines=[];
  await ctx.refineLyricsWithReferenceAudio({beatmap:{}},1,'a');assert.equal(state,'empty');
  ctx.currentLyricResult={lines:[{time:0,text:'作词：Example'}],translations:[]};ctx.lyricLines=ctx.currentLyricResult.lines;
  await ctx.refineLyricsWithReferenceAudio({beatmap:{}},1,'a');assert.equal(state,'empty','credits alone cannot light success');
  ctx.currentLyricResult={instrumental:true,lines:[],translations:[]};ctx.lyricLines=[];ctx.currentAudioMatchConfidence='windows:3/3';
  await ctx.refineLyricsWithReferenceAudio({beatmap:{}},1,'a');assert.equal(state,'success','confirmed instrumental output remains distinct from missing lyrics');
});

test('A outer transport windows run together rather than wait for each other', async () => {
  const ctx=referenceContext(referenceSignal(20),referenceSignal(25));
  ctx.CONFIG.audioMatchEnabled=true;ctx.CONFIG.audioMatchAlwaysUseAllWindows=true;
  ctx.GenerateFP=()=>{};ctx.searchNeteaseSongs=async()=>[{id:'123'}];ctx.selectAudioMatchEntries=entries=>entries;
  const releases=[],visited=[];
  ctx.audioMatchWindowResult=async(_audio,windowInfo)=>{
    visited.push(windowInfo.fraction);
    if(windowInfo.fraction!==.5)await new Promise(resolve=>releases.push(resolve));
    return{song:{id:'123'},offsetMs:2560,windowInfo,effectiveSampleStartMs:windowInfo.targetStartSeconds*1000};
  };
  load(ctx,'audioMatchCurrentBeatmap','audioMatchConsensus');
  const pending=ctx.audioMatchCurrentBeatmap({},{});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(visited,[.5,.25,.75]);assert.equal(releases.length,2);
  releases.forEach(resolve=>resolve());assert.equal((await pending).confidence,'windows:3/3');
});

test('B skips lyric-less references before download and reuses the checked lyric body', async () => {
  const query=referenceSignal(20),reference=referenceSignal(25); reference.set(query,20480);
  const ctx=referenceContext(query,reference), downloads=[];
  ctx.CONFIG.lyricSourcePriority='netease-only';ctx.searchNeteaseSongs=async()=>[{id:'1',name:'Empty'},{id:'2',name:'Usable'}];
  ctx.loadQqLyricsBySong=async()=>({lines:[],translations:[]});
  ctx.loadLyricsBySongId=async id=>({provider:'netease',providerSongId:id,lines:id==='1'?[{time:0,text:'作词：Example'}]:[{time:1000,text:'Original lyric'}],translations:[]});
  ctx.audioMatchReferenceProxyUrl=id=>`http://localhost/audio/reference?id=${id}`;
  ctx.fetchArrayBuffer=async url=>{downloads.push(new URL(url).searchParams.get('id'));return reference;};
  load(ctx,'audioMatchReferenceBeatmap'); const result=await ctx.audioMatchReferenceBeatmap({}, {}, {}, null,new Error('A failed'));
  assert.deepEqual(downloads,['2']);assert.equal(result.song.id,'2');assert.equal(result.prefetchedLyrics.lines[0].text,'Original lyric');
  assert.equal(BrowserWorker.alive,0);
});
