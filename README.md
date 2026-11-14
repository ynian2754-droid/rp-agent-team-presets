# RP Agent Team 预设

这些预设用于电子爱里的 [RP Agent Team](https://github.com/ynian2754-droid/rp-agent-team)。「经历」增强版 0.3.19 需要插件 0.7.19 或更高，标准版 0.3.17 需要 0.7.16 或更高。在角色聊天中打开「角色团队 → 预设」，导入选定的 `.rp-team.json`，核对成员模型、角色资料和使用参数后应用。增强版可切换「完整协作」与「专注续写」，也可分别开启「自主生长」和「情节去套路」。

| 预设 | 文件 | 说明 |
| --- | --- | --- |
| 经历 | [lived-history.rp-team.json](lived-history.rp-team.json) | [使用说明](LIVED_HISTORY.zh-CN.md) |
| 经历 · 增强版 | [lived-history-plus.rp-team.json](lived-history-plus.rp-team.json) | [使用说明](LIVED_HISTORY.zh-CN.md) |
| 身处 | [situated-life.rp-team.json](situated-life.rp-team.json) | [使用说明](SITUATED_LIFE.zh-CN.md) |
| 局部生命感 | [local-aliveness.rp-team.json](local-aliveness.rp-team.json) | [设计稿](LOCAL_ALIVENESS_DESIGN.zh-CN.md)。换用其他角色时请先替换 `/character/self_known` 的角色资料。 |

[试演说明](trials/TRIALS.zh-CN.md) 对应 `trials/` 下的四份 `.rp-trial.json`，在「角色团队 → 试演」导入。经历的提示词源文件位于 `lived-history/prompts/`。

[本次更改说明](CHANGELOG.zh-CN.md)

## 开发

使用 Node.js 22 或更高版本。从本仓库根目录运行以下命令，第二个参数指向 RP Agent Team 源码检出目录。

```powershell
node ./lived-history/build.mjs <插件源码目录>
node ./tools/validate-situated-life.mjs <插件源码目录>
```
