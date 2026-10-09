# 项目结构与 GitHub 上传清单

GitHub 仓库存放当前源码、配置模板、依赖锁文件、构建工具、测试和第三方声明。用户安装的运行包单独放在 GitHub Releases 附件中；本地历史资料继续保存在原处。

## 运行逻辑

1. `index.html` 按顺序加载静态库和 `js/overlay/` 的 classic scripts；目前共享全局状态，暂未迁移到模块打包框架。
2. `connections.js` 接收 tosu 的谱面、难度和播放时间；`tracks.js` 管理切歌、任务标识、取消、同歌曲难度复用和最终提交。
3. `metadata.js` 清理曲包/倍速名称；`catalog.js` 查询提供商并构造统一歌词结果；`network.js` 处理超时和请求。
4. A 在 `match-a.js` 中采样、还原倍率、生成网易云指纹并比较独立窗口；B 在 `match-b.js` 中下载参考音频，交给 Worker 做后台验证和精修。
5. `lyrics.js` 解析、配对原文/译文并建立歌词时钟；`quality.js` 比较来源质量并保留已经核验的身份、时钟和 MV。
6. `layout.js` 管理封面和排版；`renderer.js` 更新歌词/高亮/动画；`background.js` 处理背景取色和 MV；`audio.js` 处理音频解码、变速和频谱。
7. `lyrics-proxy/src/server.js` 是本地 HTTP 服务；`netease.js`、`qqmusic.js` 是提供商适配器；`upstream.js` 管理请求超时和取消；`start-tosu.js` 是启动器入口。

## 必须保留的源码

| 文件或目录 | 用途 |
| --- | --- |
| `index.html`、`metadata.txt`、`settings.json` | 面板入口、版本/默认尺寸、tosu 设置定义 |
| `song-cache.json` | 空白种子 `{ "tracks": {} }`，不要提交实际使用记录 |
| `css/`、`js/` | 全部现行前端代码、Worker、SoundTouch、指纹 WASM 包装及库声明 |
| `lyrics-proxy/src/` | 代理、启动器、适配器和 `vendor/netease-crypto.js` |
| `lyrics-proxy/package.json`、`pnpm-lock.yaml` | 依赖、固定版本及 EXE 构建入口 |
| `release-manifest.json`、`tools/package-release.cjs` | 从源码和匹配 EXE 生成必要运行包 |
| `source-manifest.json`、`tools/package-source.cjs` | 导出明确列出的源码上传目录 |
| `diagnostics/stability.test.cjs`、`lyric-quality.test.cjs` | 无需真实歌曲录音的核心回归测试 |
| `diagnostics/lib/overlay-source.cjs`、`fixtures/background-colour-pre18.js` | 上述测试需要的代码读取器和自有历史颜色基线 |
| `README.md`、`MAINTENANCE.md`、本文件、`THIRD_PARTY.md` | 安装、开发、结构和第三方来源说明 |
| `.gitignore`、`AGENTS.md` | 上传忽略规则与项目打包维护约束 |
| `js/SOUNDTOUCH-LICENSE.txt`、代理目录的许可/上游声明 | 必须保留的现有第三方说明 |

`js/afp.wasm.js` 是包含指纹 WASM 数据的 JavaScript 文件，不能按“编译产物”直接删掉。`js/soundtouch.js` 也由动态 import 使用；保留它不等于需要提交整个 `node_modules`。

## 不需要上传到源码仓库

- `releases/`、`backup/`、`.pnpm-store/`、`.agents/` 及本地 `.git/`。
- `lyrics-proxy/dist*/`、所有 EXE、`node_modules/`。
- 诊断报告、截图、录音、原曲、谱面包、接口录制结果和旧版本验证资料；只保留上表选出的测试源码。
- `cache-writer.js`：旧的独立写入器，现行写入由代理的 `src/cache.js` 提供。
- `tools/compact-releases.ps1`：已执行的历史整理工具，不参与新版本构建。
- cookie、anonymous_token、`.env`、密钥以及玩家个人歌曲映射。源码中的公开请求加密协议常量不同于个人账号凭据，不应随意删去。

`.gitignore` 对主要目录采用允许清单。已经被 Git 跟踪的文件不会因忽略规则自动移除；不要在未审查暂存区时直接执行全目录上传。当前工作区的 `.git` 不是可识别的有效仓库，本轮没有初始化、提交或推送它。

## 生成可查看的上传目录

在项目根目录运行：

```powershell
node tools/package-source.cjs --out diagnostics/github-source-1-22-2
```

工具合并运行前端清单和源码清单，先检查全部输入、空种子与路径，再复制到新目录。拒绝覆盖已有目录，检查 JavaScript 语法，并将哈希报告放在 `diagnostics/source-packages/`，不会混进上传目录。

将生成目录的内容作为仓库根目录提交。此工具只整理文件，不会连接 GitHub 或发布任何内容。项目自身的顶层开源许可尚未确定，本轮没有擅自新增 `LICENSE`；第三方文件的来源和许可状态见 `THIRD_PARTY.md`。

## 从新克隆源码运行、测试和构建

开发运行建议 Node.js 20 或更高版本；依赖以 pnpm 9 兼容锁文件安装。EXE 内嵌目标 Node 18 与开发 Node 版本是两回事。

```powershell
cd lyrics-proxy
pnpm install --frozen-lockfile
pnpm start
```

另一个终端在项目根目录执行核心回归测试：

```powershell
node --test diagnostics/stability.test.cjs diagnostics/lyric-quality.test.cjs
```

将前端交给 tosu 的 static 目录提供。浏览器 Worker、相对路径和 WebSocket 依赖 HTTP 宿主，直接打开本地 HTML 不等于真实运行环境。

在全新克隆目录中构建 EXE 并打包：

```powershell
cd lyrics-proxy
pnpm build
cd ..
node tools/package-release.cjs --name my-version --runtime-dir lyrics-proxy/dist-runtime-mv-20261004
node tools/package-release.cjs --verify releases/my-version
```

当前 `package.json` 与清单的构建输出路径均为 `dist-runtime-mv-20261004`。在已有历史 EXE 的开发目录重建时，应为 `pkg --output` 选择新的输出目录，再把该目录传给打包器；不要覆盖旧二进制。源码仓库需要这套构建入口和锁文件，运行安装包需要清单规定的两个 EXE，不需要 Node.js 或测试。
