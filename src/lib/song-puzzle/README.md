# 歌曲华容道

`model.ts` 定义 3–8 阶、任意目标空格、可解性和按移动方块编号记录的路径。
`solver.ts` 编排精确搜索、分层归位与多策略缩短；`recognition.ts` 在浏览器 Worker 中匹配截图与封面。
无缝原作棋盘还以纯色空格反推格宽；双尺度不一致及相似纯色色块保留待确认标记。
不可解且存在视觉近似候选时，可由用户选择“校正相似碎片”应用可解排列建议。
界面、导入裁剪和回放由 `src/lit/song-puzzle.ts` 与 `song-puzzle-import.ts` 持有。

## 原作关卡

`native.ts` 复现原作客户端的确定性开局。关卡键为歌曲 ID 和棋盘尺寸，
与节奏谱面的 EASY／NORMAL／HARD／EXPERT 无关。

原生 ARM64 实现的调用链：

- `UISlidePuzzleBoardPresenter.<SetupViewAsync>d__18.MoveNext`，`0x5d4d2f0`：
  从歌曲对象取得 ID，作为 `SlidePuzzleBoard.Setup` 的 seed；已有进行中存档则恢复存档。
- `SlidePuzzleBoard.Setup`，`0x5fc6b90`：打乱次数为 `size × size × 11`。
- `SlidePuzzleBoard.BuildBoard`，`0x5fc6c0c`：完成图右下角为空格。
- `SlidePuzzleBoard.ShuffleBoard`，`0x5fc70ac`：`System.Random(seed)`，每次从全部合法相邻格随机选择，允许立即回退。
- `SlidePuzzleBoard.GetValidMoves`，`0x5fc7d90`：依次使用 Unity `Vector2Int.up`、`down`、`left`、`right`；棋盘 Y 向下增长。
- `System.Random` 有种子构造函数，`0xa75fb8c`：56 项减法状态、161803398 初值、四轮预热。

以上坐标来自本地归档的日服 1.1.0 ARM64 运行库与方法表；恢复后的运行库 SHA-256
为 `4d640bc3b6328cac63c70d4f57f22c56528f573990df291f69d7edb5f3fd876a`。
二进制及账号存档不进入源码。
向量字段顺序见 [Unity 原始定义](https://github.com/Unity-Technologies/UnityCsReference/blob/master/Runtime/Export/Math/Vector2Int.cs)。
不同客户端版本修改算法时，应重新核对这条调用链。

## 验证

使用仓库现有 `pnpm lint:frontend`、`pnpm typecheck` 和 `python scripts/verify/geb.py`。
真实页面检查桌面与手机、明暗主题，覆盖选曲／尺寸、原作开局、随机开局、
撤销／重开、编辑、截图导入与校正、提示、求解、回放和页面离开后的 Worker 清理。

## 求解与回放

3×3 使用数值状态键的双向广度搜索。4×4 先提供完整可行解，再使用 IDA*、
增量曼哈顿／线性冲突、Walking Distance 和按需生成的 5-5-5 加性模式库证明最短解。
模式库把零成本空格移动压缩为连通分量；只对本组方块移动收费，三组下界可相加。

5–8 阶短搜后比较八种旋转／镜像下的分层路径，删除状态环，并用 3×3／4×4
最短子路径及反向路径缩短移动序列。速度优先保留首个完整解，步数优先继续改进。
进度回调的可选 `path` 是同一起点到目标的完整可行路径；`bound` 是已证明的下界。
只有解长等于下界或精确搜索完成才返回 `optimal`，其余完整解返回 `found`。

求解 Worker 完成后保留模式缓存；取消在途求解、断开页面时终止 Worker。
回放／定位先停止搜索并保留当前解，玩家棋盘与步数只在游玩或“在此继续”时改变。
本地续局按服务器、歌曲、尺寸、来源和目标空格分槽，最多 24 个局面，保存各方向
最近 32 条历史；设置与进度留在当前浏览器。

算法依据：

- [Felner、Korf、Hanan：Additive Pattern Database Heuristics](https://arxiv.org/abs/1107.0050)
- [Kociemba：15-Puzzle Optimal Solver](https://kociemba.org/themen/fifteen/fifteensolver.html)，Walking Distance 与模式库组合的实现说明。
- [Parberry：A Real-Time Algorithm for the (n²−1)-Puzzle](https://ianparberry.com/pubs/saml.pdf)，分层归位方法。
