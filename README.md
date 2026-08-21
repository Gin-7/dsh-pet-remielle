# dsh-pet-remielle · 蕾米埃尔桌宠

[![npm version](https://img.shields.io/npm/v/dsh-pet-remielle)](https://www.npmjs.com/package/dsh-pet-remielle)
[![awesome dsh plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

由 **DSH 真实会话事件**驱动的多宠物网页桌宠：桌宠实时跟随 DeepSeek Harness 的任务进展，以贴纸动画 + 状态气泡呈现。

- 多宠物注册表 + 状态气泡（项目 / 阶段 / 待办 / 进度实时汇报）
- SSE 实时推送 + 可选的桌面悬浮窗（随包 Electron，透明置顶）
- 双击画画联动：粗笔刷揭示作品图（绘制中 → 得意中 → 淡出）
- 一键版本检查 + 增量更新
- 设置面板：宠物管理（多标签页）、插件配置卡片

> 兼容 DeepSeek Harness（含其分支）的 web profile；桌面悬浮模式默认关闭，可按需开启。

---

## 特性一览

| 能力 | 说明 |
|---|---|
| 状态来源 | DSH `session/event` 真实事件，非 DOM 抓取 |
| 状态机 | `PetReducer` 纯函数（含 mood 映射，可单测） |
| 消息协议 | 类型化协议（protocol.js） |
| 配置 | schemastery 持久化 + 设置页卡片 |
| 多 Session 优先级 | 未读完成提醒 > 等待/错误 > 当前会话 > 状态优先级 > 更新时间 |
| 实时推送 | SSE 流（断线自动重连 + 轮询兜底） |
| 状态气泡 | 页面内模式使用自适应两层牌叠：顶层状态卡 + 带 `+N` 的汇总背板；message + detail（项目 · 已完成 x/y · 阶段） |
| 会话操作 | `✓` 允许一次；`?` / `!` 打开对应会话；完成提醒显示左侧绿点 |
| 完成提醒 | 后台会话完成后保留至打开该会话；当前已打开会话不显示未读绿点（仅当前 Host 生命周期） |
| 桌面悬浮 | 随包 Electron 透明置顶窗口（可选，默认关） |
| 多宠物 | 设置 → 宠物管理（注册表 + 切换当前宠物） |
| 版本更新 | 内置检查 + 一键增量更新 |

---

## 贴纸（mood）→ 状态映射

| 贴纸 | 展示 | 触发场景 |
|---|---|---|
| 01 绘制中 | <img src="assets/pets/remielle/01.gif" width="56" alt="01 绘制中"/> | THINKING + streaming：流式输出（正在写回复）、双击画画 |
| 02 摸鱼中 | <img src="assets/pets/remielle/02.gif" width="56" alt="02 摸鱼中"/> | WORKING / ERROR：调用工具（查找/编辑/测试/命令） |
| 03 得意中 | <img src="assets/pets/remielle/03.gif" width="56" alt="03 得意中"/> | PULSE SUCCESS：回合完成、绘制完成、点击互动 |
| 04 思考中 | <img src="assets/pets/remielle/04.gif" width="56" alt="04 思考中"/> | THINKING：回合/步骤开始、推理、结果整理 |
| 05 等待中 | <img src="assets/pets/remielle/05.gif" width="56" alt="05 等待中"/> | WAITING：提问回答、审批等待、回合挂起（blocked） |
| 06 待机中 | <img src="assets/pets/remielle/06.gif" width="56" alt="06 待机中"/> | IDLE / DISCONNECTED：空闲、回合结束之后 |

多 Session 同时运行时按 `未读完成提醒 > 等待/错误 > 当前会话 > 状态优先级 > 更新时间` 选择顶层任务；其余会话由可点击的 `+N` 汇总背板表示。子 Agent 默认忽略（可在设置开启）。

### 宠物定义约定

```
assets/pets/<id>/01.gif  绘制中（输出/画画）
assets/pets/<id>/02.gif  摸鱼中（工具/错误）
assets/pets/<id>/03.gif  得意中（完成/互动）
assets/pets/<id>/04.gif  思考中
assets/pets/<id>/05.gif  等待中
assets/pets/<id>/06.gif  待机中
```

可选扩展（不影响完整性校验）：
```
assets/pets/<id>/07.gif           额外贴纸槽位
assets/pets/<id>/pet-manifest.json  每贴纸对齐偏移 + 作品图数量
assets/pets/<id>/pics/<n>.png      作品图（双击宠物随机弹出，n 从 1 起）
```

`id` 只能含字母、数字、下划线、连字符。内置宠物：**蕾米埃尔**（remielle，素材版权见 `NOTICE`）。

---

## 安装

适用于 **DSH / DeepSeek Harness**（含 Fairy 等基于 DSH 的分支）的 web profile。

```powershell
# 方式一：npm 注册表（推荐，可一键增量更新）
dsh plugin --profile web add dsh-pet-remielle

# 方式二：GitHub 仓库（构建安装，无版本校验）
dsh plugin --profile web add github:Gin-7/dsh-pet-remielle

# 方式三：本地目录（开发调试，link 安装）
dsh plugin --profile web add D:\path\to\dsh-pet-remielle

# 方式四：GitHub Release tgz
dsh plugin --profile web add "C:\Users\you\Downloads\dsh-pet-remielle-<version>.tgz"
```

插件行 id：`dsh-pet-remielle`。卸载即复原，无残留。

---

## 更新

插件内置「宠物管理 → 更新」页 + 右下角更新气泡：检查 GitHub 最新版本，发现新版可一键更新。

| 安装形态 | 版本 | 更新方式 |
|---|---|---|
| 本地链接（link） | ≥ 0.3.0 | 一键 `git pull`（增量） |
| npm 注册表（registry） | ≥ 0.3.0 | 一键 `pnpm update dsh-pet-remielle`（增量） |
| 任意形态 | < 0.3.0 | **不支持自动更新**：0.3.0 起包名已变更，需彻底卸载旧版本后重新安装 |

> 说明：0.3.0 之前存在**包名/行 id 变更**（0.2.0 之前为 `@dsh-external/dsh-client-ui-pet-remielle`，0.2.0–0.3.0 为 `dsh-pet-remielle`）。直接 `git pull`/`pnpm update` 无法跨过该变更，所以低于 0.3.0 **必须先卸载旧版再重装新版**（否则会出现 `loaded without registering … via __ModuleLoader__.load` 之类的加载报错）。命令如下：

```powershell
# 按实际安装的旧行 id 卸载（以下两条按需执行）
dsh plugin --profile web remove @dsh-external/dsh-client-ui-pet-remielle   # 0.2.0 及之前
dsh plugin --profile web remove dsh-pet-remielle                            # 0.2.0 – 0.3.0

# 重新安装最新版（npm 或 GitHub 均可）
dsh plugin --profile web add dsh-pet-remielle
# 或： dsh plugin --profile web add github:Gin-7/dsh-pet-remielle
```

> 在「设置 → 宠物管理 → 更新」中，低于 0.3.0 的版本点击「一键更新」也会给出同样的卸载/重装指引，不会直接覆盖升级。

---

## 桌面悬浮模式（可选）

`desktopMode` 默认关闭。开启后使用 Electron 运行时拉起**透明、置顶、无边框**的独立窗口显示宠物。

- 窗口支持拖动（位置自动记忆）、滚轮缩放、双击画画、右键菜单。
- 双击画画：作品显示在**桌面右上角**的独立小窗，粗笔刷沿对角来回揭示，完成后「得意中→淡出」。
- 右键菜单：切换网页模式、锁定、气泡开关、角色大小、画画等。
- 关闭/切换后自动回到页面内；随 DSH host 退出自动关闭。

**Electron 运行时来源（按顺序探测）**：`DSH_PET_ELECTRON` 环境变量 → `vendor/electron-win32-x64/`（本目录不进 Git）→ 系统已安装的 Electron → 均无则仅页面内展示。

> **首次运行**：若开启桌面悬浮模式但本机找不到 Electron 运行时，会**提示下载并安装**（需你确认，因 Electron 运行时约 200MB）；下载失败则自动回落页面内展示，不会影响其他功能。也可手动把任一 Electron win32-x64 发行包解压到 `vendor/electron-win32-x64/`，或设置 `DSH_PET_ELECTRON` 指向现有 `electron.exe`。

### 平台能力

| 平台 | 桌面悬浮窗 | 页面内桌宠 |
|---|---|---|
| Windows x64（Fairy 桌面版 / 纯 DSH） | ✓（Electron 透明置顶窗口） | 桌面模式下自动隐藏 |
| macOS / Linux | ✗ | ✓（自动回落页面内） |

---

## 使用

- **点击桌宠**：切换随机贴纸心情。
- **双击桌宠**：进入画画动画，绘制完成后在屏幕（右上角）弹出作品图，随后淡出。
- **右键桌宠（页面内）**：角色大小 / 锁定位置 / 显示气泡 / 桌面悬浮模式 / 重置位置 / 暂停动画。
- **右键桌宠（桌面窗）**：角色大小 / 锁定位置 / 显示气泡 / 画画 / 切换到网页模式。
- **滚轮**：调整角色大小。
- 页面内宠物菜单也可反向拉起桌面窗。

---

## 配置（设置 → 插件 → 蕾米埃尔桌宠）

| 字段 | 默认 | 说明 |
|---|---|---|
| enabled | true | 启用桌宠（禁用立即隐藏，重新启用恢复） |

其余外观/行为项（角色大小、透明度、锁定、气泡、桌面悬浮、暂停、隐藏……）统一放在「设置 → 宠物管理」与右键菜单中管理，不再重复展示在插件配置卡片里。

## 设置 → 宠物管理

宠物注册表独立标签页，含多个子页：**外观 / 行为 / 桌面悬浮 / 更新 / 反馈**。

- 启用/禁用宠物、设为当前、改名、添加新宠物。
- 「更新」：显示当前版本，检查更新、一键更新、查看升级说明。
- 「反馈」：显示桌宠版本号，提交 Bug / 功能建议。

---

## 开发

```powershell
npm install
node scripts/build-client.mjs    # 构建 lib/client.js（版本号从 package.json 注入）
npm test                          # node --test 单测
npm run check                     # 语法检查
```

### 目录结构

```
src/
├── index.js          # 宿主：配置、事件接线、config/state/pets/assets/desktop 端点、自更新路由
├── self-update.js    # 版本检查 + 一键更新（GitHub 直连 + HTTP 代理回退；git pull / pnpm update）
├── pet-reducer.js    # 纯状态机：会话事件 → state/pulse/task（可单测）
├── protocol.js       # 类型化协议：PetState / PetMood / PetMessageKind
├── pets.js           # 宠物注册表：目录发现/合并/校验（可单测）
├── status-copy.js    # 蕾米埃尔风格状态文案（可整体替换）
├── desktop-window.js # 桌面模式：Electron 发现 + 窗口进程管理（可单测）
├── pet-window.js     # 桌面模式：Electron main（透明置顶窗口 + 屏幕右上角作品窗）
├── pet-view.html     # 桌面模式：宠物窗口页面（GIF + 气泡 + SSE + 画画）
└── client.core.js    # 浏览器端：宠物 UI + 设置（构建时包装）
lib/client.js         # 构建产物（版本号注入，安装即用）
assets/pets/remielle/ # 蕾米埃尔素材（GIF + 作品图）
scripts/build-client.mjs
test/                 # node --test
```

### 发布到 npm

```powershell
npm login
pnpm version patch    # 升版本
pnpm pack --dry-run   # 检查发布内容（不含 node_modules / vendor）
pnpm publish
```

> 发布内容由 `files` 字段限定：`src/`、`lib/client.js`、`assets/`、`scripts/`、`test/`、`cordis.patch.yml`、`NOTICE`、`README.md`。`vendor/`（Electron 运行时）不发布，桌面模式按需下载。

---

## 许可与素材版权

代码以 MIT 许可分发；蕾米埃尔形象与 GIF/作品素材版权归米哈游（HoYoverse）所有，
**禁止商业使用与再分发素材**。详见 `NOTICE`。
