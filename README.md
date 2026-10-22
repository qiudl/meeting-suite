# 会议套件：会议纪要 × 任务日历

两个配合使用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，外加一个让 AI 在会议场景里**自动选对工具**的配套 Skill。

| 组件 | npm 包 | 作用 |
| :-- | :-- | :-- |
| **会议纪要** | `dsh-plugin-meeting-minutes` | 实时录音转文字、导入腾讯会议纪要、AI 生成可视化纪要、确认待办、会议结束自动入库。 |
| **任务日历** | `dsh-plugin-task-calendar` | 把确认过的事项变成日历任务，按开始/截止提醒；月历 + 甘特图看进度。 |
| **会议套件（伞包）** | `@zhangguitao666/meeting-suite` | 一次安装上面两个插件，并附带 AI Skill。 |
| **配套 Skill** | 随会议纪要插件自动注册 | `meeting-minutes-workflow`：告诉 AI 何时转录、何时总结、何时必须等用户确认再把待办写进日历。 |

> **一句话**：装「会议套件」→ 开会/贴纪要 → 对 AI 说“整理一下，待办加到日历” → AI 调工具完成，并在写日历前等你确认。

---

## 目录

- [功能总览](#功能总览)
- [安装](#安装)
  - [首选：一次装两个](#首选一次装两个)
  - [通过插件市场安装](#通过插件市场安装)
  - [单独安装其中一个](#单独安装其中一个)
  - [本地开发安装](#本地开发安装)
- [5 分钟上手](#5-分钟上手)
- [配套 AI Skill（重点）](#配套-ai-skill重点)
- [工具参考](#工具参考)
- [会议自动入库](#会议自动入库)
- [数据、隐私与权限](#数据隐私与权限)
- [架构说明](#架构说明)
- [配置](#配置)
- [常见问题](#常见问题)
- [开发与测试](#开发与测试)
- [发布流程（维护者）](#发布流程维护者)
- [仓库结构](#仓库结构)
- [版本记录](#版本记录)
- [许可](#许可)

---

## 功能总览

### 会议纪要

| 能力 | 说明 |
| :-- | :-- |
| **实时录音转文字** | 在面板里点录音，边录边出字；录音在后台进行，可以继续操作软件。 |
| **导入腾讯会议纪要** | 把腾讯会议导出的纪要/聊天记录/转写文本贴进来，原文入库后再 AI 总结。 |
| **转写本地录音/视频** | 支持 `wav/mp3/m4a/mp4/aac` 等；非 16kHz WAV 会先转码，再走本机 SenseVoice。 |
| **AI 结构化纪要** | 一句话结论、概述、关键要点、决策、风险、分节纪要、参会人、待办。 |
| **标题自动优化** | 先用默认/临时标题，`meeting_summarize` 时若标题过于通用会自动生成更合适的标题，之后仍可修改。 |
| **待办确认** | 待办先展示，用户确认后才写入任务日历；支持负责人/截止时间/优先级。 |
| **可视化纪要** | 独立 HTML（可直接打开/打印/分享）和 Markdown 导出。 |
| **会议结束自动入库** | 监控本机腾讯会议录制目录和额外目录，发现新录制自动转写、建会议记录，等你有空再整理。 |
| **配套 AI Skill** | 安装即注册，AI 在会议/待办场景会主动加载工作流，而不是等你教它用哪个工具。 |

### 任务日历

| 能力 | 说明 |
| :-- | :-- |
| 日历任务 | 标题、开始/截止时间、优先级、状态、负责人、备注、标签。 |
| 提醒 | 到期前按天/小时提醒，开始前提醒，逾期每日提醒。 |
| 视图 | 月历 + 甘特图；按状态/优先级/负责人筛选。 |
| 来源追溯 | 任务可带来源（如某场会议纪要），方便回查。 |
| 完成 | 标记完成会记录完成时间并停止提醒。 |

---

## 安装

### 首选：一次装两个

在 Harness 左侧 **Plugins → Add plugin** 里输入：

```
@zhangguitao666/meeting-suite
```

确认安装后按提示刷新页面（⌘R）。你会同时得到：

- 侧栏「会议纪要」面板
- 侧栏「任务日历」面板
- 配套 AI Skill `meeting-minutes-workflow`
- 会议纪要→任务日历的待办写入能力

也可以对 Agent 说：

> 用 plugin_manager 安装 `@zhangguitao666/meeting-suite`

安装器会自动把两个插件作为依赖装好，并把它们插入当前 profile 的插件列表。

### 通过插件市场安装

1. 打开 **Plugins → Discover**。
   - 看不到 Discover 时，先在 **Experimental plugins** 里开启 **Custom plugin markets**。
2. 点 **Add index source**，填入：

   ```
   https://raw.githubusercontent.com/zhangguitao666/meeting-suite/main/market/index.json
   ```

   国内网络访问 raw 不稳定时可用：

   ```
   https://cdn.jsdelivr.net/gh/zhangguitao666/meeting-suite@main/market/index.json
   ```

3. 在列表里安装 **会议套件（一键装两个）**；也可以单独安装「会议纪要」「任务日历」。
4. 刷新页面（⌘R）。

> 市场条目使用 npm 源（`name@version`），安装时从 npm registry 拉取。

### 单独安装其中一个

在 **Plugins → Add plugin** 输入：

```
dsh-plugin-meeting-minutes@1.1.0
```

或：

```
dsh-plugin-task-calendar@1.0.0
```

只装会议纪要时，待办写入日历的能力会不可用（插件会明确提示）；需要两个一起用时请装套件。

### 本地开发安装

开发时可以把工作区目录链接进 profile，改代码后通过停用/启用 bundle 重新加载宿主模块：

```bash
# 在 Harness 的插件页操作，或让 Agent：
plugin_manager install_bundle /绝对路径/dsh-plugin-meeting-minutes
plugin_manager install_bundle /绝对路径/dsh-plugin-task-calendar
```

浏览器端插件需要刷新页面（⌘R）才会加载新面板。宿主代码改动后停用再启用对应 bundle 即可重新加载；已安装的 npm 版本不会热替换 JS 模块，升级后需要重启应用。

---

## 5 分钟上手

### 场景 A：把一段会议文本变成纪要和待办

1. 把会议纪要/聊天记录贴给 AI。
2. 说：

   > 帮我整理这场会议，待办加到日历。

3. AI 会：
   - `meeting_create` 存原文（不会把总结当原文）；
   - `meeting_summarize` 生成结构化纪要；
   - 把待办列给你确认；
   - 你确认后 `meeting_push_todos` 写入任务日历。
4. 去「任务日历」就能看到任务和提醒；打开「会议纪要」可以导出 HTML。

### 场景 B：录音转纪要

1. 打开「会议纪要」面板 → 录音（或把录音文件路径给 AI）。
2. 录音结束后 AI 可以自动总结，也可以说：

   > 把这段录音转成纪要。

3. 会议纪要在后台转写，完成后生成纪要；待办确认流程同上。

### 场景 C：只想加一条待办

直接说：

> 把“周五前给客户发报价单”加到日历，负责人张三。

AI 用 `calendar_add_tasks` 建任务；这条不依赖会议纪要。

### 场景 D：会议结束自动入库

1. 在「会议纪要」面板打开「自动入库」。
2. 插件会监控本机腾讯会议录制目录；也可以在设置里加额外目录。
3. 会议结束后新录制会自动转写并生成一条待整理会议，等你之后打开整理。
4. 对 AI 说“看看自动入库状态”会调 `meeting_auto_ingest action=status`。

---

## 配套 AI Skill（重点）

### 为什么需要 Skill

插件注册了工具，但 AI 不一定知道**什么时候该用、按什么顺序用、哪些步骤必须等用户确认**。Skill 解决三件事：

1. **发现**：用户贴会议文本、给录音、说“加待办”时，AI 能从技能目录匹配到 `meeting-minutes-workflow` 并加载。
2. **流程**：先存原文 → 再总结 → 展示待办 → 确认 → 写日历；避免顺序错误。
3. **护栏**：明确“绝不自动写入日历”“相对时间必须换算”“不要直接改 JSON”等规则。

### 它会自动出现在技能目录里

会议纪要插件启用后，宿主会通过 `ctx.skills.register(...)` 注册一个 runtime skill：

| 字段 | 值 |
| :-- | :-- |
| 名称 | `meeting-minutes-workflow` |
| 描述 | 把会议文本/录音整理成结构化纪要，并把确认后的待办写入任务日历。 |
| 触发场景 | 会议纪要、转写、腾讯会议导入、待办确认、加日历任务、会议自动入库。 |
| 来源 | `bundled`（随插件注册，无需单独安装 skill 文件） |

注册是插件生命周期的一部分：停用/卸载会议纪要插件，skill 自动从目录移除；重新启用会重新出现。

### 触发例子

- “这是今天的会议记录：…… 帮我整理，待办加到日历。”
- “把这个录音转成纪要。”
- “查一下上周产品会说了什么，把没完成的待办加到日历。”
- “会议结束自动入库开了吗？”
- “导出这场会议的 HTML 纪要。”

只是随口说“今天开了个会”而没有纪要/待办需求时，AI 不会强行整理。

### Skill 里的硬规则

- **待办必须经用户确认才写日历**；AI 先展示编号清单，问“哪些写入”。
- 相对时间（“下周三前”“月底”）必须换算成具体日期；不确定就反问。
- 先存原文再总结；不要把 AI 总结当 `transcript`。
- 不要用文件读写直接改 `~/.dsh/storages/*.json`。
- 没装插件时不要假装有工具，提示安装套件。

### 怎么确认 Skill 生效

- 新开会话时，技能目录会多出 `meeting-minutes-workflow`。
- 直接对 AI 说“加载 meeting-minutes-workflow”，它会用 `skill` 工具读取并复述工作流。
- 如果没出现：确认会议纪要插件是启用状态，然后停用/启用一次插件或刷新页面。

---

## 工具参考

### 会议纪要工具

| 工具 | 主要参数 | 作用 |
| :-- | :-- | :-- |
| `meeting_list` | `query?`, `limit?` | 列出/搜索会议；返回标题、日期、参会人、是否已总结、待办写入进度。 |
| `meeting_get` | `id?` / `match?`, `includeTranscript?` | 读完整纪要；需要核对原文时打开 `includeTranscript`（最多 6000 字）。 |
| `meeting_create` | `title`, `date?`, `attendees?`, `transcript`, `sourceType?`, `notes?` | 新建会议，`transcript` 放原文。 |
| `meeting_transcribe` | `audioPath`, `title?`, `date?`, `attendees?`, `language?` | 把本机录音/视频转文字并新建会议。 |
| `meeting_summarize` | `id?` / `match?` | 用当前默认模型生成/重新生成结构化纪要；标题过通用时自动优化标题。 |
| `meeting_push_todos` | `id?` / `match?`, `todoIds?` | 把确认过的待办写入任务日历；不传 `todoIds` 表示全部未写入的。 |
| `meeting_export` | `id?` / `match?`, `format?` | 导出 HTML / Markdown，返回文件路径。 |
| `meeting_auto_ingest` | `action`, `dirs?` | 自动入库：`status` / `enable` / `disable` / `scan` / `set_dirs`。 |

### 任务日历工具

| 工具 | 主要参数 | 作用 |
| :-- | :-- | :-- |
| `calendar_add_tasks` | `tasks[]`, `source?` | 批量建任务；每条可带开始/截止/优先级/负责人/备注/标签。 |
| `calendar_list_tasks` | `range?`, `status?`, `query?` | 按今天/本周/本月/逾期/未完成等查看任务。 |
| `calendar_update_task` | `id?` / `match?`, `title?`, `start?`, `due?`, `status?`, `priority?`, `owner?`, `notes?`, `tags?` | 改任务；`start`/`due` 传空字符串可清除。 |
| `calendar_delete_task` | `id?` / `match?` | 删除任务（不可撤销）。 |
| `calendar_reminder_config` | `leadDays?`, `leadHours?`, `startLeadMinutes?`, `overdueDailyHour?`, `systemNotify?`, `maxAlerts?` | 查看/修改提醒规则。 |

---

## 会议自动入库

### 它监控什么

- **腾讯会议本机录制**：读取腾讯会议客户端的本地录制数据库，发现已完成的本地录制后自动导入。
- **额外目录**：通过 `meeting_auto_ingest action=set_dirs` 添加；支持 `audio/video/txt/md/docx` 文件。
- 云端“智能纪要”没有个人 API；自动入库抓的是**本机文件**。没有本地录制时，把导出的纪要文件放进监控目录即可。

### 状态与开关

让 AI 说：

> 看看会议自动入库状态。

会返回：是否启用、腾讯录制数据库是否可用、监控目录、已自动导入数量、扫描状态等。

常用操作：

```
meeting_auto_ingest action=enable
meeting_auto_ingest action=disable
meeting_auto_ingest action=scan
meeting_auto_ingest action=set_dirs dirs=["~/Downloads/meetings"]
```

### 自动导入后的状态

自动导入的会议带“自动入库/待整理”标记，不会自己总结；等你打开面板或让 AI 整理时再生成纪要。这样可以解决“会议很急、整理很慢”的时差。

---

## 数据、隐私与权限

### 数据位置

| 数据 | 路径 |
| :-- | :-- |
| 会议纪要库 | `~/.dsh/storages/meeting-minutes.json` |
| 任务日历 | `~/.dsh/storages/task-calendar.json` |
| 导出文件 | 会议纪要面板/工具选择的位置（HTML/MD） |
| 自动入库配置 | 存在会议纪要库的 `autoIngest` 字段 |

### 隐私

- 录音转写默认走**本机 SenseVoice**，音频不离开电脑（具体取决于 Harness 的 speech-to-text 配置）。
- AI 总结走当前默认模型；纪要文本会发给该模型。
- 自动入库只读本机文件；不会上传腾讯会议云端数据。
- 两个插件都不主动联网，除了调用 Harness 的 LLM/ASR 服务和任务日历的 loopback 接口。

### 权限

- 插件通过 `plugin_manager` 安装，运行在 Harness 宿主里。
- 任务日历接口监听 loopback（`127.0.0.1`），只接受本机请求。
- 删除任务不可撤销；AI 的 skill 要求删除前确认。

---

## 架构说明

### 会议纪要

```
lib/index.js        宿主入口：组装 store/asr/summarizer/calendar/autoIngest，
                    注册 HTTP 路由、工具和配套 Skill
lib/server.js       /dsh-meeting/* JSON API（面板使用）
lib/store.js        会议纪要持久化（JSON）
lib/asr.js          speechToText 适配（SenseVoice）
lib/audio.js        WAV 规范化/转码
lib/summarize.js    LLM 总结，标题优化
lib/calendar.js     调用任务日历 loopback API
lib/autoingest.js   腾讯录制数据库 + 监控目录
lib/tools.js        8 个 meeting_* 工具
lib/skill.js        配套 Skill 注册与内容
lib/client.js       浏览器端面板（录音、列表、纪要、待办、导出、自动入库）
```

浏览器端通过 `dsh.client` 声明被 Harness 的 client module system 发现，不需要额外 loader 行。宿主通过 `ctx.webServer` 提供 `/dsh-meeting` 路由。

依赖的宿主服务：`tools`、`webServer`；可选：`speechToText`、`llm`、`skills`。

### 任务日历

```
lib/index.js        宿主入口
lib/server.js       /dsh-task-calendar/* JSON API
lib/store.js        任务持久化（JSON）
lib/model.js        日期/提醒/状态模型
lib/tools.js        5 个 calendar_* 工具
lib/client.js       月历 + 甘特图面板
```

### 两个插件如何配合

会议纪要插件不直接读日历的 JSON，而是调用任务日历的 loopback HTTP 接口：

```
POST http://127.0.0.1:<port>/dsh-task-calendar/tasks
```

这样两个插件可以独立安装/升级；未安装任务日历时，会议纪要会明确提示而不是静默失败。

---

## 配置

### 会议纪要

- 标题：新建时可用默认/临时标题；总结时自动优化通用标题。
- 音频：`wav/mp3/m4a/mp4/aac` 等；非 16kHz 单声道 WAV 会先规范化。
- 语言：`meeting_transcribe` 的 `language` 默认 `zh`。
- 自动入库：见上一节。

### 任务日历

- 提醒默认：到期前 3/1 天、2 小时，开始前 30 分钟，逾期每天 9 点（以插件内为准）。
- 状态：`todo/doing/done`；优先级：`high/normal/low`。
- 时间支持自然语言（“明天 09:30”“下周三”），由工具解析成具体日期。

---

## 常见问题

### 安装后侧栏没有面板？

- 浏览器端插件需要刷新页面（⌘R）。
- 确认插件在 **Plugins → Installed** 里是启用状态。
- 检查 profile 是否同时装了独立插件和套件，导致重复/冲突。

### 输入 `@zhangguitao666/meeting-suite` 提示找不到？

- 确认网络能访问 npm registry。
- 确认 Harness 版本 ≥ `0.2.1-rc.2`。
- 也可以改用插件市场索引安装。

### 录音转写失败？

- 确认 Harness 的 speech-to-text 服务可用（默认本地 SenseVoice）。
- 音频格式不支持时先转成 16kHz 单声道 WAV。
- 长音频会自动切片；失败时看插件日志里的具体错误。

### 待办没有写进日历？

- 先确认任务日历插件已安装并启用。
- AI 必须先让你确认待办；确认后再调 `meeting_push_todos`。
- 重复推送不会重复创建已写入的待办。

### 自动入库没反应？

- 腾讯会议必须开启了“本地录制”，且录制文件已完成。
- 用 `meeting_auto_ingest action=status` 看 `tencentAvailable` 和监控目录。
- 没有本地录制时，把导出的纪要文件放进监控目录，再 `action=scan`。

### 能离线用吗？

转写可以（本地 SenseVoice）；AI 总结需要模型服务。

---

## 开发与测试

使用 Harness 自带的 Node 24：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"

cd dsh-plugin-task-calendar
"$NODE" --test "test/*.test.mjs"

cd ../dsh-plugin-meeting-minutes
"$NODE" --test "test/*.test.mjs"
```

修改宿主代码后，在插件页停用/启用对应 bundle 重新加载；浏览器端改动刷新页面。`lib/skill.js` 的测试覆盖 skill 元数据和注册/注销。

---

## 发布流程（维护者）

1. 修改代码，按需提升版本：
   - `dsh-plugin-meeting-minutes/package.json`
   - `meeting-suite/package.json`（依赖版本也要同步）
2. 发布 npm（需要 npm 账号 2FA）：
   ```bash
   cd dsh-plugin-meeting-minutes && npm publish --access public
   cd ../dsh-plugin-task-calendar && npm publish --access public
   cd ../meeting-suite && npm publish --access public
   ```
3. 重新生成市场索引：
   ```bash
   node scripts/build-market-index.mjs \
     --repo https://github.com/zhangguitao666/meeting-suite
   ```
4. 提交并推送 `market/index.json`。
5. 在 Harness 的 Discover 里刷新，或卸载重装升级。

> npm 发布若遇到网页 2FA 授权，按终端提示在浏览器确认即可；`0.0.0-stage` 是 staged publishing 占位版本，`latest` 仍是正式版本。

---

## 仓库结构

```
dsh-plugin-meeting-minutes/
  lib/index.js          宿主入口（工具/路由/自动入库/配套 Skill）
  lib/skill.js          配套 AI Skill 内容与注册
  lib/server.js         /dsh-meeting API
  lib/client.js         会议纪要面板
  lib/asr.js            语音转写适配
  lib/summarize.js      LLM 总结
  lib/autoingest.js     会议自动入库
  lib/tools.js          meeting_* 工具
  test/                 node --test 用例（含 skill 测试）

dsh-plugin-task-calendar/
  lib/index.js          宿主入口
  lib/client.js         月历 + 甘特图
  lib/tools.js          calendar_* 工具
  test/

meeting-suite/
  package.json          伞包：依赖两个插件并插入两行
  cordis.patch.yml      插件行插入
  index.js              无行插件占位入口
  locale/ icon.svg

market/index.json       插件市场格式 1 索引（npm 源）
scripts/build-market-index.mjs
```

---

## 版本记录

### 1.1.0

- 会议纪要插件新增配套 Skill `meeting-minutes-workflow`，安装即注册。
- Skill 覆盖：会议文本/录音/已有会议/待办确认/日历/导出/自动入库的完整路由与护栏。
- 套件伞包同步升级，依赖 `dsh-plugin-meeting-minutes@1.1.0`。

### 1.0.0

- 首次发布：会议纪要 + 任务日历 + 套件伞包。
- 实时录音转写、腾讯会议纪要导入、AI 纪要、待办写日历、自动入库。
- 插件市场索引（npm 源）。

---

## 许可

MIT © zhangguitao666
