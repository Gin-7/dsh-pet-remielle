# dsh-pet-remielle · 蕾米埃尔桌宠（事件驱动版）

桌宠不是"抓页面 DOM 猜状态"，而是由 DSH **真实会话事件**驱动 —— 事件总线 → 纯状态机 → 类型化协议 → 可持久化配置。

- 多宠物注册表 + 状态气泡（项目/阶段/进度实时汇报）
- SSE 实时推送 + 桌面悬浮窗口（随包 Electron，纯 DSH 用户同样可用）
- 在 DSH 0.1.0-rc.5 实测通过；仅 Windows x64 支持桌面悬浮（其他平台回落页面内）

```
┌───────────────────────────── DSH Host ─────────────────────────────┐
│  session/event (global) ──► PetReducer ──► state/pulse/task 消息    │
│                                     │                              │
│   settings.register (schemastery)   │  最新状态 + 脉冲覆盖          │
│        │                            ▼                              │
│        │                 /plugins/dsh-pet-remielle/state  (GET) │
│        │                 /plugins/dsh-pet-remielle/stream (SSE) │
│        │                 /plugins/dsh-pet-remielle/config(GET/PATCH)│
│        │                 /plugins/dsh-pet-remielle/pets   (GET/PATCH)│
│        │                 /plugins/dsh-pet-remielle/assets/<petId>/<mood>.gif │
│        │                 /plugins/dsh-pet-remielle/pet-view(HTML，桌面窗口用)│
│                 /plugins/dsh-pet-remielle/desktop (POST start/stop) │
└────────┼───────────────────────────────────────────────────────────┘
         │ SSE 实时推送（断线自动重连，轮询降为 3s 兑底）
         │ 桌面模式：随包 Electron 透明置顶窗口（零外部依赖）
┌────────▼──────────────────────── Web 页面 ─────────────────────────┐
│  Pet UI：6 张贴纸随状态切换、状态气泡、拖动、右键菜单、暂停动画    │
│  设置 → 宠物管理：宠物注册表（启用/禁用、改名、设为当前、添加）     │
│  设置卡片：settings.plugin.item 槽位（缩放/透明度/锁定/子Agent/气泡/桌面悬浮）│
└────────────────────────────────────────────────────────────────────┘
```

## 特性一览

| 能力 | 说明 |
|---|---|
| 状态来源 | ✅ DSH `session/event` 真实事件，非 DOM 抓取 |
| 状态机 | ✅ PetReducer 纯函数（含 mood 映射，可单测） |
| 消息协议 | ✅ 类型化协议（protocol.js） |
| 配置 | ✅ schemastery 持久化 + 设置页卡片 |
| 多 Session 优先级 | ✅（等待确认 > 错误 > 工作 > 思考 > 空闲） |
| 显示层 | ✅ Web 页面（无 Python 依赖） |
| 实时推送 | ✅ SSE 流（断线自动重连 + 轮询兑底） |
| 状态气泡 | ✅ message + detail（项目 · 已完成 x/y 步 · 阶段） |
| 桌面悬浮 | ✅ 随包 Electron 透明置顶窗口（桌面模式） |
| 多宠物 | ✅ 设置 → 宠物管理（注册表 + 切换当前宠物） |
| 测试 | ✅ node --test |

> 桌面悬浮模式（`desktopMode`，默认开启）：使用 Electron 运行时拉起**透明、置顶、
> 无边框**的独立窗口显示宠物（pet-view 页面：浏览器引擎渲染 GIF 动画 + SSE 实时
> 气泡）——Fairy 桌面版与纯 DSH 用户行为完全一致。窗口支持拖动（位置自动记忆）、
> 点击穿透（透明区域不挡桌面操作）、双击画画、滚轮缩放；右键菜单固定在角色右上角
> （窄窗自动回落上方），可调大小/锁定/气泡开关/画画/关闭。关闭后页面内宠物自动
> 恢复；页面内宠物菜单也可反向拉起桌面窗（`/desktop/start`）。随 DSH host 退出
> 自动关闭。
>
> **Electron 运行时来源（按顺序探测）**：`DSH_PET_ELECTRON` 环境变量 →
> `vendor/electron-win32-x64/`（本目录不进 Git，见下方「桌面模式运行时」）→
> 系统已安装的 Electron → 均无则仅页面内展示。

## 状态 → 贴纸映射

| 贴纸 | 状态 | 触发事件 |
|---|---|---|
| 01 绘制中 | THINKING | assistant/chunk、assistant/message、双击画画 |
| 02 摸鱼中 | WORKING / ERROR | tool/call（按工具名分 searching/editing/testing/commanding） |
| 03 得意中 | PULSE SUCCESS（5s） | turn/end completed、绘制完成、点击互动 |
| 04 思考中 | THINKING | turn/start、step/start、tool/result 整理 |
| 05 等待中 | WAITING | approval/asked（审批等待）、ask_user_question（提问回答）、turn/end blocked |
| 06 待机中 | IDLE / DISCONNECTED | 空闲、turn/end aborted/completed 之后 |

多 Session 同时运行时按 `等待确认 > 错误 > 工作 > 思考 > 空闲` 优先级展示最需要关注的顶层任务；
子 Agent 默认忽略（可在设置里开启）。

## 安装

适用于 **DSH / DeepSeek Harness**（含 Fairy 等基于 DSH 的分支）的 web profile：

```powershell
# 方式一：本地目录（开发调试，link 安装）
dsh plugin --profile web add D:\path\to\dsh-pet-remielle

# 方式二：npm 包（发布后）
dsh plugin --profile web add dsh-pet-remielle

# 方式三：GitHub Release tgz（发布后）
dsh plugin --profile web add "C:\Users\you\Downloads\dsh-pet-remielle-<version>.tgz"
```

插件行 id：`dsh-pet-remielle`。卸载即复原，无残留。

> **从旧版（v2，行 id `dsh-pet-remielle-v2`）升级**：必须**先卸载旧版再安装新版**
> （`dsh plugin --profile web remove dsh-pet-remielle-v2` 后重新 `add`），
> 否则安装记录里的行 id 仍是旧名，而 client bundle 按新名注册，DSH 前端会报
> `loaded without registering "dsh-pet-remielle-v2" via __ModuleLoader__.load`。
> 重新安装后旧配置需重设一次。

### 平台能力

| 平台 | 桌面悬浮窗口 | 页面内宠物 | 说明 |
| --- | --- | --- | --- |
| Windows x64（Fairy 桌面版 / 纯 DSH 均可） | ✅ Electron 透明置顶窗口 | 自动隐藏 | GIF 由浏览器引擎渲染，所有用户一致体验 |
| macOS / Linux | ❌ | ✅ | 未打包该平台 Electron，自动回落页面内 |

`desktopMode` 设置（默认开启）控制桌面悬浮；关闭后始终使用页面内展示。

### 桌面模式运行时（vendor/Electron）

桌面悬浮窗口需要 Electron 运行时，但完整运行时（约 221MB，含 184MB 的
electron.exe）超出 GitHub 100MB 单文件限制，因此**不进 Git 仓库**。获取方式：

1. 从本项目 Release 附件下载 `electron-win32-x64.zip`（若有），解压到
   `vendor/electron-win32-x64/`；或
2. 自行用任意 Electron 33 win32-x64 发行包解压到该目录（或设置
   `DSH_PET_ELECTRON` 指向现有 electron.exe）；或
3. 不提供运行时：桌面模式自动不可用，宠物在页面内展示（功能完整，仅无悬浮窗）。

### 依赖与兼容性

- 依赖 `@deepseek-ai/schemastery`（DSH 内置）与 `@deepseek-ai/cordis`（peer）
- 使用 DSH 官方扩展点：`session/event` 总线、`settings.register`（live 应用）、
  `webServer.register`（exact/prefix 路由）、client `settings.section` /
  `settings.plugin.item` 槽位、`window.__ModuleLoader__` 加载
- 已在 DSH 0.1.0-rc.5 源码环境实测通过（见 README 兼容性说明）
- 无 webServer 的 CLI/headless 模式不会挂载（web 插件预期行为）

## 开发

```powershell
npm install
npm test          # node --test（协议/文案/状态机/宿主快照/注册表/流/桌面窗口）
npm run check     # 语法检查
npm run build:client   # 重新生成 lib/client.js（贴纸由 host 端点提供，不再内联）
```

### 目录结构

```
src/
├── index.js          # 宿主：配置注册、事件接线、config/state/pets/assets 端点、清理
├── pet-reducer.js    # 纯状态机：session 事件 → state/pulse/task 消息（可单测）
├── protocol.js       # 类型化协议：PetState / PetMood / PetMessageKind
├── pets.js           # 宠物注册表：目录发现/合并/校验纯函数（可单测）
├── status-copy.js    # 蕾米埃尔风格状态文案（可整体替换）
├── desktop-window.js # 桌面模式：Electron 发现 + 宠物窗口进程管理（可单测）
├── pet-window.js     # 桌面模式：Electron main 入口（透明置顶窗口）
├── pet-view.html     # 桌面模式：宠物窗口页面（GIF + 气泡 + SSE 订阅）
└── client.core.js    # 浏览器端：宠物管理页 + 宠物 UI + 设置卡片（构建时包装）
lib/client.js         # 构建产物（已提交，安装无需构建；不含 GIF）
assets/pets/remielle/  # 6 张 GIF（01–06，素材版权见 NOTICE）
assets/pets/xiaoleimi/ # 小蕾米：7 张高清 GIF + 15 张虚狩绘本（pet-manifest.json 含偏移）
scripts/build-client.mjs
test/                 # node --test 测试
```

## 宠物管理（设置 → 宠物管理）

插件自带一个独立的设置标签页（`settings.section`，id `pets`），用来管理你的桌宠收藏：

- **启用/禁用**：未启用的宠物不会展示；
- **设为当前**：一次只展示一只宠物，切换即时生效；
- **改名**：显示名独立于目录名；
- **添加新宠物**：把 6 张状态贴纸放进 `assets/pets/<id>/`（01.gif–06.gif），然后点"添加并启用"即可。
  也可以先登记名字、后补贴纸。

宠物定义约定：

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
assets/pets/<id>/07.gif          额外贴纸槽位（小蕾米用：拿笔待机）
assets/pets/<id>/pet-manifest.json  每贴纸对齐偏移 offsets + 作品图数量 pics
assets/pets/<id>/pics/<n>.png    作品图（双击宠物随机弹出，n 从 1 开始）
```

`id` 只能包含字母、数字、下划线、连字符。贴纸由 host 端点
`/plugins/dsh-pet-remielle/assets/<petId>/<mood>.gif` 提供，client bundle 不再内联 GIF。

已内置宠物：**蕾米埃尔**（remielle，当前素材为 ZanyZebra 高清版：7 张 GIF
+ 15 张虚狩绘本，带每贴纸对齐偏移；双击触发画画动画并随机弹出作品图；
素材来源见 NOTICE）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| enabled | true | 启用桌宠（关闭后立即隐藏） |
| scale | 1 | 角色大小 50%–200% |
| opacity | 1 | 透明度 30%–100% |
| locked | false | 锁定位置 |
| includeSubagents | false | 允许子 Agent 抢占宠物状态 |
| activePetId | remielle | 当前展示的宠物 |
| pets | [remielle] | 宠物注册表（id/name/enabled） |

设置入口：DSH 设置 → **宠物管理**（宠物级操作）；DSH 设置 → 插件 → 插件配置 →
**蕾米埃尔桌宠**（全局外观）；右键宠物菜单也可即时调锁定/隐藏/暂停。

## 许可与素材版权

代码按个人学习用途分发；蕾米埃尔形象与 GIF 素材版权归米哈游（HoYoverse）所有，
**禁止商业使用与再分发素材**。详见 `NOTICE`。
