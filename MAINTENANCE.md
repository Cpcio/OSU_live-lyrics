# 维护说明

模块职责、GitHub 上传清单和构建方法见 [SOURCE_LAYOUT.md](SOURCE_LAYOUT.md)。本地历史文档与诊断报告保留在开发目录；本文件聚焦当前实现。

## 代码约束

- `js/overlay/` 按 index.html 顺序加载并共享状态；移动函数前检查依赖与全局初始化顺序。
- 新请求沿用任务 token、track key、AbortController 和超时；旧歌曲/难度任务不可提交。Worker、定时器和大数组在完成、失败、取消以及 pagehide 路径释放。
- A 管理指纹、多窗口候选与粗定位；B 管理参考音频验证与后台精修。不要因性能优化减少独立窗口、放宽错版接受条件或以艺术家名称不一致拒绝歌曲。
- 文件音频倍速与游戏播放倍率分别处理；同谱面集复用只保留歌曲身份和已证明的原曲起点，新难度重新解析文件倍率。不可重复应用游戏倍率。
- `audio.js` 的解码函数允许明确的采样率。A 非 1x 且允许不变调时使用 44100Hz，文件倍率达到2倍时使用48000Hz，避免继承设备的192kHz，并保留极端不变调输入的指纹表现；其他识曲路径和频谱路径不受该分支修改影响。
- 原文、逐词时间、翻译片段及译文列表共享提交后的歌词时钟；来源择优不能交换原文/翻译角色、丢失有效译文或以 QQ 的空歌词覆盖原文。
- MV 身份独立于歌词提供商；QQ 歌词 ID 不得用于网易云 MV。subtitle 不加载 MV、频谱或前后句，但保留玩家对其他布局的设置。
- `layout.js` 管理封面与文字几何；切句不得反向改变封面大小。renderer 更新同句时复用字形节点，切换布局时先清理旧动画。
- 新设置同时更新 state.js 默认值、类型、settings.json；只有识曲设置进入重载键，视觉设置仅重新排版。内部算法参数不开放给旧设置覆盖。
- Worker 与动态 import 使用 document.baseURI 检查安装路径；新增运行资源同步加入显式发布清单。

## 验证

核心回归测试不需要实际歌曲录音，也不发送识曲请求：

```powershell
node --test diagnostics/stability.test.cjs diagnostics/lyric-quality.test.cjs
```

这两份测试依赖 `diagnostics/lib/overlay-source.cjs` 与 `diagnostics/fixtures/background-colour-pre18.js`，均在源码上传清单中。已有浏览器/现场音频诊断仍保留在本地 diagnostics；其中部分使用本机浏览器或录制数据，不属于必需源码。

音频处理变更应覆盖变调和不变调、不同难度入口、跳转、取消与多窗口一致性。单首构造倍速实验不能代表所有原曲、混音、节选或极端倍率的召回率。当前 44.1kHz 实验记录在本地 `diagnostics/sample-rate-44100-20261004/`。

## 发布与源码归档

遵守 [AGENTS.md](AGENTS.md)：运行包只有 release-manifest.json 指定的资源、两个匹配 EXE 和必要声明。用 package-release.cjs 创建新目录并 --verify，禁止复制上一版目录或覆盖现有版本。E 盘历史内容不修改。

GitHub 源码使用 package-source.cjs 的明确清单；EXE 和运行包作为 Releases 附件，不提交到代码目录。源码导出拒绝已有目的地，并检查空白歌曲种子与脚本语法；哈希报告只写 diagnostics/source-packages。

本轮修改前的文档和前端版本已保存在 `backup/before-sample-rate-source-20261004/`。原有历史发布包与其他备份保留原处。项目许可证和第三方再分发记录仍需按 THIRD_PARTY.md 核实，本轮没有选择项目整体许可证或上传 GitHub。
