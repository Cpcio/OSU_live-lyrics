# OSU Live Lyrics

这是一个完全由AI开发的，用于 [tosu](https://github.com/tosuapp/tosu) 的 osu! 游戏内实时歌词 overlay。它会读取当前谱面的标题、作者、播放时间和音频，并通过本地网易云音乐 API 获取同步 LRC 歌词并显示。
UI示例如下，对应[谱面](https://osu.ppy.sh/beatmapsets/1790742#mania)

<img width="772" height="345" alt="image" src="https://github.com/user-attachments/assets/95e8e638-5125-49c7-a545-d1dced9fc562" />


## 功能

- 实时显示当前歌词、上一句/下一句和翻译歌词。
- 支持标题搜索、歌曲 ID 缓存和手动修正。
- 可选听歌识曲：使用当前谱面音频识别网易云歌曲，再加载歌词。
- 支持从难度名读取类似 `1.2x`、`x1.2` 的倍速信息并缩放歌词时间。
- 支持全局偏移、单曲偏移、自动偏移和右上角偏移显示。
- 具有进度条，且颜色可从当前谱面背景取色，也可手动设置。
- 可选 `cache-writer.js`，把成功匹配的歌曲 ID 写入 `song-cache.json`。

## 依赖

- [tosu](https://github.com/tosuapp/tosu)
- [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)

## 安装

把本项目文件夹放进 tosu 的 `static` 目录，例如：
```text
tosu/
  static/
    tosu-live-lyrics/
      index.html
      metadata.txt
      settings.json
      song-cache.json
      js/
```
然后在 tosu 的游戏内 overlay 中启用。

## 使用

1. 启动[NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)的网易云 API 和 [tosu](https://github.com/tosuapp/tosu)
2. 将面板添加至tosu的叠加层
3. 进入 osu! 谱面后，overlay 会自动搜索并同步显示歌词。

大部分选项都可以在 tosu 的 counter settings 面板里自定义设置。

## 常用设置

- `NetEase API Base`：本地网易云 API 地址。
- `Lyric Offset`：全局歌词偏移，单位毫秒。
- `Enable Audio Match`：启用听歌识曲功能。开启后会优先用当前谱面音频识别网易云歌曲并管理歌词加载；关闭后仅使用标题搜索。这一功能会导致更高些的内存占用
- `Match Start`：识曲开始时间。默认 `-1` 表示取歌曲中点前后各 7.5 秒，共 15 秒。
- `Audio Match Min/Max Offset`：识曲偏移可信范围，默认 `-30000` 到 `30000` 毫秒。
- `First-Line Auto Offset`：用第一句歌词和谱面第一个物件估算整体偏移，默认关闭。
- `Auto Speed From Difficulty`：从难度名读取类似的倍速关键词并缩放歌词时间。
- `Song Cache Path`：歌曲 ID 缓存文件，默认 `song-cache.json`。
- `Song Cache Writer`：可选缓存写入器地址，通常填 `http://127.0.0.1:3001/song-cache`。

## 缓存和手动修正

`song-cache.json` 用来固定“某个谱面应该使用哪个网易云歌曲 ID”。推荐优先使用具体难度 ID：
```json
{
  "tracks": {
    "beatmap:4992967": {
      "neteaseSongId": 123456789,
      "lyricOffsetMs": 0,
      "speedMultiplier": 1,
      "manual": true
    }
  }
}
```
常用字段：
- `neteaseSongId`：网易云歌曲 ID。
- `lyricOffsetMs`：这首歌单独的歌词偏移。
- `speedMultiplier`：这首歌单独的歌词速度倍率。
- `manual`：手动指定时建议设为 `true`。
- `source`：可选备注，不影响匹配。
当该文件中存在指定ID、偏移等信息时，在选取该难度时程序会直接使用该结果搜索输出，因此若出现匹配错误，可进行手动修正。

## 自动写入缓存

如果希望匹配成功后，将匹配结果自动写入 `song-cache.json`，启动：
```text
node cache-writer.js
```
然后在设置里把 `Song Cache Writer` 填为：
```text
http://127.0.0.1:3001/song-cache
```
不启动写入器也可以正常使用，只是不会自动保存匹配结果。

## 文件说明

- `index.html`：overlay 主页面。
- `settings.json`：tosu counter settings 配置。
- `song-cache.json`：歌曲 ID 缓存，适合自动写入和手动修正。
- `cache-writer.js`：可选缓存写入器。
- `js/afp.js`：听歌识曲所需的音频指纹脚本。
- `js/afp.wasm.js`：音频指纹算法的 WebAssembly 二进制数据包装文件，`afp.js` 会依赖它生成 `audioFP`。
- `js/lyric-alignment.js`：自动偏移辅助逻辑。

## 备注

- 网易云有歌曲条目不代表一定有同步 LRC 歌词；如果接口返回空歌词，overlay 会显示 `No synced lyrics found`。
- 如果某首歌匹配错误，优先在 `song-cache.json` 中手动指定 `neteaseSongId`。
- 听歌识曲对倍速音频不一定稳定；失败时会回退到标题搜索。
- 目前还在持续优化中，可能出现一些奇怪的bug。
