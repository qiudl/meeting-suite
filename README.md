# DSH 插件：任务日历 × 会议纪要

两个配合使用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：

| 插件 | 作用 |
| :-- | :-- |
| **任务日历** `dsh-plugin-task-calendar` | 把确认过的事项变成日历任务，按开始/截止提醒；月历 + 甘特图看进度。 |
| **会议纪要** `dsh-plugin-meeting-minutes` | 实时录音转文字、导入腾讯会议纪要、AI 生成可视化纪要；确认待办后写入任务日历；会议结束自动入库本机录制。 |

## 首选安装（一次装两个）

在 Harness 的 **Plugins → Add plugin** 里输入：

```
@zhangguitao666/meeting-suite
```

安装后同时得到「会议纪要」和「任务日历」，⌘R 刷新页面即可。

> 也可以让 Agent 用 `plugin_manager install_bundle` 安装这个包；这是最简单、最少步骤的安装方式。

## 通过插件市场安装（可选）

1. 打开 Harness 左侧栏 **插件（Plugins）** → **Discover**。
   - 如果看不到 Discover：先在 **Experimental plugins** 里开启 **Custom plugin markets**。
2. 点 **Add index source**，填入市场索引地址（两个地址任选其一）：

   ```
   https://raw.githubusercontent.com/zhangguitao666/meeting-suite/main/market/index.json
   https://cdn.jsdelivr.net/gh/zhangguitao666/meeting-suite@main/market/index.json
   ```

3. 在列表里安装 **会议套件（一键装两个）**，或单独安装「会议纪要」「任务日历」。
4. 按提示确认后刷新页面（⌘R）。

> 市场条目使用 npm 源（`name@version`），安装时从 npm registry 拉取。

## 单独安装其中一个（npm）

只要其中一个插件时，在 **Plugins → Add plugin** 输入：

```
dsh-plugin-meeting-minutes@1.0.0
dsh-plugin-task-calendar@1.0.0
```

## 手动安装（不使用市场 UI）

在 Harness 里让 Agent 调 `plugin_manager install_bundle`，target 填上面的 npm 包名即可；三个包都已发布到 npm registry。

## 仓库结构

```
dsh-plugin-task-calendar/   任务日历插件包
dsh-plugin-meeting-minutes/ 会议纪要插件包（本地 ASR + 自动入库）
meeting-suite/              伞包：依赖两个插件并插入两行，Add plugin 一次装两个
market/index.json           插件市场格式 1 索引（npm 源，由脚本生成）
scripts/build-market-index.mjs
```

## 更新发布

1. 修改代码，提升对应 `package.json` 的 `version`（伞包如果依赖新版本，也要同步提升）；
2. 依次 `npm publish --access public` 发布 `dsh-plugin-*` 和 `meeting-suite`；
3. 重新生成索引：

   ```bash
   node scripts/build-market-index.mjs \
     --repo https://github.com/zhangguitao666/meeting-suite
   ```

4. 提交 `market/index.json` 并 push。市场里会出现新版本（当前 DSH 只提示「Update available」，升级方式是先卸载再安装）。

## 开发自测

两个包都自带 `node --test` 用例（用 Harness 自带的 Node 24 运行）：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
cd dsh-plugin-task-calendar && "$NODE" --test "test/*.test.mjs"
cd ../dsh-plugin-meeting-minutes && "$NODE" --test "test/*.test.mjs"
```

## 许可

MIT，详见 [LICENSE](LICENSE)。
