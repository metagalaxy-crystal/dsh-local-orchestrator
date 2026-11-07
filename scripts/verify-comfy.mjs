import path from "node:path"
import { resolveConfigSync } from "../lib/config.js"
import { Orchestrator } from "../lib/manager.js"
const dataDir = path.resolve(".preview-comfy")
const { config } = resolveConfigSync({ dataDir })
config.scheduler.loadTimeoutMs = 600000
config.scheduler.autoTune = false
config.prompt.enabled = false
const o = new Orchestrator({ config })
await o.start()
console.log("assets", o.catalog.list().length)
const t0 = Date.now()
try {
  const inst = await o.ensure("comfyui", { reason: "verify comfyui" })
  console.log("READY", inst.state, "port", inst.port, "pid", inst.pid, "sec", ((Date.now()-t0)/1000).toFixed(1))
} catch (e) {
  console.log("FAILED", e.message)
} finally {
  await o.stop("comfyui").catch(()=>{})
  o.dispose()
}
process.exit(0)

