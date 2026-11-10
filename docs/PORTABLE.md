# 便携运行时：下载插件即用

目标：**不让人（和决策模型）为了「跑不起来」花时间 debug**。
做法是把该由环境承担的东西收进插件目录，把太大的东西改成「只记路径」。

## 目录约定

```
<插件>/runtime/            # 全部 gitignore，随插件走，卸载即清
  llama/                   # llama-server.exe + 依赖 DLL（约 77MB，MIT）
  py/                      # ComfyUI 用的 Python venv（可选，约 2.5GB）
  comfy.json               # 指向本机 ComfyUI 目录的指针（不复制 200MB 源码）
  env.json                 # 上次 doctor 快照（排查用）
```

模型**永远不进来**，只登记路径：

- `paths.modelsRoot`：GGUF 根目录（llama.cpp 资产用相对路径或绝对路径）；
- ComfyUI 的权重在 ComfyUI 自己的 `models/` 下，由工作流里的文件名引用。

## 三种东西，三种处理

| 东西 | 体积 | 处理 | 原因 |
|---|---|---|---|
| llama.cpp 运行库 | 77MB（53MB 是 `ggml-cuda.dll`） | **复制**进 `runtime/llama` | MIT，体积可控，复制后不再依赖 PATH / 系统安装 |
| ComfyUI 源码 | ~200MB | **指针** `runtime/comfy.json` | 更新频繁，复制容易过期 |
| ComfyUI 依赖（torch 等） | ~2.5GB | **不打包**，按需装 | 换机器/换 CUDA 版本要重装，打包没意义 |
| 模型文件 | GB 级 | **只登记路径** | 用户自己的资产，插件不该搬 |

## 一条命令体检

```
local_env {}                       # doctor：逐项 ok / ! / x + 一条 fix
local_env {"action":"plan"}        # 还差什么、大概多大
local_env {"action":"vendor-llama"}   # 把已有 llama.cpp 复制进插件
local_env {"action":"link-comfy","dir":"D:\\models\\ComfyUI"}
local_env {"action":"set-model-root","dir":"D:\\models\\models"}
```

doctor 输出长这样（每行都自带下一步，模型不需要读日志）：

```
运行时目录：D:\dsh-plugin\runtime
[ok] llama.cpp：D:\dsh-plugin\runtime\llama\llama-server.exe（插件内便携副本，77MB）
[x]  ComfyUI Python：没有可用的 Python 解释器
      → 装 ComfyUI 依赖：见 local_env {"action":"plan"}
[ok] 模型目录：D:\models\models
```

## 解析优先级

- **llama-server**：`runtime/llama/llama-server.exe`（`paths.bundleLlama` 默认 true）> `paths.llamaServer` > `asset.launch.exe`
- **ComfyUI 目录**：`runtime/comfy.json` 指针 > `paths.comfyDir`（启动时指针会覆盖配置，不写回 config.json）
- **ComfyUI Python**：`runtime/py` 里的 venv > `paths.comfyPython`

这样既能「下载即用」，也能「用我自己编译的 llama.cpp」——把 `paths.bundleLlama` 设 false 即可。

## 为什么 ComfyUI 依赖不打包

- torch + CUDA 轮子 2.5GB，且 **CUDA 版本必须和显卡驱动匹配**，打包等于赌用户的驱动；
- 用户大概率已经有一份 ComfyUI（本项目实测就是复用的）；
- 插件只负责「记住路径 + 检查 main.py 在不在 + 检查解释器能不能起来」，装依赖留给用户（或 ComfyUI 自带的 update 脚本）。

如果以后要做「一键装 ComfyUI」，正确形态是 `local_env {"action":"install-comfy","torch":"cu121"}`：下载 ComfyUI 源码 → 建 venv → 装对应 CUDA 轮子。这条已经写进 `local_env plan`，但默认不自动执行（GB 级下载必须由人决定）。

## 对「减少 debug token」的作用

- 失败信息统一成 `[x] 项 + fix`，模型照着做即可，不用来回试；
- `vendor-llama` 之后，llama.cpp 相关失败基本只剩下「模型文件路径不对」，而那是 `local_assets` 里一眼可见的（带 ⚠ 缺失清单）；
- ComfyUI 侧失败仍然会发生（节点缺失、模型名不对），但 `local_generate` 会把「工作流里哪个文件找不到」直接写进结果，不需要翻日志。
