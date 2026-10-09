# 第三方来源与许可记录

| 组件 | 当前来源 | 仓库保留项 |
| --- | --- | --- |
| SoundTouch JS | `soundtouchjs`，前端使用本地 `js/soundtouch.js` | `js/SOUNDTOUCH-LICENSE.txt`（LGPL-2.1）与现有库文件头 |
| QQMusicApi | `qq-music-api@1.1.2`，https://github.com/jsososo/QQMusicApi | `lyrics-proxy/QQMusicApi-LICENSE.txt`（GPL-3.0）、锁文件和 `src/qqmusic.js` 适配源码 |
| 网易云请求加密 | `NeteaseCloudMusicApiEnhanced/api-enhanced` 的 `util/crypto.js` | `lyrics-proxy/src/vendor/netease-crypto.js` 和 `UPSTREAM-NOTICE.md`；现有声明记载 MIT，完整上游许可/对应版本仍需补齐记录 |
| 网易云指纹运行库 | `js/afp.js` 文件内标注的网易云浏览器识曲入口 | `js/afp.js`、`js/afp.wasm.js` 是现行运行必需项；目录中未找到其明确的再分发许可，尚不能认定其为 MIT 等开源代码 |
| 其他代理依赖 | `crypto-js`、`node-forge` 和它们的传递依赖 | `package.json` 与 `pnpm-lock.yaml`；安装包内授权文件由对应依赖保留 |

这是文件来源清单，不是替整个项目选定许可证。项目目前没有顶层 `LICENSE`。公开发布前应确认自有代码许可、完整上游许可和指纹运行库再分发授权；本轮只生成本地源码目录，没有将文件发布到 GitHub。

QQMusicApi 的上游许可可在其 [LICENSE](https://github.com/jsososo/QQMusicApi/blob/master/LICENSE) 查看。已存在的第三方许可文件不能用项目自身许可证替换。
