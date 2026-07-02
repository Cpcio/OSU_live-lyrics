# tosu 实时歌词叠加层

这是一个 tosu 游戏内叠加层 counter。它会从 tosu 读取当前谱面的标题、作者和播放时间，再通过本地 NetEase Cloud Music API 服务获取同步 LRC 歌词并显示。

## 文件说明

- `index.html`：叠加层页面。
- `metadata.txt`：tosu counter 元数据。
- `settings.json`：显示在 tosu counter settings 面板中的配置，使用 tosu 的扁平 `uniqueID/type/title/description/options/value` 格式。
- `lyrics-overrides.json`：可选的本地覆盖文件，可手动指定网易云歌曲 ID、歌词偏移、倍速，或直接写入 LRC。
- `song-cache.json`：可编辑的歌曲 ID 缓存文件，用于把某个 tosu/osu 谱面固定到某个网易云歌曲 ID。
- `song-aliases.json`：旧版外部别名参考文件；当前叠加层默认不再读取它，也不再使用“外部别名优先”的罗马音匹配方案。

## 需要运行的服务

1. tosu
   - 默认面板地址：`http://127.0.0.1:24050`
   - 本叠加层使用的 WebSocket：`ws://127.0.0.1:24050/websocket/v2`

2. NetEase Cloud Music API Enhanced
   - 项目地址：`https://github.com/neteasecloudmusicapienhanced/api-enhanced`
   - 本叠加层默认 API 地址：`http://127.0.0.1:3000`
   - 使用的接口：`/search`、`/cloudsearch`、`/lyric`、`/audio/match`

## 安装

把整个文件夹放到 tosu 的 counters/static 目录下，例如：

```text
tosu/
  static/
    live-lyrics/
      index.html
      metadata.txt
      README.md
```

如果你在 tosu 设置中改过 Counters Directory / STATIC_FOLDER_PATH，请放到你实际设置的目录。

## 配置

大部分配置都可以在 tosu 的 counter settings 面板中修改。`index.html` 顶部的 `CONFIG` 是默认值：

```js
const CONFIG = {
  tosuWebSocket: "ws://127.0.0.1:24050/websocket/v2",
  neteaseApiBase: "http://127.0.0.1:3000",
  lyricOffsetMs: 0,
  audioMatchEnabled: false,
  audioMatchStartSeconds: -1,
  audioMatchDurationSeconds: 15,
  audioMatchMinOffsetMs: -30000,
  audioMatchMaxOffsetMs: 30000,
  autoOffsetFromFirstObject: false,
  autoOffsetMaxMs: 45000,
  autoOffsetLeadMs: 900,
  autoSpeedFromDifficulty: true,
  speedMultiplier: 1,
  retryDelayMs: 1200,
  searchLimit: 8,
  contextBefore: 1,
  contextAfter: 1,
  showTranslation: true,
  overlayWidthPx: 960,
  lyricsHeightPx: 190,
  panelColor: "#090c12",
  panelOpacity: 0.5,
  panelColorMode: "beatmap",
  beatmapColorBlend: 0.72,
  autoAccentFromBeatmap: true,
  searchEndpoints: ["/search", "/cloudsearch"],
  fetchTimeoutMs: 4500,
  allowPostFallback: true,
  localOverridesPath: "lyrics-overrides.json",
  songCachePath: "song-cache.json",
  songCacheWriteEndpoint: "",
};
```

常用配置：

- `lyricOffsetMs`：全局歌词偏移，单位毫秒。歌词太晚就填负数，歌词太早就填正数。
- `audioMatchEnabled`：启用听歌识曲。开启后叠加层会直接用当前谱面音频识别网易云歌曲，并接管所有歌曲的歌词加载；关闭后回到标题搜索、缓存和覆盖文件流程。
- `audioMatchStartSeconds`：识曲取样从 osu 音频第几秒开始。默认 `-1`，表示自动取歌曲中点前后各 7.5 秒，共 15 秒。
- `audioMatchDurationSeconds`：识曲取样时长。仅当 `audioMatchStartSeconds` 为非负数时使用；负数开始时间会固定使用 15 秒。
- `audioMatchMinOffsetMs` / `audioMatchMaxOffsetMs`：识曲偏移的可信范围，默认 `-30000` 到 `30000`。超出范围会放弃识曲结果并回退到标题搜索。
- `autoOffsetFromFirstObject`：自动用第一句歌词时间和谱面第一个物件时间估算单曲偏移，默认关闭。
- `autoOffsetMaxMs`：自动估算偏移的最大绝对值，默认 `45000` 毫秒。超过这个范围会放弃自动修正，避免明显误判。
- `autoOffsetLeadMs`：自动偏移的额外提前量。歌词普遍滞后时增大它，默认 `900` 毫秒。
- `autoSpeedFromDifficulty`：自动从难度名中读取 `1.2x`、`x1.2`、`1.05x` 等倍速标记，并缩放歌词时间。
- `speedMultiplier`：手动额外倍速。
- `contextBefore` / `contextAfter`：当前歌词前后各显示多少行，默认都是 `1`。
- `overlayWidthPx`：歌词面板宽度。
- `lyricsHeightPx`：歌词区域固定高度。
- `panelColor`：面板颜色，使用 hex 格式。
- `panelOpacity`：面板透明度，范围 `0` 到 `1`。
- `panelColorMode`：`"manual"` 使用 `panelColor`；`"beatmap"` 会尝试从当前谱面背景取色并混合到面板中。
- `beatmapColorBlend`：背景取色后向 `panelColor` 混合的强度。数值越高越稳定、越暗。
- `autoAccentFromBeatmap`：使用谱面背景取色更新翻译文字和进度条强调色。
- `showTranslation`：网易云返回翻译歌词时显示翻译。
- `searchEndpoints`：本地网易云 API 要尝试的搜索接口。
- `fetchTimeoutMs`：网易云 API 请求超时时间。
- `allowPostFallback`：GET 请求遇到 HTTP 405 时，自动改用 POST 重试。
- `songCachePath`：可编辑的歌曲 ID 缓存 JSON 文件路径。
- `songCacheWriteEndpoint`：可选的本地写入器地址。默认留空，不需要手动启动额外 JS；只有想把成功结果自动写入 `song-cache.json` 时才需要填写。

这些配置也声明在 `settings.json` 中，因此 tosu 可以在 counter settings 面板里展示它们。页面也会监听 `/websocket/commands` 来接收 settings 更新。

## 听歌识曲模式

开启 `audioMatchEnabled` 后，叠加层会直接读取 tosu 的 `/files/beatmap/audio`，在浏览器内生成网易云听歌识曲需要的 `audioFP`，然后调用 `/audio/match`。默认 `audioMatchStartSeconds = -1` 时，会以歌曲中点为中心取 15 秒；例如 1 分钟歌曲会取 22.5s 到 37.5s。若设置为非负数，则从指定秒数开始取 `audioMatchDurationSeconds`。若难度名或手动设置里有倍速，叠加层会先按倍率换算取样窗口：例如 `1.2x` 且设置从 `30s` 开始、识曲 `15s`，实际会从 osu 音频 `30 / 1.2 = 25s` 开始取 `15 / 1.2 = 12.5s`，再拉伸回接近原曲速度后识别。识别成功后会使用返回的 `song.id` 拉取 `/lyric`，并用：

```text
lyricOffsetMs = 网易云 startTime - 换算后的原曲取样开始时间
```

来对齐完整 LRC 和当前 osu 音频。若歌曲太短导致设置的开始时间不存在，会自动把取样窗口往前移动到可用范围内。右上角偏移值带 `auto` 时，表示当前歌曲使用了自动来源的偏移。

这个模式开启时会优先尝试听歌识曲；如果识别失败、识别偏移明显异常，或当前片段超出音频长度，会自动回退到原来的缓存、覆盖文件和标题搜索流程。若启动了 `cache-writer.js` 并填写 `songCacheWriteEndpoint`，识曲得到的 `neteaseSongId` 和偏移会写入 `song-cache.json`，并带有 `audioMatchSource` 标记。关闭听歌识曲后，这类自动偏移不会继续生效。

## 时间轴

歌词右侧会显示一条竖向进度条。它使用 `beatmap.time.live` 除以 tosu 能提供的最佳歌曲时长字段来计算进度。当前歌词行旁边也会显示该句 LRC 时间戳。

当谱面背景图可以被读取时，进度条会从背景图上下两个区域取色：上方作为 A 色，下方作为 B 色。未播放区域会显示较灰、较透明的 A-B 渐变；已播放区域会覆盖完整颜色的 A-B 渐变。

## 自动歌词偏移

开启 `autoOffsetFromFirstObject` 后，叠加层会在拿到歌词时尝试估算单曲偏移：

```text
lyricOffsetMs = 第一句歌词时间 - 谱面第一个物件时间 + autoOffsetLeadMs
```

谱面第一个物件时间会优先使用 tosu WebSocket 数据；如果没有提供，会尝试读取 `/files/beatmap/file` 对应的 `.osu` 文件并解析 `[HitObjects]`。这个功能只处理“整体提前/整体延后”，不会处理倍速错位。

自动偏移只会在当前歌曲没有手动偏移时生效。如果 `song-cache.json` 或 `lyrics-overrides.json` 里已经写了非零 `lyricOffsetMs`，或者缓存项带有 `"manual": true`，叠加层会尊重手动值。右上角会显示当前生效的总偏移值；带 `auto` 表示这首歌正在使用自动估算偏移。

如果启动了 `cache-writer.js` 并在设置里填写 `songCacheWriteEndpoint`，自动估算出来的 `lyricOffsetMs` 会和 `neteaseSongId` 一起写入 `song-cache.json`。这个偏移会带有 `autoOffsetSource` 标记；只有 `autoOffsetFromFirstObject` 开启时才会生效，关闭后同一首歌会忽略这类自动偏移。

## 本地缓存与覆盖

如果你希望结果可复现、可手动修正，请编辑 `song-cache.json`。叠加层会在搜索网易云之前先检查这个文件，并用其中的 `neteaseSongId` 直接拉取歌词，避免重复搜索。

先区分两个 osu! ID：

- `beatmapset id`：谱面包 ID，也就是网址中的 `2325770`。同一首歌或同一个 pack 下的多个难度通常共享这个 ID。
- `beatmap id`：具体难度 ID，也就是网址中的 `4992967`。歌词缓存应优先使用这个 ID，因为同一谱面包里的不同难度可能是不同歌曲、不同裁切版本或不同倍速。

例如 `https://osu.ppy.sh/beatmapsets/2325770#mania/4992967` 中，推荐写成 `beatmap:4992967`，而不是 `set:2325770`。

`song-cache.json` 示例：

```json
{
  "tracks": {
    "beatmap:4992967": {
      "neteaseSongId": 123456789,
      "title": "Example Title",
      "artist": "Example Artist",
      "lyricOffsetMs": 0,
      "speedMultiplier": 1,
      "source": "Manual cache"
    },
    "set:2325770": {
      "neteaseSongId": 123456789,
      "lyricOffsetMs": 0,
      "speedMultiplier": 1,
      "manual": true
    },
    "beatmap-checksum-example": {
      "neteaseSongId": 123456789,
      "lyricOffsetMs": 0,
      "speedMultiplier": 1
    },
    "exampleartist::exampletitle": {
      "neteaseSongId": 123456789,
      "lyricOffsetMs": 0,
      "speedMultiplier": 1,
      "manual": true
    }
  }
}
```

每一项的含义：

- `tracks`：缓存表本体，所有缓存都写在这里。
- `beatmap:4992967`：最推荐的 key，表示“只对这个具体难度生效”。`4992967` 是 osu! 的 beatmap id。
- `set:2325770`：谱面包级 key，表示“这个谱面包下都先用这个结果”。这个 key 很容易导致同包不同难度串歌，必须加 `"manual": true` 才会被读取。
- `beatmap-checksum-example`：谱面文件 checksum。没有在线 beatmap id 时可以用它，通常也能精确到具体难度。
- `exampleartist::exampletitle`：标准化后的“作者::标题”兜底 key，容易和别的谱面撞名，必须加 `"manual": true` 才会被读取。
- `neteaseSongId`：网易云歌曲 ID，也是最重要的字段。填错了就会拉错歌词；填 `0` 等于示例占位，实际不会有用。
- `title` / `artist`：备注用的歌曲名和作者，方便你自己看，不参与核心匹配。
- `lyricOffsetMs`：这首歌单独的歌词偏移，单位毫秒。负数表示歌词提前，正数表示歌词延后。
- `speedMultiplier`：这首歌单独的歌词速度倍率。一般填 `1`；如果谱面是 `1.2x` 这种加速版本，可以填 `1.2`。
- `source`：备注来源，方便记录“手动指定”“自动缓存”等信息，不影响匹配。

缓存命中优先级是：具体难度 `beatmap:<beatmap id>`，然后是 checksum。`set:<beatmapset id>` 和 `artist::title` 属于宽 key，只有手动写入并加上 `"manual": true` 时才会被读取。自动写入器不会写这些宽 key。

静态浏览器页面无法直接写入本地 JSON 文件。如果你希望搜索成功后自动把 `neteaseSongId` 写入可手动编辑的 `song-cache.json`，可以启动可选写入器，并在 settings 中把 `Song Cache Writer` 设置为 `http://127.0.0.1:3001/song-cache`：

```text
node cache-writer.js
```

如果没有启动写入器，叠加层仍然可以正常工作，只是不会把自动搜索结果写回 `song-cache.json`；需要长期固定结果时请手动编辑缓存文件。

如果需要更稳定的手动控制，可以编辑 `lyrics-overrides.json`：

```json
{
  "tracks": {
    "beatmap:4992967": {
      "neteaseSongId": 123456789,
      "lyricOffsetMs": -250,
      "speedMultiplier": 1
    },
    "beatmap-checksum": {
      "neteaseSongId": 123456789,
      "lyricOffsetMs": -250,
      "speedMultiplier": 1
    },
    "artisttitle": {
      "lines": "[00:00.00]Local LRC line",
      "translations": "",
      "lyricOffsetMs": 0,
      "speedMultiplier": 1
    }
  }
}
```

`lyrics-overrides.json` 的 key 规则和 `song-cache.json` 类似，也推荐优先使用具体难度的 `beatmap:<beatmap id>`。由于静态叠加层不能自己写回 counter 文件夹，所以这种文件级覆盖对叠加层来说是只读的。

## 长歌词处理

长歌词会自动换行或裁切，避免超出面板：

- 上下文歌词限制为一行视觉高度。
- 当前歌词和翻译限制为两行视觉高度。
- 歌词区域使用固定高度并隐藏溢出。

如果需要更多显示空间，可以增大 `overlayWidthPx` 或 `lyricsHeightPx`。

## 405 与游戏内叠加层错误

部分网易云 API 部署可能拒绝 GET 请求并返回 HTTP 405。本叠加层会先尝试 GET；如果启用了 `allowPostFallback`，遇到 405 会对同一接口使用 POST 重试。

`CopyRect is out of range` 是 tosu 游戏内叠加层 surface 内部抛出的错误。有时网页浏览器里能正常显示，但游戏内叠加层会因为绘制区域异常或不稳定而报错。当前版本通过以下方式降低风险：

- 防止歌词文字溢出面板。
- 固定歌词区域高度。
- 隐藏页面和面板溢出。
- 捕获异步错误，避免 unhandled rejection。
- 增加请求超时。

如果仍然出现这个错误，可以减小 `overlayWidthPx`、减小 `lyricsHeightPx`，或在 tosu 中移动/缩放 counter，确保它完整位于游戏画面范围内。

## 搜索匹配

每个谱面会尝试多种搜索方式：

- 完整标题加作者。
- 清理后的标题加作者。
- 去掉括号标签后的标题。
- 仅标题。
- 可用时同时尝试 `/search` 和 `/cloudsearch`。

叠加层会检查多个候选歌曲，并一直尝试到找到带同步 LRC 的结果。当前默认已关闭“外部别名优先的罗马音匹配”和“罗马音严格置信度过滤”。如果某首歌匹配错了，请在 `song-cache.json` 里固定正确的 `neteaseSongId`。

## 使用步骤

1. 启动 NetEase Cloud Music API Enhanced，并让它监听 `3000` 端口。
2. 启动 tosu。
3. 打开 tosu 面板：`http://127.0.0.1:24050`。
4. 启用 In-Game Overlay。
5. 打开或添加 `Live Lyrics` counter。
6. 进入 osu! 谱面后，叠加层会自动搜索歌词，并根据 `beatmap.time.live` 同步显示。

## 备注

- tosu 提供当前歌曲信息和播放时间，歌词来自本地网易云 API 服务。
- osu! 谱面标题经常包含 `TV Size`、`Game Ver.`、谱师备注或额外标签。叠加层会清理常见标签后再搜索，但仍可能有少数歌曲匹配错误。
- 有些谱面使用裁切音频或带偏移的音频。如果歌词整体不同步，请调整 `lyricOffsetMs`。
- 谱面背景取色依赖 tosu 提供可用的背景图片路径。如果没有路径或图片读取失败，叠加层会回退到 `panelColor`。
