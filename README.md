# DSH 插件：任务日历 × 会议纪要

两个配合使用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：

| 插件 | 作用 |
| :-- | :-- |
| **任务日历** `dsh-plugin-task-calendar` | 把确认过的事项变成日历任务，按开始/截止提醒；月历 + 甘特图看进度。 |
| **会议纪要** `dsh-plugin-meeting-minutes` | 实时录音转文字、导入腾讯会议纪要、AI 生成可视化纪要；确认待办后写入任务日历；会议结束自动入库本机录制。 |

## 一次装两个（推荐给最终用户）

在 Harness 的 **Plugins → Add plugin** 里输入：

```
@zhangguitao666/meeting-suite
```

安装后同时得到「会议纪要」和「任务日历」，⌘R 刷新页面即可。也可让 Agent 用 `plugin_manager install_bundle` 安装这个包。

两个插件也可以单独装：

```
dsh-plugin-meeting-minutes@1.0.0
dsh-plugin-task-calendar@1.0.0
```

## 通过插件市场安装（推荐）

1. 打开 Harness 左侧栏 **插件（Plugins）** → **Discover**。
   - 如果看不到 Discover：先在 **Experimental plugins** 里开启 **Custom plugin markets**。
2. 点 **Add index source**，填入市场索引地址：

   ```
   https://raw.githubusercontent.com/zhangguitao666/meeting-suite/main/market/index.json
   ```

3. 在列表里安装 **任务日历** 和 **会议纪要**，按提示确认。
4. 浏览器端插件需要重新加载网页后才会出现新面板（⌘R）。

> 市场条目使用 npm 源（`name@version`），安装时从 npm registry 拉取；也支持直接安装下面的 npm 包名。

## 直接安装单个插件（Plugins → Add plugin）

Harness 的 **Plugins → Add plugin** 支持 npm 包名，直接填：

```
@zhangguitao666/meeting-suite        # 一次装两个（推荐）
dsh-plugin-meeting-minutes@1.0.0     # 只要会议纪要
dsh-plugin-task-calendar@1.0.0       # 只要任务日历
```

安装后刷新页面（⌘R）即可使用。也可以对 Agent 说「用 plugin_manager 安装 @zhangguitao666/meeting-suite」。

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
