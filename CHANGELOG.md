# Changelog

## [0.3.0] — 2026-08-19

交互与显示打磨（用户实测迭代版）：

### Features
- 右键菜单统一（桌面窗 + 页面内）：粉色气泡同款配色、深浅色自适应；
  菜单固定在角色右上角（窄窗自动回落左/上方，绝不遮挡角色）。
- 右键菜单新增「角色大小」滑块（50%–200%，实时预览），与滚轮缩放、
  设置页滑块三处联动；设置 → 宠物管理 新增同款滑块。
- 页面内宠物菜单新增「桌面悬浮模式」开关，窗外 ⇄ 窗内双向切换
  （host `POST /desktop/{start,stop}`）。

### Fixes
- 表情切换人物大小归一化（charScale 像素分析）：位置 X 0.8px / Y 0px /
  人物高度 0.7px 离散，不再忽大忽小。
- GIF 动画冻结修复：load 重算不再重置 img.src（相同 mood 跳过赋值）。
- 桌面窗 userData 与主壳隔离 + spawn URL cache-busting，杜绝旧页面缓存。
- 窗口模式调整大小不再被强制拉起桌面窗（settings.watch 只在 desktopMode
  翻转时响应）。
- 移除残留右键关闭 handler；ELECTRON_RUN_AS_NODE 环境污染消毒。

### Compatibility
- 63 项测试全绿；已在 fairy（DSH 0.1.0-rc.5）桌面版实测。

# Changelog

## [0.2.0] — 2026-08-19

多宠物化 + 气泡实时汇报 + 桌面悬浮窗口（开源首版）：

### Features
- 多宠物注册表：设置 → 宠物管理（启用/禁用、改名、设为当前、添加宠物）；
  宠物 = `assets/pets/<id>/` 下的 6 张贴纸（GIF），热插拔无需改代码。
- 每贴纸对齐偏移与作品图：`pet-manifest.json`（offsets + pics），
  `assets/pets/<id>/pics/<n>.png` 由双击画画随机弹出。
- 状态气泡：宠物上方粉色气泡显示 message + detail（项目 · 已完成 x/y 步 · 阶段）。
- SSE 实时推送：`/stream` 事件流 + 3s 轮询兜底；脉冲（SUCCESS/ERROR）本地回落。
- 桌面悬浮模式（`desktopMode`，默认开启）：**随包自带 Electron 运行时**
  （vendor/electron-win32-x64，约 221MB）透明置顶窗口，Fairy 桌面版与纯 DSH
  用户行为一致，零外部依赖；窗口支持拖动（位置记忆）、滚轮缩放、双击画画、
  右键关闭；随 host 退出自动关闭。
- 真实 DSH 事件驱动状态机（`session/event` → PetReducer → 消息流）。

### Architecture
- 状态机/协议/配置体系重写自 dsh-dafeiyu；素材管线源自 dsh-pet-remielle (Gin-7)。
- client bundle 不再内联 GIF（host 端点按需服务），lib/client.js 约 34KiB。

### Tests
- node --test 63 项：协议、状态机、文案、宿主快照、宠物注册表、SSE hub、
  桌面窗口后端探测与生命周期。

### Compatibility
- 已在 DSH 0.1.0-rc.5 源码环境实测：插件加载、宠物管理标签、SSE、
  Qt helper 桌面悬浮全部正常。
