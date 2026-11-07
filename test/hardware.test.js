/**
 * 硬件探测：核显 / 独显 / 虚拟显示器的识别与显存预算口径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Hardware, classifyGpu } from '../lib/hardware.js'

test('hardware：适配器分类（核显 / 独显 / 虚拟显示器）', () => {
  assert.deepEqual(classifyGpu('Intel(R) UHD Graphics'), { vendor: 'intel', kind: 'integrated' })
  assert.deepEqual(classifyGpu('Intel(R) Iris(R) Xe Graphics'), { vendor: 'intel', kind: 'integrated' })
  assert.deepEqual(classifyGpu('NVIDIA GeForce RTX 5060 Laptop GPU'), { vendor: 'nvidia', kind: 'discrete' })
  assert.deepEqual(classifyGpu('AMD Radeon(TM) Graphics'), { vendor: 'amd', kind: 'integrated' })
  assert.deepEqual(classifyGpu('AMD Radeon RX 7800 XT'), { vendor: 'amd', kind: 'discrete' })
  assert.deepEqual(classifyGpu('Todesk Virtual Display Adapter'), { vendor: 'other', kind: 'virtual' })
  assert.deepEqual(classifyGpu('GameViewer Virtual Display Adapter'), { vendor: 'other', kind: 'virtual' })
  assert.deepEqual(classifyGpu('Microsoft Basic Display Adapter'), { vendor: 'other', kind: 'virtual' })
})

test('hardware：显存预算口径（核显不参与，独显可用量按 min(空闲, 总量-比例预留) - 固定预留）', () => {
  const config = {
    hardware: { reserveVramMb: 768, reserveRatio: 0.08, reserveRamMb: 2048 },
    scheduler: {},
  }
  const hw = new Hardware(config)
  const snapshot = {
    vram: { totalMb: 8151, usedMb: 1559, freeMb: 6592 },
    memory: { totalMb: 31720, usedMb: 12000 },
    adapters: [
      { name: 'Intel(R) UHD Graphics', kind: 'integrated', schedulable: false },
      { name: 'NVIDIA GeForce RTX 5060 Laptop GPU', kind: 'discrete', schedulable: true, vramMb: 8151 },
    ],
  }
  const budget = hw.budget(snapshot)
  // 比例预留 = floor(8151 * 0.08) = 652；min(6592, 8151-652)=6592；再减 768 = 5824
  assert.equal(budget.vramReservedMb, 652 + 768)
  assert.equal(budget.vramUsableMb, 5824)
  assert.equal(budget.vramTotalMb, 8151)
  assert.equal(budget.ramUsableMb, 31720 - 2048)
})

test('hardware：没有 NVIDIA 时显存为 null，不伪造数据', () => {
  const hw = new Hardware({ hardware: {}, scheduler: {} })
  const budget = hw.budget({ vram: { totalMb: null, usedMb: null, freeMb: null }, memory: { totalMb: 16000 } })
  assert.equal(budget.vramTotalMb, null)
  assert.equal(budget.vramUsableMb, null)
  assert.equal(budget.vramReservedMb, null)
})
