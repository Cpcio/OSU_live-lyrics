// Use qq-music-api's route contracts with a bounded, cancellable transport.
// Its singleton api() does not await async route errors; route invocation here
// also avoids enabling its search cache or starting an additional server.
const searchRoutes = require('qq-music-api/routes/search');
const lyricRoutes = require('qq-music-api/routes/lyric');
const mvRoutes = require('qq-music-api/routes/mv');
const { upstreamJson, UpstreamError } = require('./upstream');

async function packageRoute(route, query) {
  let result;
  await route({ req: { query, cookies: {} }, res: { send(value) { result = value; } },
    request: async (options) => {
      if (typeof options === 'string') options = { url: options };
      const url = new URL(options.url);
      url.protocol = 'https:';
      for (const [key, value] of Object.entries(options.data || {})) url.searchParams.set(key, value);
      url.searchParams.set('format', 'json');
      if (url.hostname === 'u.y.qq.com' && url.searchParams.has('data')) {
        // The old package MV GET contract now returns per-format code 1000
        // with no URL. The same documented module succeeds via JSON POST.
        const payload = JSON.parse(url.searchParams.get('data'));
        payload.comm = { ct:24, cv:0, uin:0, format:'json', ...payload.comm };
        url.searchParams.delete('data');
        return upstreamJson(url, { method:'POST', headers:{'Content-Type':'application/json',Referer:'https://y.qq.com/'}, body:JSON.stringify(payload) });
      }
      return upstreamJson(url, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' } });
    } });
  if (result?.result !== 100) throw new UpstreamError(result?.errMsg || 'QQ route failed', 'upstream_business');
  return result.data;
}

async function cgi(module, method, param) {
  const data = await upstreamJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
    body: JSON.stringify({ comm: { ct: 24, cv: 0, uin: 0, format: 'json' }, req: { module, method, param } })
  });
  if (Number(data.req?.code) !== 0) throw new UpstreamError(`QQ module code ${data.req?.code}`, 'upstream_business');
  return data.req.data;
}

async function search({ keywords, limit = 8 }) {
  if (!keywords) throw new UpstreamError('keywords required', 'invalid_request', 400);
  const data = await packageRoute(searchRoutes['/quick'], { key: encodeURIComponent(keywords) });
  return { code: 200, provider: 'qq', result: { songs: (data.song?.itemlist || []).slice(0, Number(limit)).map(s => ({
    id: s.mid, numericId: s.id, provider: 'qq', name: s.name,
    artists: [{ name: s.singer || '' }], dt: 0
  })) } };
}

async function lyric({ id, numericId }) {
  try {
    const value = numericId ? { songId: Number(numericId) } : { songMid: id };
    const data = await cgi('music.musichallSong.PlayLyricInfo', 'GetPlayLyricInfo', {
      ...value, crypt: 0, lrc_t: 0, qrc: 0, qrc_t: 0, trans: 1, trans_t: 0, roma: 1, roma_t: 0, type: 1
    });
    const decode = value => Buffer.from(value || '', 'base64').toString('utf8');
    const original = decode(data.lyric);
    if (/\[\d+:\d+/.test(original)) return { code: 200, provider: 'qq', lrc: { lyric: original },
      tlyric: { lyric: decode(data.trans) }, romalrc: { lyric: decode(data.roma) } };
  } catch (error) {
    if (error.kind === 'cancelled') throw error;
  }
  const data = await packageRoute(lyricRoutes['/'], { songmid: id });
  return { code: 200, provider: 'qq', lrc: { lyric: data.lyric || '' }, tlyric: { lyric: data.trans || '' } };
}

async function songAudioUrl({ id }) {
  const data = await cgi('music.vkey.GetVkey', 'UrlGetVkey', {
    uin: '0', filename: [`M500${id}${id}.mp3`], guid: '1000000000', songmid: [id], songtype: [0], ctx: 0
  });
  const purl = data.midurlinfo?.[0]?.purl;
  if (!purl) return { url: '', provider: 'qq' };
  let bases = data.sip || [];
  if (!bases.length) bases = (await cgi('music.audioCdnDispatch.cdnDispatch', 'GetCdnDispatch', {
    guid: '1000000000', uid: '0', use_new_domain: 1, use_ipv6: 0
  })).sip || [];
  const url = bases.length ? new URL(purl, bases[0]).toString().replace(/^http:/, 'https:') : '';
  return { url, provider: 'qq' };
}
async function mvForSong({ id, r = 720 }) {
  if (!/^[a-zA-Z0-9]{10,20}$/.test(String(id || ''))) throw new UpstreamError('invalid QQ song mid', 'invalid_request', 400);
  const detail = await cgi('music.pf_song_detail_svr', 'get_song_detail', { song_mid: id, song_type: 0 });
  const vid = detail.track_info?.mv?.vid;
  if (!vid || !/^[a-zA-Z0-9]{8,20}$/.test(vid)) return { code:200, provider:'qq', hasMv:false, songId:id };
  // qq-music-api's MV adapter returns complete MP4 URLs in quality order.
  const data = await packageRoute(mvRoutes['/url'], { id:vid });
  const urls = (data[vid] || []).filter(url => /^https?:\/\//.test(url));
  const index = Math.min(urls.length - 1, Number(r) >= 1080 ? 2 : Number(r) >= 720 ? 1 : 0);
  const url = (urls[index] || '').replace(/^http:/, 'https:');
  return { code:200, provider:'qq', hasMv:Boolean(url), songId:id, mvId:vid, url, r:Number(r) };
}
module.exports = { search, lyric, songAudioUrl, mvForSong };
