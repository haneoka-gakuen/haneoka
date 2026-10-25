# Haneoka 开发导航

先读 [AGENTS](../AGENTS.md) 与 [L1](../L1.md)。本文件负责任务路由和验证方法，目录职责由各地图维护。

## 按任务进入

| 任务 | 入口 |
| --- | --- |
| 页面路由、壳、静态首屏 | [Pages](../src/pages/L2-2.md) → [Components](../src/components/L2-2.md) → [构建数据](../src/server/L2-2.md) |
| 目录、跨服、搜索和实体 | [Lib](../src/lib/L2-2.md) → [Cross-server](../src/lib/cross-server/L2-2.md) → [Lit](../src/lit/L2-2.md) |
| 配队、Box、导入、搜索 | [Team builder](../src/lib/team-builder/L2-2.md)，先分清 WASM 主路径、TS solver 和持久文档 |
| 播放器、故事、谱面与创作 | [Runtime](../src/lit/runtime/L2-2.md) → [Packages](../packages/L2.md) |
| UI、文案、主题与样式 | [UI](../src/lit/ui/L2-2.md)、[I18n](../src/i18n/L2-2.md)、[Styles](../src/styles/L2-2.md) |
| 账户、社区、上传、媒体、后台任务 | [Worker](../worker/L2.md) → [媒体服务](../packages/community-media/L2-2.md) |
| 数据库 | [D1](../worker/database/L2-2.md) → [数据库操作](../worker/database/README.md) |
| 游戏资源、release、发布与清理 | [Scripts](../scripts/L2.md) → [操作说明](../scripts/README.md) |
| 本地预览和代理 | [Server](../server/L2.md)、[Tooling](../tooling/L2.md) |
| 构建和发布工作流 | [CI](../.github/L2.md) |

## 环境和副作用

版本、命令与依赖以 [package.json](../package.json)、[pnpm-workspace.yaml](../pnpm-workspace.yaml)、锁文件和 [CONTRIBUTING](../CONTRIBUTING.md) 为准。完整前端需要锁定的外部仓库、工作区依赖和 Rust/WASM 工具链；对应媒体功能还需授权 release／runtime。新 clone 不自动具备这些输入。

`dependencies:checkout` 会下载外部仓库，安装会写依赖，构建可联网并生成产物，`pnpm dev` 也先准备前端。资源 pipeline、数据库和发布命令有各自副作用；在实际授权范围内执行。纯 GEB 验证仅需 Python 标准库与 Git，不初始化外部依赖。

## 开发与验证命令

以下在仓库根执行；按改动选择，不把全表当作每轮必跑清单。

| 改动 | 检查 |
| --- | --- |
| 文档、地图、文件头 | `python scripts/verify/geb.py`；`python -m unittest discover -s scripts/verify -p test_geb.py`；`git diff --check` |
| 仅文档／L3、需证明业务正文未变 | `python scripts/verify/geb.py --base <修改前提交>`；日常业务修改不使用此限制 |
| 前端与跨包类型 | `pnpm typecheck`；含包构建，须完整外部依赖 |
| Worker、执行工具 | `pnpm typecheck:worker`、`pnpm typecheck:downloads`、`pnpm typecheck:tools`、`pnpm types:worker:check`、`pnpm types:downloads:check`；按改动选择 |
| lint | `pnpm lint:frontend`、`pnpm lint:services`、`pnpm lint:packages`、`pnpm lint:sonolus` |
| 应用构建 | `pnpm build`；许可 runtime 可选策略及安装步骤见 README，不跳过资源前提 |
| Garupa 工具 | `python -m unittest discover -s scripts/garupa_master/tests -t .` |
| 特定包 | 阅读该包 `package.json` 的 build／typecheck／check，再运行对应 filter |
| 本地服务 | `pnpm dev:worker`、`pnpm dev`、`pnpm preview`，需要对应构建／资料／绑定 |

根 CONTRIBUTING 中如有与 package scripts 不一致的历史命令，以当前声明核对；不要报告不存在命令的通过结果。现有主 CI 执行构建和指定 Python 测试，独立 GEB CI 只验证导航，二者都不自动证明全仓 typecheck／lint 或生产可用。

## 验收边界

可见 UI 按 AGENTS 检查桌面 1280px、手机 360–412px、明暗主题，包含加载、空值、错误和长文本。SSR 与水合变化检查首次渲染和交互接管；媒体需真实授权样本，账户／数据库／队列需对应环境。

记录实际运行、未运行和受阻的检查，区分纯导航、源码语法、业务回归、真实素材与生产状态。不为验证地图启动资源发布、真实账户操作或数据库迁移。维护方法见 [GEB 指南](GEB使用与维护指南.md)，文档所有权见 [Docs](L2.md)。
