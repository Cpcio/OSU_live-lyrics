# tosu Lyrics Proxy

Live Lyrics 专用的本地代理，默认只监听 `127.0.0.1:3002`。入口为 `src/server.js`；启动器入口为 `src/start-tosu.js`。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm start
```

建议 Node.js 20+、pnpm 9 兼容锁文件。参数 `--port` 与 `--cache` 可设置监听端口和歌曲映射文件位置；不要提交使用过程中生成的映射或账号数据。

## 接口

- `/audio/match`：网易云指纹识曲。
- `/search`、`/cloudsearch`、`/lyric`、`/lyric/new`：网易云搜索与歌词。
- `/qq/search`、`/qq/lyric`：QQ 搜索与歌词。
- `/song/audio`、`/qq/song/audio`：参考音频流。
- `/mv/for-song`、`/qq/mv/for-song`：MV 查询与播放地址。
- `/song-cache`：显式歌曲映射写入。
- `/health`：版本、提供商与功能检查。

请求取消、超时及并发由 src/upstream.js 管理。QQMusicApi 路由通过 src/qqmusic.js 调用，其缓存未启用。

## EXE 与运行包

```powershell
pnpm build
```

当前 package.json 输出 `dist-runtime-mv-20261004/lyrics-proxy.exe` 和 `Start-Tosu-Lyrics.exe`，使用 pkg 内嵌 Node 18 运行时。全新克隆可直接构建；已有历史输出时为 pkg 选择新目录，不覆盖旧 EXE。两个 EXE 发布时位于前端入口旁边，启动器查找相邻代理并等待健康检查。

从根目录用 `tools/package-release.cjs` 与运行清单打包，不能把 src、node_modules、依赖锁文件或开发记录放入运行包。GitHub 源码则需要 src、package.json、pnpm-lock.yaml、README 与上游许可声明。

完整上传清单见 [SOURCE_LAYOUT.md](../SOURCE_LAYOUT.md)，来源声明见 [UPSTREAM-NOTICE.md](UPSTREAM-NOTICE.md) 和 [THIRD_PARTY.md](../THIRD_PARTY.md)。
