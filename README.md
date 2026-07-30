# OSU! Live Lyrics

用于 [tosu](https://github.com/tosuapp/tosu) 的 osu! 游戏内实时歌词 Overlay。它读取当前谱面的标题、作者、播放时间与音频，通过本地歌词代理搜索网易云音乐并同步显示歌词。

UI 示例，对应谱面：[osu!mania beatmapset 1790742](https://osu.ppy.sh/beatmapsets/1790742#mania)

<img width="772" height="345" alt="Live Lyrics overlay preview" src="https://github.com/user-attachments/assets/95e8e638-5125-49c7-a545-d1dced9fc562" />

## 功能

- 实时显示当前歌词、前后歌词、翻译、时间和谱面进度条。
- 支持 LRC、YRC 逐词高亮、歌词切换动画、自定义 TTF 字体与字号。
- 支持标题搜索、歌曲 ID 缓存、手动修正和自动写入缓存。
- 听歌识曲会使用当前谱面音频识别网易云歌曲；可选 25% / 50% / 75% 多窗口核验，并在右上角显示可信度。
- 支持难度名中的 `1.2x`、`x1.2`、`1,2x` 等倍率；`[120]`、`[135]` 一类 BPM 标签可自动推算识曲与歌词倍率。
- 非合包谱面会在同一谱面集内复用歌曲结果，切换难度不重复搜索；Pack、Collection、LNEX 等合包会继续从难度名读取歌曲信息。
- 支持全局偏移、单曲偏移、自动偏移和右上角偏移显示。
- 可播放网易云 MV 背景；可选 Bilibili 视频回退，支持时长校验、黑名单和白名单评分。

## 依赖

- [tosu](https://github.com/tosuapp/tosu)

本项目已包含专用本地代理 `lyrics-proxy.exe`，不需要额外启动 `NeteaseCloudMusicApiEnhanced/api-enhanced`，也不需要安装 Node.js。

## 安装

将整个项目文件夹放进 tosu 的 `static` 目录，例如：

```text
tosu/
  static/
    tosu-live-lyrics/
      index.html
      metadata.txt
      settings.json
      song-cache.json
      lyrics-proxy.exe
      Start-Tosu-Lyrics.exe
      bilibili-blacklist.txt
      js/
```

`lyrics-proxy.exe`、`Start-Tosu-Lyrics.exe` 和 `bilibili-blacklist.txt` 必须位于同一目录。

## 使用

1. 双击 `Start-Tosu-Lyrics.exe`。它会启动本地歌词代理、等待代理就绪后启动 tosu，并在 tosu 退出时关闭代理。
2. 启动器会自动查找相对路径下的 `tosu.exe`。标准的 `tosu/static/插件目录/` 安装会自动命中，无需配置。非标准目录可在启动前设置环境变量：

```powershell
$env:TOSU_PATH = 'D:\Apps\tosu\tosu.exe'
.\Start-Tosu-Lyrics.exe
```

3. 在 tosu 中启用游戏内 Overlay，将本面板添加到叠加层。
4. 进入谱面后，歌词会自动加载并同步显示。

若手动启动 tosu，则也需要手动启动 `lyrics-proxy.exe`。默认歌词 API 地址为 `http://127.0.0.1:3002`。

大部分选项可在 tosu 的 Counter Settings 面板中实时修改。

## 常用设置

- `Enable Audio Match`：用谱面音频识曲；关闭后只进行标题搜索。（性能）
- `Always Use 25% / 50% / 75% / Title`：始终完成四路识曲核验。（性能）
- `Preserve-Pitch Match`：倍率谱面额外尝试不变调识曲。（性能）
- `Reuse Song Within Set`：非合包谱面切换难度时复用歌曲结果。
- `BPM Tag Audio Match`：处理难度名中的 `[120]` 等 BPM 标签。（性能）
- `Audio Match Min/Max Offset`：识曲偏移可信范围，单位毫秒。
- `Lyric Offset`：全局歌词偏移，单位毫秒。
- `Auto Speed From Difficulty`：读取难度名倍率并缩放歌词时间。
- `MV Background`：启用 MV 视频背景；可调整亮度、透明度、遮罩和裁切。
- `MV Background Source Priority`：选择网易云或 Bilibili 的优先级。
- `Show Debug Status`：显示底部识曲、网络和视频来源信息。

## 缓存和手动修正

`song-cache.json` 用来固定某个谱面应使用的网易云歌曲 ID。推荐使用具体难度 ID：

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
- `lyricOffsetMs`：该谱面的歌词偏移。
- `speedMultiplier`：额外歌词倍率。
- `manual`：手动指定时建议设为 `true`，自动写入不会覆盖它。
- `source`：可选备注。

匹配错误时，优先在此文件中手动指定正确的 `neteaseSongId` 和偏移。

## 自动写入缓存

本地代理内置缓存写入功能。在设置中将 `Song Cache Writer` 设为：

```text
http://127.0.0.1:3002/song-cache
```

识别成功的谱面会自动写入 `song-cache.json`。不填写该地址也可正常使用，只是不保存新匹配结果。

## Bilibili 黑白名单

`bilibili-blacklist.txt` 位于 `lyrics-proxy.exe` 旁。它支持两个区段：

```text
[blacklist]
手元
phigros

[whitelist]
mv
official
```

- 黑名单命中标题、简介或作者时直接跳过该视频。
- 白名单命中候选标题时加分；未命中则扣分。
- 代理只在时长合格的前五个搜索候选中选择分数最高者。

修改文件后无需重启代理。

## 文件说明

- `index.html`：Overlay 主页面。
- `settings.json`：tosu Counter Settings 配置。
- `song-cache.json`：歌曲 ID、偏移和 BPM 缓存。
- `lyrics-proxy.exe`：本地网易云歌词、识曲、MV 与缓存代理。
- `Start-Tosu-Lyrics.exe`：一键启动 tosu 与代理。
- `bilibili-blacklist.txt`：Bilibili 视频筛选规则。
- `js/afp.js`、`js/afp.wasm.js`：听歌识曲音频指纹运行时。
- `js/lyric-alignment.js`：自动偏移辅助逻辑。

## 备注

- 网易云歌曲存在不代表一定有同步 LRC/YRC；听歌识曲已确认歌曲但无歌词时，面板会显示“纯音乐，请欣赏”。
- 听歌识曲失败时会回退标题搜索；右上角可信度会显示对应的识别结果。
- Bilibili 搜索排序由服务端决定，白名单和时长校验只能在返回候选中筛选，不能保证找到指定 BV。
