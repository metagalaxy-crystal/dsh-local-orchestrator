/**
 * 硬件探测：CPU / 内存 / 显存。
 *
 * 设计取舍：
 * - CPU/内存用 Node 内置 os，跨平台且零依赖；
 * - 显存只有 NVIDIA 有稳定 CLI（nvidia-smi），其它卡返回 null 并降级为
 *   「按资产估算 + GPU 互斥」策略，不伪造数据；
 * - 采样带 TTL 缓存，避免工具调用风暴把 nvidia-smi 打爆。
 */
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { nowIso } from './util.js'

/**
 * 跑一条外部命令并拿到 stdout。
 * 刻意不用 execFile 的管道：某些受限环境（沙箱、无命名管道）会直接 EPERM，
 * 这里改成「stdout 重定向到临时文件再读」，既不依赖管道也不丢输出。
 */
async function run(cmd, args, timeout = 5000) {
  const file = path.join(os.tmpdir(), `dsh-lo-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
  let handle = null
  try {
    handle = await fsp.open(file, 'w')
    const child = spawn(cmd, args, { stdio: ['ignore', handle.fd, 'ignore'], windowsHide: true })
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        resolve(-1)
      }, timeout)
      child.on('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode ?? 0)
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve(-1)
      })
    })
    await handle.close()
    handle = null
    if (code === -1) return null
    // reg.exe 在部分 Windows 上会输出 UTF-16LE，按 BOM 判断，避免中文/路径变乱码
    const buf = await fsp.readFile(file)
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').trim()
    return buf.toString('utf8').trim()
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
    await fsp.unlink(file).catch(() => {})
  }
}

/** 解析 "a, b" 形式的 CSV 行。 */
function csv(line) {
  return line.split(',').map((item) => item.trim())
}

/** 从名称 / 厂商字段推断 GPU 厂商。 */
function vendorOf(name, compatibility = '') {
  const text = `${name ?? ''} ${compatibility ?? ''}`.toLowerCase()
  if (/nvidia|geforce|quadro|rtx|gtx/.test(text)) return 'nvidia'
  if (/intel/.test(text)) return 'intel'
  if (/amd|radeon|advanced micro/.test(text)) return 'amd'
  return 'other'
}

/** 从名称推断核显（共享内存）/ 独显（独占显存）/ 虚拟显示器。 */
function kindOf(name) {
  const text = String(name ?? '').toLowerCase()
  if (/virtual|parsec|todesk|gameviewer|sunshine|spacedesk|iddc|microsoft basic/.test(text)) return 'virtual'
  if (/nvidia|geforce|quadro|rtx|gtx/.test(text)) return 'discrete'
  if (/intel/.test(text)) return /arc\s*\(?tm\)?\s*a\d|arc a\d|arc pro/.test(text) ? 'discrete' : 'integrated'
  if (/amd|radeon/.test(text)) return /rx\s*\d|pro w\d|firepro/.test(text) ? 'discrete' : 'integrated'
  return 'unknown'
}

/** 供测试与 UI 复用：给一个适配器名字，返回厂商与类型。 */
export function classifyGpu(name) {
  return { vendor: vendorOf(name), kind: kindOf(name) }
}

export class Hardware {
  /** @param {object} config 插件配置 */
  constructor(config) {
    this.config = config
    this.backend = null // 'nvidia-smi' | 'none'
    this.lastSample = null
    this.lastAt = 0
    this.lastCpu = null
    this.probing = null
    /** 显卡适配器清单（含核显）：换机器才变，进程内缓存一次。 */
    this.adapters = null
  }

  get ttlMs() {
    const configured = Number(this.config?.hardware?.probeIntervalMs)
    return Number.isFinite(configured) && configured >= 0 ? configured : 3000
  }

  /** 探测 GPU 后端（只探一次）。 */
  async detectBackend() {
    if (this.backend) return this.backend
    const mode = this.config?.hardware?.gpuBackend ?? 'auto'
    if (mode === 'none') {
      this.backend = 'none'
      return this.backend
    }
    const text = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
    this.backend = text && text.trim() !== '' ? 'nvidia-smi' : 'none'
    return this.backend
  }

  /** 采样一次（带 TTL 缓存）。 */
  async sample({ force = false } = {}) {
    const now = Date.now()
    if (!force && this.lastSample && now - this.lastAt < this.ttlMs) return this.lastSample
    if (this.probing) return this.probing
    this.probing = this.#sampleOnce()
      .then((value) => {
        this.lastSample = value
        this.lastAt = Date.now()
        return value
      })
      .finally(() => {
        this.probing = null
      })
    return this.probing
  }

  async #sampleOnce() {
    const backend = await this.detectBackend()
    const [gpus, gpuApps, adapters] = await Promise.all([
      backend === 'nvidia-smi' ? this.#nvidiaGpus() : Promise.resolve([]),
      backend === 'nvidia-smi' ? this.#nvidiaApps() : Promise.resolve([]),
      this.#adapters(),
    ])

    const cpus = os.cpus()
    const cpuUsed = this.#cpuUsage(cpus)
    const memTotalMb = Math.round(os.totalmem() / 1024 / 1024)
    const memFreeMb = Math.round(os.freemem() / 1024 / 1024)

    const totalVramMb = gpus.reduce((sum, gpu) => sum + (gpu.totalMb || 0), 0)
    const usedVramMb = gpus.reduce((sum, gpu) => sum + (gpu.usedMb || 0), 0)

    return {
      ts: nowIso(),
      backend,
      cpu: {
        model: cpus[0]?.model?.trim() || 'unknown',
        cores: cpus.length,
        loadPct: cpuUsed,
      },
      memory: {
        totalMb: memTotalMb,
        freeMb: memFreeMb,
        usedMb: memTotalMb - memFreeMb,
        usedPct: memTotalMb > 0 ? Math.round(((memTotalMb - memFreeMb) / memTotalMb) * 1000) / 10 : null,
      },
      gpus,
      adapters,
      vram: {
        totalMb: totalVramMb || null,
        usedMb: totalVramMb ? usedVramMb : null,
        freeMb: totalVramMb ? Math.max(0, totalVramMb - usedVramMb) : null,
      },
      gpuApps,
    }
  }

  /**
   * 枚举显卡适配器（含核显）。核显和独显共享/独占内存的方式不同：
   * - 核显用系统内存（DVMT/共享内存），nvidia-smi 看不到，也不该计入调度预算；
   * - 独显才是 llama.cpp / ComfyUI 真正吃的那块；
   * - 虚拟显示器（ToDesk / GameViewer / 串流）只标注，不算显卡。
   * 只做识别与标注，不改变预算口径。
   */
  async #adapters() {
    if (this.adapters) return this.adapters
    this.adapters = []
    if (process.platform === 'win32') {
      // WMI 在受限环境会「拒绝访问」，注册表这种方式不需要额外权限：
      // 显示适配器类 GUID 下的每个子键都有一个 DriverDesc。
      const text = await run('reg', [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}',
        '/s',
        '/v',
        'DriverDesc',
      ], 8000)
      if (text) {
        for (const line of text.split(/\r?\n/)) {
          const match = line.match(/DriverDesc\s+REG_SZ\s+(.+)$/)
          if (!match) continue
          const name = match[1].trim()
          if (!name) continue
          const vendor = vendorOf(name)
          const kind = kindOf(name)
          this.adapters.push({
            name,
            vendor,
            kind,
            /** 只有 NVIDIA 独显能进本插件的 CUDA 调度；核显 / 虚拟显示器永远不参与。 */
            schedulable: vendor === 'nvidia' && kind === 'discrete',
            vramMb: null,
            source: 'registry',
          })
        }
      }
    }
    // 用 nvidia-smi 的显存数据补全 NVIDIA 适配器（一次调用，避免逐卡 spawn）
    let nvidiaGpus = []
    if (this.adapters.some((adapter) => adapter.vendor === 'nvidia') || this.adapters.length === 0) {
      nvidiaGpus = await this.#nvidiaGpus()
    }
    for (const adapter of this.adapters) {
      if (adapter.vendor !== 'nvidia') continue
      const key = adapter.name.toLowerCase()
      const hit = nvidiaGpus.find((gpu) => {
        const name = String(gpu.name ?? '').toLowerCase()
        return name && (key.includes(name.slice(0, 8)) || name.includes(key.slice(0, 8)))
      })
      if (hit) {
        adapter.vramMb = hit.totalMb
        adapter.schedulable = true
      }
    }
    // wmi 没给东西时，至少把 nvidia-smi 看到的卡列出来
    if (this.adapters.length === 0) {
      for (const gpu of nvidiaGpus) {
        this.adapters.push({
          name: String(gpu.name ?? 'NVIDIA GPU'),
          vendor: 'nvidia',
          kind: 'discrete',
          schedulable: true,
          vramMb: gpu.totalMb,
          source: 'nvidia-smi',
        })
      }
    }
    return this.adapters
  }

  /** 两次采样之间的 CPU 使用率；首次返回 null。 */
  #cpuUsage(cpus) {
    const total = cpus.reduce(
      (acc, cpu) => {
        const times = cpu.times
        acc.idle += times.idle
        acc.total += times.user + times.nice + times.sys + times.idle + times.irq
        return acc
      },
      { idle: 0, total: 0 },
    )
    const prev = this.lastCpu
    this.lastCpu = total
    if (!prev) return null
    const idleDelta = total.idle - prev.idle
    const totalDelta = total.total - prev.total
    if (totalDelta <= 0) return null
    return Math.round((1 - idleDelta / totalDelta) * 1000) / 10
  }

  async #nvidiaGpus() {
    const text = await run('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu',
      '--format=csv,noheader,nounits',
    ])
    if (!text) return []
    const out = []
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      const [index, name, total, used, free, util] = csv(line)
      const n = (value) => {
        const num = Number(value)
        return Number.isFinite(num) ? num : null
      }
      out.push({
        index: Number(index),
        name,
        totalMb: n(total),
        usedMb: n(used),
        freeMb: n(free),
        utilPct: n(util),
      })
    }
    return out
  }

  /** 每个 GPU 进程的显存占用（用于把「我们启动的进程」折算成真实占用）。 */
  async #nvidiaApps() {
    const text = await run('nvidia-smi', [
      '--query-compute-apps=pid,process_name,used_gpu_memory',
      '--format=csv,noheader,nounits',
    ])
    if (!text) return []
    const out = []
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      const [pid, name, used] = csv(line)
      const usedMb = Number(used)
      out.push({
        pid: Number(pid),
        name: name || '',
        usedMb: Number.isFinite(usedMb) ? usedMb : null,
      })
    }
    return out
  }

  /** 计算可用预算（扣除预留）。 */
  budget(snapshot) {
    const hw = this.config?.hardware ?? {}
    const reserveVram = Number(hw.reserveVramMb ?? 768)
    const reserveRatio = Number(hw.reserveRatio ?? 0.08)
    const reserveRam = Number(hw.reserveRamMb ?? 2048)

    const totalVram = snapshot?.vram?.totalMb ?? null
    const freeVram = snapshot?.vram?.freeMb ?? null
    // 可用显存 = min(当前空闲, 总量扣除比例预留) - 固定预留。
    // 空闲值已经排除了我们自己已加载的进程，所以调度判断不需要再叠加占用。
    const ratioReserve = totalVram === null ? null : Math.floor(totalVram * reserveRatio)
    const usableVram = totalVram === null || freeVram === null
      ? null
      : Math.max(0, Math.floor(Math.min(freeVram, totalVram - ratioReserve) - reserveVram))

    const totalRam = snapshot?.memory?.totalMb ?? null
    const usableRam = totalRam === null ? null : Math.max(0, totalRam - reserveRam)

    return {
      vramTotalMb: totalVram,
      vramFreeMb: freeVram,
      /** 为桌面/驱动预留的显存总量（比例预留 + 固定预留）。 */
      vramReservedMb: totalVram === null ? null : ratioReserve + reserveVram,
      vramUsableMb: usableVram,
      ramTotalMb: totalRam,
      ramUsableMb: usableRam,
    }
  }

  /** 某 PID 的显存占用（查不到返回 null）。 */
  static appVram(snapshot, pid) {
    if (!pid) return null
    const hit = (snapshot?.gpuApps ?? []).find((app) => app.pid === pid)
    return hit?.usedMb ?? null
  }
}
