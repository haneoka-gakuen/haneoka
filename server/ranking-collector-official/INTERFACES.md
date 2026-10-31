# 接口、来源与网站新鲜度

## 当前实现

| 层 | 输入 / 输出 | 网络、身份与时间 |
| --- | --- | --- |
| 官方主数据发现 | 官方 Version／国际服 GetServerList → 版本及分区 CDN；CDN → Manifest 与三张表 | 匿名发现；日服动态 CDN 密码只驻留内存，客户端用户名与解码参数外置，不经过 Moenotes |
| 活动投影 | MasterEvent + MasterChallengeMusic + MasterParameter → 当前活动、挑战、开关和窗口 | 沿用 Master 管线 UTC+9；保留 region、apiOrigin、独立 masterVersion／resourceVersion、表摘要和 catalogObservedAtMs |
| 榜单采集 | GetChallengeMusicRanking(challenge_music_id)、GetChallengeMusicTotalRanking(event_id) | 游戏专用身份；单曲与总榜分别保存，最多100条 |
| 本地历史 | 不可变正文摘要 + 独立观测 + 失败周期 | observedAtMs是接收时间；sourceFetchedAtMs保持null |
| HTTP读取 | localhost v2 | 只读数据库，GET不请求游戏、不中途登录、不写历史 |

采集端使用 Python 的 TLS 与 HTTP/2 实现，在 Windows、Linux 和 macOS 复用同一协议与数据库；没有 PowerShell 子进程或凭据请求文件。CLI、离线安装与进程锁的使用方式见 [README.md](README.md)。

接口前缀 `/api/v2/game/records/{region}`，region 为运行目录固定的 `jp`、`tw`、`en` 或 `kr`。其他分区路径返回 404：

| GET 路径 | 返回 |
| --- | --- |
| `/status` | `haneoka:ranking-status/1`；region、serverTimeMs、collectorStatus、samplingIntervalSeconds、lastSuccessfulObservationAtMs、ageMs、stale、pollAfterSeconds、catalogProvider；云端另含 collectionEnabled、readEnabled、lastFailure |
| `/events/current` | 官方主数据投影；没有当前活动时event=null |
| `/events/{eventId}/challenges/{challengeId}/latest` | 指定单曲最后成功观测 |
| `/events/{eventId}/total/latest` | 四曲总榜最后成功观测 |
| `/events/{eventId}/latest` | 活动积分榜最后成功观测；活动 `_isRankingDisabled` 为 false 时才采集，请求前 100 名 |
| 上述latest改为`history?after={cursor}` | observations与nextCursor，每页最多100条；失败也保留 |

榜单合同仍为 `haneoka:ranking-observation/2`，保留snapshotId、cursor、payloadHash、eventId、challengeId、players、provenance、stale。新增官方主数据来源不应冒充Moenotes采集时间。榜单原始玩家字段不是完整图片资源；名片图片下载未接入。

运行数据库以 `collector_identity` 持久绑定一个分区，观测和目录写入在同一事务内校验分区。读取旧日服库不添加元数据，写入时才采用其已存在的日服身份；混服数据及与配置或状态不符的区域拒绝读取。运行配置 `haneoka:official-ranking-collector/2` 要求显式 `region`，旧 `haneoka:official-jp-collector/1` 缺省仍为 `jp` 且只允许日服。

当前状态stale阈值为10分钟；状态接口的最后成功时间是全局最新值，**不能代替某一榜单自己的observedAtMs/stale**。本地 collectorStatus 是最后持久状态；云端先反映当前开关及配置的 disabled、not_configured、invalid_config，其余沿用持久状态。状态查询不启动采集或清除认证暂停；停止更新时仍须按age判断。全部接口Cache-Control:no-store；Host只接受当前端口的127.0.0.1或localhost，存在Origin时也只接受本机HTTP来源，其余返回403。404表示尚无该成功观测，400表示查询参数错误，存储损坏或读取失败返回500。数据损坏不能将空榜视为成功。

## 云端任务与网站接入

云端模式在独立 Cloudflare Container 中运行 `cloud.py`，入口为带服务令牌的 `POST /collect`。共享任务合同见 `src/lib/official-ranking.ts`：`haneoka:official-ranking-job/1` 提供固定区服、runId、凭据代际、客户端版本、私有配置、截止时间与单次回调令牌。每轮最长约120秒，`GET /health` 仅供就绪检查。

Job 的可选 `capabilities` 协商 `arena-ranking-v1`、`arena-population-v1`、
`arena-progress-v1`、`arena-demand-v1`。旧任务缺这些能力时，Python 不加载竞技场表，
也不发送新增竞技场回调。竞技场目录含 `seasonId/startAtMs/endAtMs/rankingEndAtMs/bandIds`
及 `thresholdsByBand`；活动为 null 仍独立采竞技场，当前无赛季为显式 `arena:null`。

`arenaWindows` 最多20项 `{seasonId,bandId,startRank,endRank}`，按100位置对齐。
`arena-observation` 含窗口、真实 `maxRank` 及原始 `players`；所有名单的默认 `point=0`
均显式补出。排名显示字段不参与人数累计。

`arena-population` 含 `{snapshotId,region,seasonId,bandId,observedAtMs,maxRank,atLeast,provenance}`，
`atLeast=[{threshold,count}]` 阈值递增、人数非增且不超过 maxRank；阈值0人数等于 maxRank。
只在全部边界经本轮实际响应复验后发送，时间为本轮最早探测接收时间。

`arena-progress` 使用独立 `checkpointId`，重试保持同一 ID，内容为
`{seasonId,bandId,thresholds,maxRank,counts,cursor,pending?}`。`counts` 未知项为 null；
`cursor` 是下一个待求／验证阈值索引，全部完成时为数组长度。
`pending={index,low,high}` 的边界为人数闭区间 `0<=low<=high<=maxRank`，不用显示名次或页号。
Worker 保存 `updatedAtMs`，在后续 Job 的 `arenaProgress` 数组回传；候选仅用于选点，
不能直接当作新人口。人口及进度属于已确认窗口的派生回调，不额外申请游戏请求 attempt。

云端不写本地 SQLite 历史。`haneoka:official-ranking-update/1` 回调依次提交 `catalog`、`attempt`、`observation`、`complete`；每个 `attempt` 在发送认证请求前等待持久确认，每个观测在继续下一请求前等待持久确认。回调失败中断任务，HTTP/gRPC 认证拒绝和限流立即停止后续请求。Worker 依据 snapshotId 幂等保存观测，以原 received_at 生成 observedAtMs，官方玩家结构保留 snake_case 及 int64 字符串，归一化由网站适配层负责。

`complete.failure` 与公开 `status.lastFailure` 使用 `{stage, code, httpStatus?, grpcStatus?}`；无失败时省略回调字段，公开字段为 null。阶段与错误类别采用固定白名单，HTTP/gRPC 仅保留数字状态，不保存异常原文、请求头、配置或玩家数据。容器启动或 HTTP 请求失败由 Worker 记录为 `container` 阶段。

区域 Durable Object 持久保存调度、当前凭据代际、在途检查点与暂停/冷却；D1 保存历史索引，私有 R2 保存不可变正文。容器临时目录及完成任务缓存只用于本轮执行，不是恢复或读接口的依据。Worker 重新读取同一观测不会修改时间或生成新游标。

区服 secret 向后兼容单账号结构，并接受 `haneoka:official-ranking-account-pool/1`：
`{contract,region,selectedAccountId?,accounts:[{id,label?,source?,enabled,state,pauseReason?,nextRequestAtMs?,clientVersion,credentials,masterConfig}]}`。
`credentials` 为原有同服、固定 origin 的凭据文档；池内 ID 和别名不参与真实身份或认证代摘要。
同一真实身份不能重复登记。仅 ready 且启用的 entry 可调度；池的暂停状态不因重新部署、
更换池内 ID 或切换单号／池格式清除。403/7 权限暂停和429/8冷却覆盖全区，401/16及明确
authentication_failed暂停该认证代；整轮持有选中身份租约，失败请求不跨账号重放。

公开 `status.pool` 为 `{accounts,enabled,ready,paused,coolingDown,leased}` 六个数量；
不包含账号 ID、别名、真实玩家身份、认证摘要或凭据。任务／回调仍沿用 job/1 和 update/1，
容器只接收本轮已选择的单个账号配置。

云端沿用上表 v2 路径，公开格式使用网站 DTO：`events/current` 返回 `EventTrackerDto`，榜单 `latest` 返回 `EventRankingDto`，包含 `provider=official`、`snapshotId`、`observedAtMs`、`serverTimeMs` 和归一化 `rows`；`history?after=` 返回独立数字游标、成功观测的 `ranking` 或失败元数据。原始 `players` 和协议扩展字段只保存在私有 R2，不直接公开。localhost API 继续返回原始 `haneoka:ranking-observation/2`，两者不共享正文合同。云端 `status` 附逐榜最后尝试、最后成功、连续失败和开放缺口，不能用全局成功代替逐榜健康。

云端缺少目录或成功观测时保留 HTTP 503 pending。采集未启用、未配置或配置无效时，错误附 collectorStatus，retryAfter 为 null；状态查询的 nextAttemptAtMs 为 null、pollAfterSeconds 为300。采集可用时保留原轮询提示，提示间隔不代表已经排队或必定产生新数据。

网站 v1 根据区服来源开关适配，单曲保持 `/events/{id}/challenges/{challenge}/ranking`，官方总榜使用 `/events/{id}/total/latest`。旧 `/events/{id}/latest` 始终表示 PT，旧 SHA 历史继续独立读取。

1. 用户打开页面或切换活动立即读取当前活动及所选榜单。官方来源在页面可见时每30秒轮询，原来源每60秒；隐藏时暂停，重新可见/网络恢复时立即刷新。请求串行；切换活动取消旧请求并核对eventId/challengeId，旧响应不得覆盖新页面。
2. 用snapshotId判断是否有新观测，用observedAtMs显示数据时间，用serverTimeMs计算年龄而不是相信用户设备时钟。HTTP成功但snapshotId未变时，不能刷新“数据更新时间”。接口失败保留最后成功数据及其原时间，显示过期状态。
3. 当前多榜分别采集，并非同一时刻快照；页面不得把五榜拼接成“官方同时刻”。总榜必须读取官方total结果，不能自行相加四曲Top100。
4. 单次成功提交对读取可见后，30秒轮询会在下一次轮询拿到；300秒采样下的正常数据滞后约为300秒+本轮请求耗时+30秒。失败保留原数据及其过期状态，采样频率需遵守上游限流，访客不直连游戏。
5. localhost接口只供本机验证。云端通过同域 Worker 提供已采集数据，游戏凭据与CDN配置只留在受控采集服务，不进入浏览器。采集和网站读取开关分别按区服设置，配置方式见README的云端模式。
6. v1与v2保持各自合同及历史游标：网站适配器按区服切换，旧Moenotes历史保留来源，不改标为官方自采；官方四曲总榜使用独立total路径。Taki旧入口独立维护。切回原来源不删除已采集的官方历史。

## 竞技场联赛榜单（待接入）

网站侧合同已就绪，采集端尚未请求竞技场榜单。接入时：

| 项 | 合同 |
| --- | --- |
| 目录 | `haneoka:official-ranking-update/1` 的 `catalog.arena`：`seasonId`、`startAtMs`、`endAtMs`、`rankingEndAtMs`、`bandIds`（十进制字符串）；无竞技场时为 null 或省略 |
| 尝试 | 沿用 `attempt`；仅有竞技场赛季、没有活动时也允许 |
| 观测 | `{ type: "arena-observation", observation }`；`observation` 含 `snapshotId`、`region`、`seasonId`、`bandId`、`startRank`、`endRank`（一次最多 100 名）、`maxRank`、`observedAtMs`，成功时 `players` 保留游戏 snake_case 字段（`rank`、`point`、`profile`／`player_data`、`deck`），失败时 `error`／`httpStatus`／`grpcStatus` |
| 保存与读取 | Worker 写入私有 R2 与 `official_arena_ranking_observations`；`/api/v1/game/records/{region}/arena/seasons/{season}/leagues/{band}/ranking?start=` 在官方读取开启时优先返回覆盖该名次的最新官方窗口，否则读取 Moenotes |

建议每轮至少采集各乐队前 100 名；段位人数接口按段位门槛查找名次，可由更大的窗口覆盖减少外部读取。

## 验收界限

独立目录转换/自动换期可用固定Master表及模拟时间验证；不能替代新活动真实发布、紧急关闭或当前客户端边界语义验证。当前官方获取已通过独立 catalog 入口实服验证；动态密码变化与换期使用隔离模拟验证。真实实服换期、新版连续榜单采样和公网网页及时刷新未验收。既有采集器实验与本版本证据分别记录，不将旧结果计入本版本。

目录包含 highestEventId 高水位（尚未接收活动时为0），活动空档仍保留；此字段用于重启后拒绝回退，不是当前活动ID。

挑战条目的status按自身窗口返回upcoming、nowOn、aggregation或finished；目录保留当前活动的全部挑战身份，实际采样再按窗口与开关选择目标。

`events/current` 的 `stale` / `ageMs` / `serverTimeMs` 在GET时计算；目录超过600秒、时间在未来或越过存储的活动阶段时为陈旧，`catalogObservedAtMs`保持原值。该读取不刷新目录、不改写SQLite。目录限流以`catalog_rate_limited`与持久`retryAfter`记录，其他HTTP错误以`catalog_failed`附安全阶段/HTTP/gRPC状态记录。
