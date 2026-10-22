# DSH 插件：任务日历 × 会议纪要

两个配合使用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：

| 插件 | 作用 |
| :-- | :-- |
| **任务日历** `dsh-plugin-task-calendar` | 把确认过的事项变成日历任务，按开始/截止提醒；月历 + 甘特图看进度。 |
| **会议纪要** `dsh-plugin-meeting-minutes` | 实时录音转文字、导入腾讯会议纪要、AI 生成可视化纪要；确认待办后写入任务日历；会议结束自动入库本机录制。 |

## 通过插件市场安装（推荐）

1. 打开 Harness 左侧栏 **插件（Plugins）** → **Discover**。
   - 如果看不到 Discover：先在 **Experimental plugins** 里开启 **Custom plugin markets**。
2. 点 **Add index source**，填入市场索引地址：

   ```
   https://raw.githubusercontent.com/zhangguitao666/dsh-plugins/main/market/index.json
   ```

3. 在列表里安装 **任务日历** 和 **会议纪要**，按提示确认。
4. 浏览器端插件需要重新加载网页后才会出现新面板（⌘R）。

> 市场条目用 Git 源安装：每个版本固定到一个提交 SHA，所以离线/后续更新都可追溯。安装时会从 GitHub 拉取对应包目录，不需要 npm 账号。

## 手动安装（不使用市场 UI）

在 Harness 里让 Agent 调 `plugin_manager install_bundle`，target 用固定提交的 Git 规格：

```
git+https://github.com/zhangguitao666/dsh-plugins.git#<commit>&path:/dsh-plugin-task-calendar
git+https://github.com/zhangguitao666/dsh-plugins.git#<commit>&path:/dsh-plugin-meeting-minutes
```

具体 `<commit>` 见 `market/index.json` 里对应版本的 `source.commit`。

## 仓库结构

```
dsh-plugin-task-calendar/   任务日历插件包（宿主 + 浏览器端）
dsh-plugin-meeting-minutes/ 会议纪要插件包（宿主 + 浏览器端 + 本地 ASR + 自动入库）
market/index.json           插件市场格式 1 索引（由脚本生成）
scripts/build-market-index.mjs
```

## 更新发布

1. 修改插件代码，必要时提升对应 `package.json` 的 `version`；
2. 提交插件包：`git add -A && git commit -m "..."`；
3. 用**新提交**重新生成索引：

   ```bash
   node scripts/build-market-index.mjs \
     --repo https://github.com/zhangguitao666/dsh-plugins \
     --commit "$(git rev-parse HEAD)"
   ```

4. 提交索引 `market/index.json` 并 push。市场里会出现新版本（当前 DSH 只提示「Update available」，升级方式是先卸载再安装）。

## 开发自测

两个包都自带 `node --test` 用例（用 Harness 自带的 Node 24 运行）：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
cd dsh-plugin-task-calendar && "$NODE" --test "test/*.test.mjs"
cd ../dsh-plugin-meeting-minutes && "$NODE" --test "test/*.test.mjs"
```

## 许可

MIT，详见 [LICENSE](LICENSE)。
