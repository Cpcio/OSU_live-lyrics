# osu! Live Lyrics

用于 [tosu](https://github.com/tosuapp/tosu) 的 osu! 游戏内实时歌词面板。读取谱面信息、文件音频与播放时间，通过本地代理获取网易云音乐或 QQ 音乐歌词，并进行倍速还原和时间校正。

dashboard预览示例：
<img width="919" height="390" alt="image" src="https://github.com/user-attachments/assets/5e0266ff-0542-4175-ab6a-b0de2ac71719" />

## 功能

- 支持倍速曲包、不同歌曲曲包的音频识别与歌词输出。
- dashboard、lazer、subtitle 三种布局；subtitle 只显示当前原文和翻译，背景透明。
- 原文、中文翻译、逐词高亮、切句动画、背景取色进度条及频谱。
- 自定义面板尺寸、字体、封面尺寸和圆形旋转唱片。
- 识曲模式 A：指纹识曲与多窗口核验；模式 B：先显示 A 结果，后台用参考音频验证并精修。
- 文件倍速、百分比难度标记、起点偏移及同歌曲不同难度复用。
- 两个歌词来源择优，保留原有网易云 MV，并可用 QQ MV 补充。


## 安装与运行

下载 GitHub Releases 中完整的运行包，解压到 tosu 的 static 目录：

```text
tosu/static/live-lyrics/
  index.html
  metadata.txt
  settings.json
  song-cache.json
  lyrics-proxy.exe
  Start-Tosu-Lyrics.exe
  js/
  css/
  第三方声明文件
```

双击 `Start-Tosu-Lyrics.exe`，然后在 tosu 中添加面板。启动器自动查找 tosu、启动本地代理，并在 tosu 退出后关闭自己启动的代理。非标准路径可通过环境变量 `TOSU_PATH` 指定 `tosu.exe`。

两个 EXE 必须放在一起。运行包不需要另外安装 Node.js、代理源码或 node_modules。手动启动 tosu 时，需要先运行 `lyrics-proxy.exe`；默认 API 地址是 `http://127.0.0.1:3002`。

设置在 tosu 的 Counter Settings 调整。核验标识 `n/3` 表示支持当前结果的独立音频片段数量，分母固定为三个标准采样位置，属于证据数量而非识曲概率。

更新时替换完整新版本目录中的前端资源；后端接口变化时同时更新两个 EXE。每个发布版本使用独立目录，避免混用新旧文件。

## 从源码开发

前端没有额外的打包步骤。代理建议使用 Node.js 20+ 开发，以 pnpm 9 兼容格式安装锁定依赖：

```powershell
cd lyrics-proxy
pnpm install --frozen-lockfile
pnpm start
```

在项目根目录执行核心测试：

```powershell
node --test diagnostics/stability.test.cjs diagnostics/lyric-quality.test.cjs
```

源码构建、上传清单及完整目录职责见 [SOURCE_LAYOUT.md](SOURCE_LAYOUT.md)，维护规则见 [MAINTENANCE.md](MAINTENANCE.md)，第三方来源与许可记录见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 打包

在全新源码目录的 `lyrics-proxy/` 执行 `pnpm build`，输出两个 EXE。已有历史二进制时，为 pkg 选择新的输出目录，避免覆盖。

从项目根目录生成新运行包：

```powershell
node tools/package-release.cjs --name my-version --runtime-dir lyrics-proxy/dist-runtime-mv-20261004
node tools/package-release.cjs --verify releases/my-version
```

上传源码前生成一份独立目录：

```powershell
node tools/package-source.cjs --out diagnostics/github-source-my-version
```

运行包依照 `release-manifest.json`，源码依照 `source-manifest.json` 与前端清单。历史包、备份、录音、截图和开发报告保存在本地，不提交到源码仓库，也不放进运行包。

## 1.22.2

倍速识曲的分析解码使用受控采样率，避免跟随声卡默认的高采样率：常用文件倍率使用 44.1kHz，2倍及以上使用 48kHz，普通 1x 路径仍使用 8kHz。识曲模式、窗口、阈值、歌词时钟、频谱和 UI 保持原有逻辑。
