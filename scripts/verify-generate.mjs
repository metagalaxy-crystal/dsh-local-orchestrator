import path from "node:path"
import { resolveConfigSync } from "../lib/config.js"
import { Orchestrator } from "../lib/manager.js"
const dataDir = path.resolve(".preview-flow")
const { config } = resolveConfigSync({ dataDir })
config.scheduler.loadTimeoutMs = 240000
config.scheduler.autoTune = false
config.scheduler.idleUnloadSec = 0
config.prompt.enabled = false
const o = new Orchestrator({ config })
await o.start()
const t0 = Date.now()
try {
  const out = await o.runComfy("zimage", { params: { prompt: "一只橘猫坐在窗台上，暖色午后光线，写实摄影" }, timeoutMs: 300000 })
  console.log("GENERATE", out.ok ? "OK" : "FAIL", ((Date.now()-t0)/1000).toFixed(1)+"s", out.error ?? "")
  for (const f of out.files ?? []) console.log("FILE", f.url)
} catch (e) {
  console.log("THROW", e.message)
} finally {
  await o.stopAll().catch(()=>{})
  o.dispose()
}
process.exit(0)
