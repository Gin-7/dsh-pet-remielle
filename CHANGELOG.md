# Changelog

## [Unreleased]

余额与今日已用（借鉴 dsh-whale-widget 的余额/用量思路）+ 气泡双页翻页：

### Features
- 消息气泡双页翻页（状态 / 余额）：气泡右上角圆点导航，点击圆点或气泡上滚轮循环翻页；仅双开时才显示圆点，单开自动锁定对应页。
- 消息气泡开关分组（设置 → 宠物管理 → 行为）：总开关 + 「状态」「用量」子开关；任一子开关打开→总开关自动打开、全部关闭→总开关自动关闭；总开关关闭→子开关全部关闭。
- 右键菜单「显示气泡」与设置总开关同步联动（网页 + 桌面）。
- 今日已用双模式：
  - **小鲸鱼记账**（默认，免令牌）：余额差值累计到 `$DSH_HOME/.dshp-usage.json`，跨天自动归零归档；
  - **实时·令牌**（精确）：配置 `DEEPSEEK_PLATFORM_TOKEN` 后直连平台用量接口，按峰谷定价（高峰 9–12、14–18 点）换算；令牌可填入设置（密码框）或走 DSH 凭据服务，附获取方法帮助弹窗（平台 Local Storage 的 userToken）。
- 桌面右键菜单点击外部区域自动关闭。

### Fixes
- 修复双开时在余额页关闭「用量」后气泡仍显示余额（状态页文本节流缓存未清空导致余额残留）。
- 修复余额数据与气泡渲染的竞态（余额控制器只存数据，渲染统一由 updateBubble 按当前页决定；进入余额页延迟拉取，避免同步重入）。
- 修复状态/余额单开切换时气泡显示错乱（自动跳页 + 清缓存）。
- 修复设置中的「暂停动画 / 隐藏桌宠」不生效（状态快照缺 `paused` / `hidden` 字段，现已下发并应用）。
- 移除气泡点击随机台词功能（与原交互冲突，单击桌宠仅切换心情）。

### Architecture
- 新增 `src/balance.js`（宿主余额服务：拉取 / 缓存 / 重试 / 记账 / 峰谷定价）与 `src/balance-widget.js`（客户端余额控制器，无 DOM，只存数据）。
- 宿主注入 `credentials`；状态快照新增 `showBubbleStatus` / `showBubbleUsage` / `usageMode` / `platformToken` / `paused` / `hidden`；新增 `/balance` 与 `/balance-widget.js` 端点。

## [0.3.1] — 2026-08-19

基于 0.3.0（PR 作者版本）之上的增量迭代，涵盖最近几轮的完整功能与修复：

### Features
- 贴纸 / 状态映射完善：思考 04、输出 01、调工具 02；assistant/chunk 按 reasoning-delta / text-delta / tool-call-delta 区分贴纸。
- 「等待中 05」接入：ask_user_question（提问回答）、approval/asked（审批等待）、turn/end blocked（回合挂起）。
- 双击画画：粗笔刷沿对角来回揭示作品图（路径带随机、清晰无阴影），完成后「绘制中 → 得意中 → 淡出」；桌面版作品显示在屏幕右上角独立小窗。
- 桌面 / 网页模式切换与设置项同步，desktopMode 持久化（重启后保持上次选择）。
- 内置「版本检查 + 一键更新」：/check 、/update 、/info（GitHub 直连 + HTTP 代理回退）；≥ 0.3.0 的 link 一键 git pull、registry 一键 pnpm update，< 0.3.0 提示彻底卸载重装。
- 设置 → 宠物管理 → 更新：当前版本 / 检查更新 / 一键更新 / 升级说明；右下角更新气泡 + 更新卡片。
- 宠物管理 → 外观 → 添加新宠物：加「开发中」提示（上传功能未完善）。
- 设置卡片精简为仅「是否启用」并对齐标准插件卡片样式。
- 气泡标题在 think/输出阶段按间隔刷新，不再逐 chunk 跳动。
- 移除网页版右键「隐藏桌宠」与右下角 pill 图标。
- 构建时注入版本号（RM_PLUGIN_VERSION）；反馈页显示版本；右键/设置同步。
- 桌面窗桌宠悬停 / 拖动指针（grab / grabbing）。
- README 彻底重写（特性 / 贴纸映射含 GIF 展示 / 安装 / 更新策略 / 桌面模式 / 发布到 npm）。

### Fixes
- 桌面窗 / 页面内关闭后重新开启时气泡与桌宠同步出现。
- 移除虚构的旧行 id dsh-pet-remielle-v2，改为真实历史（0.2.0 前 @dsh-external/dsh-client-ui-pet-remielle、0.2.0–0.3.0 dsh-pet-remielle）。

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
- 事件驱动状态机（`session/event` → PetReducer → 类型化协议 → 持久化配置）。
- client bundle 不再内联 GIF（host 端点按需服务），lib/client.js 约 34KiB。

### Tests
- node --test 63 项：协议、状态机、文案、宿主快照、宠物注册表、SSE hub、
  桌面窗口后端探测与生命周期。

### Compatibility
- 已在 DSH 0.1.0-rc.5 源码环境实测：插件加载、宠物管理标签、SSE、
  Qt helper 桌面悬浮全部正常。
