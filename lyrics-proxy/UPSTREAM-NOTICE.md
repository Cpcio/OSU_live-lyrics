# Upstream Notice

`src/vendor/netease-crypto.js` is copied from
`NeteaseCloudMusicApiEnhanced/api-enhanced` (`util/crypto.js`) under its MIT
license. This prototype only uses its existing `eapi()` request encryption
implementation; it does not reimplement that protocol.

QQ Music search, legacy lyric and MV routes use `qq-music-api` version 1.1.2,
from https://github.com/jsososo/QQMusicApi (GPL-3.0).
`src/qqmusic.js` supplies a cancellable transport adapter; the package routes
are used without enabling their cache. Runtime distributions include this
notice and the upstream license. Corresponding application/adapter source
and build files are retained in the development workspace or a separate
source archive; they are not runtime dependencies.
