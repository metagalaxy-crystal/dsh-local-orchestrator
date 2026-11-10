# 低显存机器上的 agent 资源调度运行时

> 一句话：**把「本地模型 / 生成式工作流 / 一次性脚本」统一进一张预算表，用「单步工具 + 任务状态机」把决策权和执行权分开**，让 agent 在 8GB 显存的消费级机器上也能稳定地反复加载、切换、排队、恢复任务。

这不是一个新的 agent 框架。它不实现 LLM 循环、不做工具调用协议、不管会话与记忆。
它只回答四个问题：

1. 现在卡上还剩多少显存？
2. 这一步该让谁先跑？
3. 跑完怎么记账？
4. 卡住了谁负责收尾、下次还能不能接着跑？

---

## 为什么需要它

在一台 **RTX 5060 Laptop 8GB / 32GB RAM** 的机器上跑 agent，痛点是具体而琐碎的：

| 痛点 | 没有调度层时 | 这个插件的做法 |
|---|---|---|
| 换模型就 OOM | 手动杀进程、等驱动回收、再起下一个 | GPU 槽互斥 + 预算表：先淘汰、等显存回落、再加载 |
| 显存算不准 | 拿参数量拍脑袋 | `min(空闲, 总量×(1-预留比例)) - 固定预留`，再用真实加载前后差值回填 |
| 长任务怕断 | 会话一停，跑到一半的任务就废了 | 任务状态机落盘：重启后 `running → paused`，可 `resume` 继续 |
| 一个会话霸占卡 | 别的会话干等 | 租约表按会话轮转，跨会话最大连续独占 1 步 |
| 不知道钱花在哪 | 只有"慢"的体感 | token 账本：谁、多少 token、多少 tok/s、上下文占用多少 |
| 模型文件被删了还在调用 | 跑到一半报错 | 连通性检查：缺文件的资产标红、不进调度 |

---

## 它不是什么

- **不是推理引擎**：底层还是 llama.cpp / ComfyUI / 你自己的 Python 脚本。
- **不是新调度算法**：GPU 互斥、LRU 淘汰、按会话轮转都是常见做法，价值在**组合**和**约束下的设计知识**。
- **不重复 DSH 已有的能力**：记忆、会话、UI、RAG、浏览器交给 DSH 的其它插件；它只管「本地资源怎么被用起来」。

---

## 三个核心物件

| 物件 | 解决什么 | 代码 |
|---|---|---|
| **预算表** | LLM / 工作流 / 脚本 / MCP 共用一本账：谁占了多少显存、按科目合计多少、新东西放不放得下 | [`lib/budget.js`](../lib/budget.js) |
| **单步工具** | 一次工具调用只推进一步；`local_step` 与后台 worker 共用同一个 `StepRunner`，规则只有一份 | [`lib/steps.js`](../lib/steps.js)、[`lib/tools.js`](../lib/tools.js) |
| **任务状态机** | `queued → running → waiting_decision → done`；跨会话、落盘、可恢复、暂停即真正打断 | [`lib/tasks.js`](../lib/tasks.js) |

一句话：**决策权在宿主，执行权在插件，状态是两者唯一的契约。**

---

## 十个工具（给会话模型用）

| 工具 | 能力 |
|---|---|
| `local_resources` | 算力 / 显存 / 已加载服务总览；`verbose` 附资产清单、24h 用量与最近事件 |
| `local_assets` | 资产列表；`action=add/update/remove` 手动或对话登记资产 |
| `local_chat` | 在本机模型上跑一次推理（自动加载；支持图片走多模态） |
| `local_service` | `load / stop / restart / stop_all / reap / release / discover / import / sync / set / inspect` |
| `local_delegate` | 一整件任务交给本地：`direct` 单模型 / `plan` 先规划再逐步执行 |
| `local_generate` | ComfyUI 出图 / 视频 / 音乐；按 prompt 自动选工作流，也可指定资产 |
| `local_audio` | 一次性音频脚本：`tts` 语音合成 / `asr` 转写+分离+SRT / `music-qc` 质检 |
| `local_task` | 任务池：`create / list / get / pause / resume / cancel / rollback / replan` |
| `local_step` | 推进任务一步：`run / retry / skip / inspect`；**一次调用只做一步**，失败自动重试一次 |
| `local_env` | 便携运行时：`doctor` 体检（每项带 fix）/ `plan` / `vendor-llama` 复制 llama.cpp / `link-comfy` 登记 ComfyUI / `set-model-root` |

工具是**能力原语**，模型是**资源**（用 `asset` 参数寻址，由调度器按显存/擅长/已加载挑选）。
不采用「一模型一 tool」：工具 schema 每轮进上下文，几十个资产会把工具列表撑爆，而且模型算不了显存预算。

---

## 关键机制

### 显存预算

```
可调度 = min(当前空闲, 总量 × (1 - 预留比例)) - 固定预留
```

- 预留比例默认 8%，固定预留默认 768MB（桌面合成 / 浏览器 / 驱动还要吃饭）；
- 加载前后用 nvidia-smi 总占用差值**实测**并在后续调用中回填，估算器按实测标定；
- 8GB 卡上 ctx / KV 量化 / 并行槽都影响很大（实测：3B 模型 ctx32k + f16 + 4 槽 = 7.7GB，q8_0 + 单槽 = 5.5GB）。

### GPU 槽互斥 + 租约

同一个吃显存的资产同一时刻只允许一个；租约按会话轮转，谁也不能无限连着占。
后台执行环每 2 秒推进一步，到达 `require`（需要人/会话判断）或失败时，把任务置为 `waiting_decision` 并**只唤醒所属会话**。

### 一次调用一步

`local_step` 把「执行」变成幂等的小步：claim 步骤 → 拿租约 → 执行 → 判定 → 写回状态。
好处：工具调用超时/断线不会留下跑到一半的野进程，后台和前台用同一套规则。

### 连通性检查

每个资产在 `/state` 里带 `healthy` 与 `missing[]`：模型文件、mmproj、工作流、脚本、MCP 可执行文件、以及工作流里引用的编码器/VAE 是否真的在磁盘上。
缺文件的资产不进 `pick()`、不进自动路由、按钮变「不可调用」——避免"看起来有、一跑就崩"。

### 资产是可以教的

资产目录 `catalog.json` 里一条资产 = 一个可加载的本地服务；`components` 描述它的配套零件（编码器 / VAE / 声码器 / mmproj），默认隐藏、不单独调度。
换机器模型散落各处？`local_assets {"action":"add"}` 或 UI「＋ 添加资产」逐个登记，保存后立刻校验。

---

## 实测数字（同一台机器：RTX 5060 Laptop 8GB / 32GB RAM）

| 项目 | 数值 | 说明 |
|---|---|---|
| 冷启动 3B 模型 | **39.8–45.4s** | 含进程拉起 + 权重加载 |
| 出图（8 步 Turbo，512×512） | **44.8s** | 首次含 ComfyUI 启动 |
| TTS（VoxCPM2，4.8s 音频） | **19.9s**（RTF 4.15） | 一次性脚本，先释放 GPU 槽 |
| 单步开销 | **2.5–2.6ms** | 含任务落盘，相对冷启动可忽略 |
| 任务恢复率 | **100%（20/20）** | 崩溃/重启后能接着跑 |
| 跨会话连续独占 | **最大 1 步** | 两会话交替推进，谁也不会饿死 |
| 资产规模 | 35 主模型 + 5 组件 + 15 MCP | 本机实际目录 |

后三个指标不依赖硬件，`node scripts/bench.mjs` 可直接复现。

---

## 适用 / 不适用

**适用**

- 一台带 NVIDIA 显卡的机器（Windows / Linux），8–16GB 显存；
- 已经用 llama.cpp 跑 GGUF、用 ComfyUI 出图/视频；
- 希望 agent 能按任务自动加载/卸载模型，长任务能跨会话继续；
- 场景是简单、批量、隐私、离线的活。

**不适用**

- 多卡 / 集群调度（这里假设单卡）；
- 高并发在线服务（这是"一台机器一个 agent"的运行时）；
- 完全不想装 DSH 的独立使用（它是 DSH 插件）。

---

## 局限与已知问题

- **Windows 显存归因**：WDDM 下 `nvidia-smi` 的每进程显存显示 `[N/A]`，性能计数器给的是"提交量"不是"驻留量"。所以只能看总量与差值，不能精确拆到进程。
- **估算偏差**：模型显存受 ctx / KV 量化 / 后端影响，首次是估算（实测可回填）。
- **本地小模型做规划不稳**：3B 级模型很难稳定输出 JSON 计划。已加 JSON 约束 + 一次重试 + 退化单步，但仍建议用 DeepSeek 或 8B MoE 级本地模型做规划。
- **平台差异**：脚本/进程管理针对 Windows 写得最多（编码、路径、无控制台窗口），Linux 上可用但未逐一实测。
- **资产需要真文件**：缺文件的资产会被拦下，这既是保护也是约束。

---

## 快速开始

前置：一套可用的 DSH（DeepSeek Harness），本机装好 llama.cpp 与（可选）ComfyUI。

1. 把仓库放进 DSH 的插件目录，或用 `dsh plugin` 安装这条本地路径（以你的 DSH 版本为准）：

```bash
git clone <this-repo> dsh-local-orchestrator
dsh plugin add ./dsh-local-orchestrator
```

2. 重启 DSH。打开会话里的「本地调度」页签，先看「总览」有没有读到显卡与显存。
3. 登记资产：本机模型都在同一个根目录时点「从目录导入」；否则「＋ 添加资产」，或直接对 agent 说「把 `D:\models\xxx.gguf` 加成 llm 资产」。
4. 验证一次：让 agent 调 `local_chat {"prompt":"你好"}`；能加载并回复就通了。
5. 想试任务池：

```jsonc
// 1) 建任务
{"action":"create","goal":"写一句宣传语","steps":[{"goal":"写一句宣传语","kind":"llm"}]}
// 2) 一次推进一步
{"action":"run","taskId":"task-xxxx"}
```

配置在 `<数据目录>/config.json`（默认 `~/.dsh/local-orchestrator/`），UI 的「设置」页可以改大部分项。

---

## 目录结构

```
lib/
  index.js      插件装配：工具注册、系统提示注入、后台执行环、唤醒
  tools.js      9 个工具
  manager.js    编排：GPU 互斥、显存预算、LRU 淘汰、空闲回收
  catalog.js    资产目录（模型/服务/成本画像/组件）
  budget.js     预算表
  leases.js     租约表
  tasks.js      任务/步骤状态机 + 落盘
  steps.js      单步执行器（前后台共用）
  worker.js     后台执行环
  decision.js   决策模型（会话 / 本地 / DeepSeek）
  stats.js      token 用量账本
  tracker.js    任务框图 / 节点进度 / IO 轨迹
  hardware.js   CPU / 内存 / 显存探测
  runtimes/     llama.cpp · ComfyUI · 通用进程
  api.js        本地 HTTP 接口
  client.js     「本地调度」页签（React，无需构建）
test/           111 个用例
```

---

## 开发

```bash
node test/stats.test.js          # 单个文件跑（沙箱里 node --test 可能被拦）
node scripts/bench.mjs           # 三个指标
npm run verify                   # 工具真实调用台账（见下）
```

**工具验证台账**：单元测试证明不了「真实环境能用」。`docs/tool-verification.json` 记录每个工具的上次真实调用证据与指纹；改了工具后 `npm run verify` 只会把**改动过的**标成待验证，重跑即可。

---

## 发布清单（GitHub）

已经准备好：`LICENSE`（MIT）、`.gitignore`（运行期产物 / 打包中间物 / 截图）、`package.json` 的 `private: false` 与 `files` 白名单。

发布前建议再补：

- [ ] 仓库名：`dsh-local-orchestrator`（与包名一致，便于 `dsh plugin add` 识别）
- [ ] 简介（About）：`给 DSH agent 用的本地资源调度运行时：8GB 显存下统一排队 LLM / ComfyUI / 脚本，任务可跨会话恢复`
- [ ] Topics：`dsh-plugin` `deepseek-harness` `llama-cpp` `comfyui` `gpu-scheduler` `local-llm` `low-vram`
- [ ] `package.json` 补 `repository` / `homepage`（创建仓库后填）
- [ ] 截图：总览页（显存三段条）、资产页（框架条 + 组件）、任务池（步骤树）、用量页
- [ ] 首图：`docs/flow-v2.png`（双环调度总览），正文再放 `architecture-v2.png`
- [ ] Release：`v0.13.1`，说明写「首版：预算表 + 单步工具 + 任务状态机」

## License

MIT
