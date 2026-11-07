window.__ModuleLoader__.load({
	id: "dsh-local-orchestrator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback } = React;

		const BASE = "/api/local-orchestrator";
		const KIND_LABEL = {
			llm: "文本模型",
			vlm: "多模态",
			embed: "向量模型",
			rerank: "精排模型",
			image: "图像生成",
			video: "视频生成",
			music: "音乐生成",
			"audio-tts": "语音合成",
			"audio-asr": "语音识别",
			tool: "工具服务",
		};
		const RUN_KIND_LABEL = { chat: "本地对话", delegate: "任务委派", service: "服务操作" };
		const NODE_KIND_LABEL = {
			decision: "决策",
			"local-llm": "本地推理",
			load: "加载",
			comfy: "ComfyUI",
			mcp: "MCP",
			embed: "向量",
			rerank: "精排",
		};

		const CSS = `
.dlo-root{display:flex;flex-direction:column;gap:12px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary);container-type:inline-size}
.dlo-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.dlo-title{font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}
.dlo-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dlo-chips{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.dlo-chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 9px;color:var(--dsw-alias-label-secondary);font-size:11px;display:inline-flex;align-items:center;gap:5px;background:var(--dsw-alias-bg-layer-1)}
.dlo-chip-on{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l2))}
.dlo-chip-warn{color:var(--dsw-alias-state-warning-primary,#d97706);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 45%,var(--dsw-alias-border-l2))}
.dlo-chip-err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2))}
.dlo-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:none}
.dlo-dot-running{background:var(--dsw-alias-state-success-primary);animation:dlo-pulse 1.4s ease-in-out infinite}
.dlo-dot-ready{background:var(--dsw-alias-state-success-primary)}
.dlo-dot-error{background:var(--dsw-alias-state-error-primary)}
.dlo-dot-pending,.dlo-dot-skipped{background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
@keyframes dlo-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dlo-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:0}
.dlo-tab{font:inherit;color:var(--dsw-alias-label-secondary);background:none;border:0;border-bottom:2px solid transparent;padding:7px 12px;cursor:pointer;font-size:12.5px}
.dlo-tab:hover{color:var(--dsw-alias-label-primary)}
.dlo-tab-on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
.dlo-tab-n{font-variant-numeric:tabular-nums;opacity:.7;margin-left:4px;font-size:10.5px}
.dlo-grid{display:grid;gap:10px}
.dlo-grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.dlo-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.dlo-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
@container (width<=980px){.dlo-grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}.dlo-io{grid-template-columns:minmax(0,1fr)!important}}
@container (width<=620px){.dlo-grid-4,.dlo-grid-3,.dlo-grid-2{grid-template-columns:minmax(0,1fr)}}
.dlo-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;min-width:0}
.dlo-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dlo-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.dlo-card-title b{color:var(--dsw-alias-label-primary);font-size:13px}
.dlo-card-extra{margin-left:auto;display:flex;gap:6px;align-items:center}
.dlo-metric{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}
.dlo-metric small{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:4px}
.dlo-track{height:6px;border-radius:4px;background:rgba(128,128,128,.22);overflow:hidden;margin-top:7px}
.dlo-fill{display:block;height:100%;border-radius:4px;background:#4d6bfe;transition:width .4s ease}
.dlo-fill-warn{background:#d97706}
.dlo-fill-err{background:#ef4444}
.dlo-seg{display:flex;height:6px;border-radius:4px;background:rgba(128,128,128,.22);overflow:hidden;margin-top:7px;gap:1px}
.dlo-seg>i{display:block;height:100%}
.dlo-seg-used{background:#4d6bfe}
.dlo-seg-usable{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent)}
.dlo-seg-reserved{background:repeating-linear-gradient(45deg,rgba(217,119,6,.65) 0 3px,rgba(217,119,6,.18) 3px 6px)}
.dlo-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dlo-legend span{display:inline-flex;align-items:center;gap:4px}
.dlo-legend i{width:8px;height:8px;border-radius:2px;flex:none}
.dlo-kv{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:7px;font-variant-numeric:tabular-nums}
.dlo-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:8px}
.dlo-asset{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-2)}
.dlo-asset-top{display:flex;align-items:center;gap:7px;min-width:0}
.dlo-asset-id{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dlo-asset-meta{color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;flex-wrap:wrap;gap:4px 10px}
.dlo-asset-foot{display:flex;gap:6px;align-items:center;margin-top:auto;padding-top:4px}
.dlo-btn{font:inherit;font-size:11.5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 9px;cursor:pointer;line-height:1.5;white-space:nowrap}
.dlo-btn:hover{border-color:var(--dsw-alias-border-l4,var(--dsw-alias-label-secondary))}
.dlo-btn:disabled{opacity:.45;cursor:default}
.dlo-btn-on{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 50%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 8%,transparent)}
.dlo-btn-danger:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dlo-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.dlo-run{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:9px}
.dlo-run-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dlo-run-title{font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:56ch}
.dlo-run-meta{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.dlo-run-summary{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlo-comps{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.dlo-comp{font-size:10.5px;line-height:1.7;border:1px dashed var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dlo-comp-bad{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,var(--dsw-alias-border-l2))}
.dlo-comp-row{display:flex;gap:6px;align-items:center}
.dlo-inv{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-all}
.dlo-inv code{font:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 6px}
.dlo-edit-inline{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:8px;margin-top:4px;display:flex;flex-direction:column;gap:6px}
.dlo-frameworks{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:8px;margin-bottom:2px}
.dlo-fw{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:3px;min-width:0}
.dlo-fw-top{display:flex;align-items:center;gap:6px}
.dlo-fw-name{font-size:12px;font-weight:600}
.dlo-fw-path{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dlo-assets-grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(520px,100%),1fr))}
.dlo-asset-bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2))}
@container (width<=620px){.dlo-assets-grid{grid-template-columns:minmax(0,1fr)}}
.dlo-flow{display:flex;align-items:stretch;gap:0;overflow-x:auto;padding-bottom:2px}
.dlo-node{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:6px 9px;min-width:104px;max-width:190px;display:flex;flex-direction:column;gap:2px;flex:none}
.dlo-node-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-border-l2));box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent)}
.dlo-node-done{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,var(--dsw-alias-border-l2))}
.dlo-node-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l2))}
.dlo-node-label{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dlo-node-sub{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.dlo-arrow{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));flex:none;display:flex;align-items:center;padding:0 5px;font-size:12px}
.dlo-io{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}
.dlo-col{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0;display:flex;flex-direction:column;max-height:560px}
.dlo-col-head{display:flex;align-items:center;gap:7px;padding:9px 11px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:600}
.dlo-col-head .dlo-n{margin-left:auto;color:var(--dsw-alias-label-secondary);font-weight:400;font-size:11px;font-variant-numeric:tabular-nums}
.dlo-col-body{overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin}
.dlo-io-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:7px 9px}
.dlo-io-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dlo-io-title{color:var(--dsw-alias-label-primary);font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlo-io-time{margin-left:auto;font-variant-numeric:tabular-nums;flex:none}
.dlo-pre{margin:6px 0 0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:190px;overflow:auto;color:var(--dsw-alias-label-primary);scrollbar-width:thin}
.dlo-pre-open{max-height:none}
.dlo-more{font:inherit;font-size:10.5px;color:var(--dsw-alias-brand-primary,#4d6bfe);background:none;border:0;padding:2px 0;cursor:pointer}
.dlo-cats{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 9px}
.dlo-cat{font:inherit;font-size:11px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;cursor:pointer;line-height:1.6}
.dlo-cat:hover{border-color:#4d6bfe;color:#4d6bfe}
.dlo-cat-on{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
.dlo-cat-on:hover{background:#3b57d6;color:#fff}
.dlo-table{width:100%;border-collapse:collapse;font-size:12px}
.dlo-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
.dlo-table td{padding:7px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent);vertical-align:middle}
.dlo-table tr:last-child td{border-bottom:0}
.dlo-row-bad td{opacity:.72}
.dlo-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr));gap:8px;margin-bottom:10px}
.dlo-kpi{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.dlo-kpi-l{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dlo-kpi-v{font-size:20px;font-weight:700;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dlo-kpi-s{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dlo-charts{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:10px;margin-bottom:10px}
.dlo-chart{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.dlo-chart-title{font-size:11.5px;font-weight:600;margin-bottom:6px}
.dlo-donut-wrap{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.dlo-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;pointer-events:none}
.dlo-donut-center b{font-size:16px;line-height:1}
.dlo-donut-center span{font-size:9.5px;color:var(--dsw-alias-label-secondary)}
.dlo-legend{display:flex;flex-direction:column;gap:3px;font-size:11px;min-width:0;flex:1 1 120px}
.dlo-legend-row{display:flex;align-items:center;gap:5px;min-width:0}
.dlo-legend-row i{width:8px;height:8px;border-radius:2px;flex:none}
.dlo-legend-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dlo-legend-val{font-variant-numeric:tabular-nums}
.dlo-spark{display:block}
.dlo-spark-foot{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.dlo-bars{display:flex;flex-direction:column;gap:5px}
.dlo-bar-row{display:flex;align-items:center;gap:8px;font-size:11px;min-width:0}
.dlo-bar-name{width:104px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dlo-bar-track{flex:1 1 auto;height:7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);overflow:hidden}
.dlo-bar-fill{display:block;height:100%;border-radius:999px;background:#4d6bfe}
.dlo-bar-val{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dlo-ctx{display:flex;align-items:center;gap:6px;white-space:nowrap}
.dlo-ctx-track{width:56px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);overflow:hidden;flex:none}
.dlo-ctx-fill{display:block;height:100%;border-radius:999px;background:#10b981}
.dlo-ctx-high{background:#ef4444}
.dlo-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dlo-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.dlo-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dlo-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dlo-input,.dlo-select,.dlo-textarea{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 9px;min-width:0}
.dlo-textarea{min-height:160px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:1.5;white-space:pre;resize:vertical}
.dlo-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr));gap:10px}
.dlo-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.dlo-err{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dlo-loading{padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dlo-ok{color:var(--dsw-alias-state-success-primary);font-size:11.5px}
.dlo-pref{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11.5px;line-height:1.5;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);border-radius:999px;padding:2px 9px;margin-right:6px;cursor:pointer;white-space:nowrap}
.dlo-pref:hover{border-color:#4d6bfe;color:#4d6bfe}
.dlo-pref-on{color:#fff;background:#4d6bfe;border-color:#4d6bfe}
.dlo-pref-on:hover{color:#fff;border-color:#3b57d6;background:#3b57d6}
.dlo-pref-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.75;flex:none}
.dlo-task{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dlo-task-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dlo-task-title{font-weight:600;font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46ch}
.dlo-task-meta{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.dlo-task-id{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dlo-steps{display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:7px}
.dlo-step{display:flex;align-items:center;gap:7px;font-size:11.5px;min-width:0}
.dlo-step-goal{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlo-step-meta{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;flex:none}
.dlo-lease{display:flex;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dlo-group-title{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:600;margin:2px 0;display:flex;align-items:center;gap:6px}
`;

		function ensureCss() {
			if (typeof document === "undefined") return;
			// 热更新（HMR）会重新执行 factory：已有 style 时替换内容，而不是跳过，
			// 否则改样式必须整页刷新才生效。
			const existing = document.querySelector('style[data-plugin="dsh-local-orchestrator"]');
			if (existing) {
				existing.textContent = CSS;
				return;
			}
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-local-orchestrator";
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		async function api(path, options) {
			const res = await fetch(BASE + path, {
				method: (options && options.method) || "GET",
				headers: { "content-type": "application/json" },
				body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
				cache: "no-store",
			});
			let json = null;
			try {
				json = await res.json();
			} catch (e) {
				json = null;
			}
			if (!json || json.ok !== true) {
				throw new Error((json && json.error) || "HTTP " + res.status);
			}
			return json.value;
		}

		const pct = (value) => (typeof value === "number" && isFinite(value) ? Math.max(0, Math.min(100, value)) : 0);
		const fmtMb = (mb) => {
			if (typeof mb !== "number" || !isFinite(mb) || mb <= 0) return "—";
			return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : Math.round(mb) + " MB";
		};
		const fmtMs = (ms) => {
			if (typeof ms !== "number" || ms < 0) return "—";
			if (ms < 1000) return Math.round(ms) + "ms";
			if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
			const m = Math.floor(ms / 60000);
			const s = Math.round((ms % 60000) / 1000);
			return m + "m " + s + "s";
		};
		/** token / 次数这类整数：上万后带 k，避免表格被撑宽。 */
		const fmtNum = (value) => {
			const n = Number(value) || 0;
			if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
			if (n >= 10000) return (n / 1000).toFixed(1) + "k";
			return String(Math.round(n));
		};
		const fmtSec = (ms) => (typeof ms === "number" && ms > 0 ? (ms / 1000).toFixed(1) + "s" : "—");
		const fmtClock = (ts) => {
			const d = new Date(ts);
			return (
				String(d.getHours()).padStart(2, "0") +
				":" +
				String(d.getMinutes()).padStart(2, "0") +
				":" +
				String(d.getSeconds()).padStart(2, "0")
			);
		};

		function usePolling() {
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			const [tick, setTick] = useState(0);
			useEffect(() => {
				let alive = true;
				let timer = null;
				const loop = async () => {
					try {
						const value = await api("/state");
						if (!alive) return;
						setData(value);
						setError("");
					} catch (e) {
						if (alive) setError(e && e.message ? e.message : String(e));
					}
					if (alive) timer = setTimeout(loop, 1500);
				};
				loop();
				return () => {
					alive = false;
					if (timer) clearTimeout(timer);
				};
			}, [tick]);
			const reload = useCallback(() => setTick((n) => n + 1), []);
			return { data, error, reload };
		}

		function Bar(props) {
			const value = pct(props.value);
			const tone = value >= 90 ? " dlo-fill-err" : value >= 72 ? " dlo-fill-warn" : "";
			return h("div", { className: "dlo-track" }, h("i", { className: "dlo-fill" + tone, style: { width: value + "%" } }));
		}

		function SegBar(props) {
			const total = Number(props.total) || 0;
			if (!total) return null;
			return h(
				"div",
				{ className: "dlo-seg", title: props.title || "" },
				(props.segments || []).map((seg, index) => h("i", {
					key: index,
					className: "dlo-seg-" + seg.kind,
					title: seg.title || "",
					style: { width: pct(((Number(seg.value) || 0) / total) * 100) + "%" },
				})),
			);
		}

		function Legend(props) {
			return h(
				"div",
				{ className: "dlo-legend" },
				(props.items || []).map((item, index) => h("span", { key: index, title: item.title || "" },
					h("i", { className: "dlo-seg-" + item.kind }),
					item.label)),
			);
		}

		function MetricCard(props) {
			// 有 segments 时画分段条：已用 / 可调度 / 保留 各占一段，避免「预留」被当成「正在占用」
			const body = props.segments && props.segments.length
				? h("div", null, h(SegBar, { total: props.total, segments: props.segments }), props.legend ? h(Legend, { items: props.legend }) : null)
				: h(Bar, { value: props.percent });
			return h(
				"div",
				{ className: "dlo-card" },
				h("div", { className: "dlo-card-head" }, h("span", { className: "dlo-card-title" }, props.title)),
				h("div", { className: "dlo-metric" }, props.value, props.unit ? h("small", null, props.unit) : null),
				body,
				h("div", { className: "dlo-kv" }, h("span", null, props.left || ""), h("span", null, props.right || "")),
				props.hint ? h("div", { className: "dlo-hint", style: { marginTop: "4px", fontSize: "10.5px" } }, props.hint) : null,
			);
		}

		function StatusCard(props) {
			return h(
				"div",
				{ className: "dlo-card" },
				h("div", { className: "dlo-card-head" }, h("span", { className: "dlo-card-title" }, props.title)),
				h("div", { className: "dlo-metric", style: { fontSize: "15px" } }, props.value),
				h("div", { className: "dlo-hint", style: { marginTop: "4px" } }, props.hint || ""),
			);
		}

		function AssetCard(props) {
			const { asset, busy, onAction } = props;
			const state = asset.state || "stopped";
			const stateText =
				state === "ready" ? "运行中" : state === "starting" ? "加载中" : state === "failed" ? "失败" : "已停止";
			return h(
				"div",
				{ className: "dlo-asset" },
				h(
					"div",
					{ className: "dlo-asset-top" },
					h("i", { className: "dlo-dot dlo-dot-" + (state === "ready" ? "ready" : state === "failed" ? "error" : "pending") }),
					h("span", { className: "dlo-asset-id", title: asset.id }, asset.id),
					h("span", { className: "dlo-chip", style: { marginLeft: "auto", fontSize: "10px", padding: "1px 6px" } }, KIND_LABEL[asset.kind] || asset.kind),
				),
				h(
					"div",
					{ className: "dlo-asset-meta" },
					h("span", null, stateText + (asset.port ? " · :" + asset.port : "")),
					h("span", null, asset.estimateVramMb ? "约 " + fmtMb(asset.estimateVramMb) : "显存未知"),
					asset.pinned ? h("span", null, "固定") : null,
					!asset.enabled ? h("span", null, "已禁用") : null,
				),
				h(
					"div",
					{ className: "dlo-asset-foot" },
					state === "ready"
						? h("button", { className: "dlo-btn", disabled: busy, onClick: () => onAction("stop", asset) }, "卸载")
						: h("button", { className: "dlo-btn dlo-btn-on", disabled: busy, onClick: () => onAction("load", asset) }, "加载"),
					h("button", { className: "dlo-btn", disabled: busy, onClick: () => onAction("pin", asset) }, asset.pinned ? "取消固定" : "固定"),
					h("button", { className: "dlo-btn", disabled: busy, onClick: () => onAction("toggle", asset) }, asset.enabled ? "禁用" : "启用"),
				),
			);
		}

		function NodeBox(props) {
			const node = props.node;
			const status = node.status || "pending";
			return h(
				"div",
				{ className: "dlo-node dlo-node-" + status, title: node.detail || "" },
				h("div", { className: "dlo-node-label" }, node.label || NODE_KIND_LABEL[node.kind] || node.kind),
				h("div", { className: "dlo-node-sub" }, (node.detail || NODE_KIND_LABEL[node.kind] || "") + (node.status === "running" ? " · 进行中" : node.ms ? " · " + fmtMs(node.ms) : "")),
			);
		}

		function RunCard(props) {
			const run = props.run;
			const total = run.nodes.length;
			const done = run.nodes.filter((n) => n.status === "done").length;
			const progress = total === 0 ? (run.status === "done" ? 100 : 8) : Math.round((done / total) * 100);
			const statusText = run.status === "running" ? "运行中" : run.status === "error" ? "失败" : run.status === "cancelled" ? "已取消" : "完成";
			const items = [];
			run.nodes.forEach((node, i) => {
				if (i > 0) items.push(h("span", { key: "a" + i, className: "dlo-arrow" }, "→"));
				items.push(h(NodeBox, { key: node.id, node }));
			});
			return h(
				"div",
				{ className: "dlo-run" },
				h(
					"div",
					{ className: "dlo-run-head" },
					h("i", { className: "dlo-dot dlo-dot-" + (run.status === "running" ? "running" : run.status === "error" ? "error" : "ready") }),
					h("span", { className: "dlo-run-title", title: run.title }, run.title || "(未命名任务)"),
					h("span", { className: "dlo-chip", style: { fontSize: "10px", padding: "1px 7px" } }, RUN_KIND_LABEL[run.kind] || run.kind),
					h(
						"span",
						{ className: "dlo-run-meta" },
						run.status === "running" && props.onCancel
							? h("button", { className: "dlo-btn dlo-btn-danger", onClick: () => props.onCancel(run) }, "取消")
							: null,
						h("span", null, statusText),
						h("span", null, fmtMs(run.ms)),
						h("span", null, done + "/" + total + " 步"),
					),
				),
				run.summary ? h("div", { className: "dlo-run-summary", title: run.summary }, run.summary) : null,
				h("div", { className: "dlo-track", style: { marginTop: 0 } }, h("i", { className: "dlo-fill" + (run.status === "error" ? " dlo-fill-err" : ""), style: { width: progress + "%" } })),
				total > 0 ? h("div", { className: "dlo-flow" }, items) : h("div", { className: "dlo-hint" }, "等待第一个执行节点…"),
			);
		}

		function IoCard(props) {
			const entry = props.entry;
			const [open, setOpen] = useState(false);
			const kindText = entry.kind === "request" ? "输入" : entry.kind === "error" ? "错误" : "输出";
			const isLong = (entry.content || "").length > 360;
			return h(
				"div",
				{ className: "dlo-io-card" },
				h(
					"div",
					{ className: "dlo-io-head" },
					h("i", { className: "dlo-dot dlo-dot-" + (entry.kind === "error" ? "error" : entry.kind === "request" ? "pending" : "ready") }),
					h("span", { className: "dlo-io-title", title: entry.title }, entry.title || kindText),
					h("span", null, kindText),
					h("span", { className: "dlo-io-time" }, fmtClock(new Date(entry.ts).getTime())),
				),
				h("pre", { className: "dlo-pre" + (open ? " dlo-pre-open" : "") }, entry.content || ""),
				isLong ? h("button", { className: "dlo-more", onClick: () => setOpen(!open) }, open ? "收起" : "展开全部") : null,
			);
		}

		function IoColumn(props) {
			return h(
				"div",
				{ className: "dlo-col" },
				h("div", { className: "dlo-col-head" }, h("span", null, props.title), h("span", { className: "dlo-n" }, props.entries.length + " 条")),
				h(
					"div",
					{ className: "dlo-col-body" },
					props.entries.length === 0
						? h("div", { className: "dlo-hint", style: { padding: "10px 4px" } }, props.empty || "暂无记录")
						: props.entries.map((entry) => h(IoCard, { key: entry.id, entry })),
				),
			);
		}

		function Field(props) {
			return h(
				"label",
				{ className: "dlo-field" },
				h("span", { className: "dlo-label" }, props.label),
				props.children,
				props.hint ? h("span", { className: "dlo-hint" }, props.hint) : null,
			);
		}

		function SettingsTab(props) {
			const { config, assets = [], onSaved, notify } = props;
			const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(config || {})));
			const [saving, setSaving] = useState(false);
			const [testText, setTestText] = useState("");
			const [testBusy, setTestBusy] = useState(false);
			const set = (section, key, value) => {
				setDraft((prev) => {
					const next = JSON.parse(JSON.stringify(prev));
					if (!next[section]) next[section] = {};
					next[section][key] = value;
					return next;
				});
			};
			const num = (section, key, value) => set(section, key, Number(value) || 0);
			const save = async () => {
				setSaving(true);
				try {
					const patch = {
						scheduler: draft.scheduler,
						hardware: draft.hardware,
						decision: draft.decision,
						prompt: draft.prompt,
						comfy: draft.comfy,
						mcpServers: draft.mcpServers,
					};
					await api("/config", { method: "PUT", body: { patch } });
					notify("配置已保存");
					onSaved && onSaved();
				} catch (e) {
					notify("保存失败：" + (e.message || e), true);
				} finally {
					setSaving(false);
				}
			};
			const test = async () => {
				setTestBusy(true);
				setTestText("");
				try {
					const value = await api("/decision/test", { method: "POST", body: { prompt: "用一句中文说明你现在能做什么。" } });
					setTestText((value.model || "决策模型") + "：" + value.text);
				} catch (e) {
					setTestText("调用失败：" + (e.message || e));
				} finally {
					setTestBusy(false);
				}
			};
			const d = draft.decision || {};
			const s = draft.scheduler || {};
			const hw = draft.hardware || {};
			return h(
				"div",
				{ className: "dlo-grid" },
				h(
					"div",
					{ className: "dlo-card" },
					h("div", { className: "dlo-card-head" }, h("span", { className: "dlo-card-title" }, h("b", null, "调度策略"))),
					h(
						"div",
						{ className: "dlo-form" },
						h(Field, { label: "GPU 互斥", hint: "8GB 显存建议开启：同时只跑一个吃显存的模型" },
							h("select", { className: "dlo-select", value: String(s.gpuExclusive !== false), onChange: (e) => set("scheduler", "gpuExclusive", e.target.value === "true") },
								h("option", { value: "true" }, "开启（互斥）"),
								h("option", { value: "false" }, "关闭（并发）"),
							)),
						h(Field, { label: "空闲卸载（秒）", hint: "0 表示不自动卸载" },
							h("input", { className: "dlo-input", type: "number", value: s.idleUnloadSec ?? 900, onChange: (e) => num("scheduler", "idleUnloadSec", e.target.value) })),
						h(Field, { label: "任务结束释放（秒）", hint: "所有任务结束后多久释放空闲模型；0 关闭" },
							h("input", { className: "dlo-input", type: "number", value: s.releaseAfterTaskSec ?? 30, onChange: (e) => num("scheduler", "releaseAfterTaskSec", e.target.value) })),
						h(Field, { label: "CPU 槽并发数" },
							h("input", { className: "dlo-input", type: "number", value: s.maxCpuLoads ?? 2, onChange: (e) => num("scheduler", "maxCpuLoads", e.target.value) })),
						h(Field, { label: "加载超时（毫秒）" },
							h("input", { className: "dlo-input", type: "number", value: s.loadTimeoutMs ?? 600000, onChange: (e) => num("scheduler", "loadTimeoutMs", e.target.value) })),
						h(Field, { label: "显存预留（MB）", hint: "给桌面/驱动留的空间" },
							h("input", { className: "dlo-input", type: "number", value: hw.reserveVramMb ?? 768, onChange: (e) => num("hardware", "reserveVramMb", e.target.value) })),
						h(Field, { label: "预留比例" },
							h("input", { className: "dlo-input", type: "number", step: "0.01", value: hw.reserveRatio ?? 0.08, onChange: (e) => set("hardware", "reserveRatio", Number(e.target.value) || 0) })),
					),
				),
				h(
					"div",
					{ className: "dlo-card" },
					h("div", { className: "dlo-card-head" }, h("span", { className: "dlo-card-title" }, h("b", null, "决策模型"))),
					h(
						"div",
						{ className: "dlo-hint", style: { marginBottom: "10px" } },
						"只保留两种：复用当前会话的 DeepSeek（直接走会话的 provider / apiKey，不另配密钥），或本地文本模型（不联网、占一块显存）。" +
							"选本地时，会话模型仍负责对话和工具选择，本地模型只做「规划/评估」。",
					),
					h(
						"div",
						{ className: "dlo-form" },
						h(Field, { label: "决策来源" },
							h("select", {
								className: "dlo-select",
								value: d.mode === "local" ? "local" : "dsh",
								onChange: (e) => set("decision", "mode", e.target.value === "local" ? "local" : "dsh"),
							},
								h("option", { value: "dsh" }, "DeepSeek（当前会话的 API）"),
								h("option", { value: "local" }, "本地文本模型"),
							)),
						d.mode === "local"
							? h(Field, { label: "本地决策模型", hint: "只列已启用的文本/多模态资产" },
								h("select", {
									className: "dlo-select",
									value: d.localAsset || "",
									onChange: (e) => set("decision", "localAsset", e.target.value),
								},
									h("option", { value: "" }, "（未选择）"),
									(assets || [])
										.filter((item) => (item.kind === "llm" || item.kind === "vlm") && item.enabled !== false)
										.map((item) => h("option", { key: item.id, value: item.id }, item.id + "（" + item.kind + "）")),
								))
							: h(Field, { label: "provider（可选）", hint: "留空 = 跟随当前会话；填了才覆盖（用来换更便宜的模型）" },
								h("input", { className: "dlo-input", placeholder: "如 deepseek", value: d.provider || "", onChange: (e) => set("decision", "provider", e.target.value) })),
						d.mode === "local"
							? null
							: h(Field, { label: "model（可选）", hint: "留空 = 用会话当前模型" },
								h("input", { className: "dlo-input", placeholder: "如 deepseek-chat", value: d.model || "", onChange: (e) => set("decision", "model", e.target.value) })),
						h(Field, { label: "多步规划" },
							h("select", { className: "dlo-select", value: String(d.planning !== false), onChange: (e) => set("decision", "planning", e.target.value === "true") },
								h("option", { value: "true" }, "开启"),
								h("option", { value: "false" }, "关闭"),
							)),
					),
				),
				h(
					"div",
					{ className: "dlo-card" },
					h("div", { className: "dlo-card-head" }, h("span", { className: "dlo-card-title" }, h("b", null, "生成与 MCP"))),
					h(
						"div",
						{ className: "dlo-form" },
						h(Field, { label: "工作流选择", hint: "自动：按 prompt 关键词挑；固定：始终用下面的模板" },
							h("select", { className: "dlo-select", value: String(!(draft.comfy && draft.comfy.autoSelect === false)), onChange: (e) => set("comfy", "autoSelect", e.target.value === "true") },
								h("option", { value: "true" }, "自动选择（推荐）"),
								h("option", { value: "false" }, "固定模板"),
							)),
						h(Field, { label: "图像工作流模板" }, h("input", { className: "dlo-input", placeholder: "如 zimage", value: (draft.comfy && draft.comfy.imageWorkflow) || "", onChange: (e) => set("comfy", "imageWorkflow", e.target.value) })),
						h(Field, { label: "视频工作流模板" }, h("input", { className: "dlo-input", placeholder: "如 minimax-h3-t2v", value: (draft.comfy && draft.comfy.videoWorkflow) || "", onChange: (e) => set("comfy", "videoWorkflow", e.target.value) })),
						h(Field, { label: "语音工作流模板" }, h("input", { className: "dlo-input", placeholder: "如 acestep", value: (draft.comfy && draft.comfy.audioWorkflow) || "", onChange: (e) => set("comfy", "audioWorkflow", e.target.value) })),
					),
					h(
						"div",
						{ className: "dlo-hint", style: { marginTop: "8px" } },
						"自动选择依据：视频/音乐/图片按 prompt 推断，海报/带字→ernie，二次元/动漫→anima，通用/写实→zimage，首帧→minimax-h3-i2v。" +
							((props.workflowProfiles && props.workflowProfiles.length)
								? " 现有：" + props.workflowProfiles.map((item) => item.id + "（" + (item.strengths || item.kind) + "）").join("；")
								: "") +
							" MCP 服务在 config.json 的 mcpServers 里登记（数组，每项 {id,name,desc}），重启后出现在资产列表。",
					),
				),
				h(
					"div",
					{ className: "dlo-card" },
					h(
						"div",
						{ className: "dlo-card-head" },
						h("span", { className: "dlo-card-title" }, h("b", null, "保存与自检")),
						h("span", { className: "dlo-card-extra" },
							h("button", { className: "dlo-btn", disabled: testBusy, onClick: test }, testBusy ? "调用中…" : "测试决策模型"),
							h("button", { className: "dlo-btn dlo-btn-on", disabled: saving, onClick: save }, saving ? "保存中…" : "保存配置")),
					),
					h("div", { className: "dlo-hint", style: { whiteSpace: "pre-wrap" } }, testText || "修改后点「保存配置」写入 ~/.dsh/local-orchestrator/config.json；调度参数即时生效。"),
				),
			);
		}

		const FRAMEWORK_LABEL = { comfyui: "ComfyUI", "llama.cpp": "llama.cpp", python: "Python 脚本", mcp: "MCP", process: "进程" };
		const ROLE_LABEL_UI = {
			model: "主模型", encoder: "编码器", vae: "VAE", mmproj: "视觉投影", vocoder: "声码器",
			tokenizer: "分词/声学", aligner: "强制对齐", speaker: "声纹", vad: "VAD", lora: "LoRA", file: "文件",
		};
		const ROLE_OPTIONS = ['model', 'encoder', 'vae', 'mmproj', 'vocoder', 'aligner', 'speaker', 'vad', 'lora', 'file'];

		function AssetsTab(props) {
			const { assets, frameworks, onAction, notify, reload } = props;
			const [editing, setEditing] = useState(null);
			const [text, setText] = useState("");
			const [category, setCategory] = useState("all");
			const [compEdit, setCompEdit] = useState(null);
			const [compRows, setCompRows] = useState([]);
			const [adding, setAdding] = useState(false);
			const [draft, setDraft] = useState(() => ({
				type: "llama.cpp", id: "", name: "", gguf: "", mmproj: "", ctx: "", port: "",
				workflow: "", script: "", command: "", task: "",
			}));
			const setDraftField = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
			const saveDraft = async () => {
				const id = String(draft.id || "").trim();
				if (!id) {
					notify("资产 id 必填", true);
					return;
				}
				const base = { id, name: String(draft.name || "").trim() || id, task: String(draft.task || "").trim() };
				let body;
				if (draft.type === "llama.cpp") {
					if (!String(draft.gguf || "").trim()) {
						notify("要填 gguf 路径（相对模型目录或绝对路径）", true);
						return;
					}
					body = {
						...base, kind: "llm", runtime: "llama.cpp", slot: "gpu",
						port: Number(draft.port) || 0,
						launch: {
							gguf: String(draft.gguf).trim(),
							mmproj: String(draft.mmproj || "").trim() || null,
							ctx: Number(draft.ctx) || null,
						},
					};
				} else if (draft.type === "workflow") {
					if (!String(draft.workflow || "").trim()) {
						notify("要填工作流 JSON 的绝对路径", true);
						return;
					}
					body = { ...base, kind: "image", runtime: "workflow", serviceId: "comfyui", slot: "gpu", workflow: String(draft.workflow).trim() };
				} else if (draft.type === "script") {
					if (!String(draft.script || "").trim()) {
						notify("要填脚本路径", true);
						return;
					}
					body = { ...base, kind: "audio-tts", runtime: "script", slot: "gpu", script: { file: String(draft.script).trim(), args: [] } };
				} else {
					if (!String(draft.command || "").trim()) {
						notify("要填 MCP 可执行文件路径", true);
						return;
					}
					const command = String(draft.command).trim();
					body = {
						...base, kind: "tool", category: "mcp", runtime: "mcp", slot: "cpu",
						mcp: { command, args: ["mcp"] },
						launch: { command: [command, "mcp"] },
					};
				}
				try {
					await api("/assets", { method: "POST", body: { asset: body } });
					notify("已添加资产 " + id);
					setAdding(false);
					setDraft({ type: draft.type, id: "", name: "", gguf: "", mmproj: "", ctx: "", port: "", workflow: "", script: "", command: "", task: "" });
					reload();
				} catch (e) {
					notify("添加失败：" + (e.message || e), true);
				}
			};
			const renderAddForm = () => h(
				"div",
				{ className: "dlo-edit-inline" },
				h("div", { className: "dlo-hint" },
					"手动登记一个资产。llama.cpp 用模型文件（相对模型根目录或绝对路径），ComfyUI 用工作流 JSON，脚本/MCP 填入口路径；保存后立即做连通性检查。"),
				h("div", { className: "dlo-form" },
					h(Field, { label: "类型" },
						h("select", { className: "dlo-select", value: draft.type, onChange: (e) => setDraftField("type", e.target.value) },
							h("option", { value: "llama.cpp" }, "llama.cpp 模型"),
							h("option", { value: "workflow" }, "ComfyUI 工作流"),
							h("option", { value: "script" }, "一次性脚本"),
							h("option", { value: "mcp" }, "MCP 服务"))),
					h(Field, { label: "id" }, h("input", { className: "dlo-input", placeholder: "唯一 id，如 my-qwen", value: draft.id, onChange: (e) => setDraftField("id", e.target.value) })),
					h(Field, { label: "显示名" }, h("input", { className: "dlo-input", placeholder: "可留空", value: draft.name, onChange: (e) => setDraftField("name", e.target.value) })),
					draft.type === "llama.cpp" ? h(Field, { label: "gguf", hint: "相对 modelsRoot 或绝对路径" }, h("input", { className: "dlo-input", value: draft.gguf, onChange: (e) => setDraftField("gguf", e.target.value) })) : null,
					draft.type === "llama.cpp" ? h(Field, { label: "mmproj（可选）" }, h("input", { className: "dlo-input", value: draft.mmproj, onChange: (e) => setDraftField("mmproj", e.target.value) })) : null,
					draft.type === "llama.cpp" ? h(Field, { label: "ctx" }, h("input", { className: "dlo-input", placeholder: "如 8192", value: draft.ctx, onChange: (e) => setDraftField("ctx", e.target.value) })) : null,
					draft.type === "llama.cpp" ? h(Field, { label: "端口（可选）" }, h("input", { className: "dlo-input", placeholder: "留空自动分配", value: draft.port, onChange: (e) => setDraftField("port", e.target.value) })) : null,
					draft.type === "workflow" ? h(Field, { label: "工作流 JSON" }, h("input", { className: "dlo-input", placeholder: "D:\\…\\workflow.json", value: draft.workflow, onChange: (e) => setDraftField("workflow", e.target.value) })) : null,
					draft.type === "script" ? h(Field, { label: "脚本路径" }, h("input", { className: "dlo-input", placeholder: "D:\\…\\tts_run.py", value: draft.script, onChange: (e) => setDraftField("script", e.target.value) })) : null,
					draft.type === "mcp" ? h(Field, { label: "可执行文件", hint: "会以 <command> mcp 启动" }, h("input", { className: "dlo-input", value: draft.command, onChange: (e) => setDraftField("command", e.target.value) })) : null,
					h(Field, { label: "用途/擅长" }, h("input", { className: "dlo-input", placeholder: "一句话，帮模型挑资产", value: draft.task, onChange: (e) => setDraftField("task", e.target.value) })),
				),
				h("div", { className: "dlo-actions" },
					h("button", { className: "dlo-btn", onClick: () => setAdding(false) }, "取消"),
					h("button", { className: "dlo-btn dlo-btn-on", onClick: saveDraft }, "保存资产")),
			);

			// 一个主模型一行；配套组件（编码器 / VAE / 声码器…）收在它下面，不单独占行
			const primaries = assets.filter((asset) => !asset.hidden);
			const childrenOf = (id) => assets.filter((asset) => asset.componentOf === id);
			const categories = (() => {
				const map = new Map();
				for (const asset of primaries) {
					const key = asset.category || "other";
					map.set(key, (map.get(key) || 0) + 1);
				}
				return [...map.entries()].sort((a, b) => b[1] - a[1]);
			})();
			const shown = category === "all" ? primaries : primaries.filter((asset) => (asset.category || "other") === category);

			const startEdit = async (asset) => {
				if (editing === asset.id) {
					setEditing(null);
					return;
				}
				setEditing(asset.id);
				setText("正在读取资产完整配置…");
				try {
					const full = await api("/assets/" + encodeURIComponent(asset.id));
					setText(JSON.stringify(full, null, 2));
				} catch (e) {
					setText(JSON.stringify({ id: asset.id }, null, 2));
					notify("读取完整配置失败：" + (e.message || e), true);
				}
			};
			const saveEdit = async () => {
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch (e) {
					notify("JSON 解析失败：" + e.message, true);
					return;
				}
				try {
					await api("/assets", { method: "POST", body: { asset: parsed } });
					notify("资产已保存");
					setEditing(null);
					reload();
				} catch (e) {
					notify("保存失败：" + (e.message || e), true);
				}
			};

			const renderEditor = (asset) => h(
				"div",
				{ className: "dlo-edit-inline" },
				h("div", { className: "dlo-hint" }, "高级编辑：launch / health / cost / priority / pinned / components 都可改。"),
				h("textarea", { className: "dlo-textarea", value: text, onChange: (e) => setText(e.target.value), spellCheck: false }),
				h("div", { className: "dlo-actions" },
					h("button", { className: "dlo-btn", onClick: () => setEditing(null) }, "取消"),
					h("button", { className: "dlo-btn dlo-btn-on", onClick: saveEdit }, "保存")),
			);

			const startCompEdit = (asset) => {
				if (compEdit === asset.id) {
					setCompEdit(null);
					return;
				}
				setCompEdit(asset.id);
				setCompRows((asset.components || []).map((item) => ({
					role: item.role || "file",
					name: item.name || item.file || "",				})));
			};
			const updateComp = (index, patch) => setCompRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
			const addComp = () => setCompRows((rows) => [...rows, { role: "encoder", name: "" }]);
			const removeComp = (index) => setCompRows((rows) => rows.filter((_, i) => i !== index));
			const saveComps = async (asset) => {
				const components = compRows
					.map((row) => ({ name: String(row.name || "").trim(), role: row.role }))
					.filter((row) => row.name);
				try {
					await api("/assets", { method: "POST", body: { asset: { id: asset.id, components } } });
					notify("组件已保存");
					setCompEdit(null);
					reload();
				} catch (e) {
					notify("保存组件失败：" + (e.message || e), true);
				}
			};
			const renderCompEditor = (asset) => h(
				"div",
				{ className: "dlo-edit-inline" },
				h("div", { className: "dlo-hint" }, "组件可自行更换：选角色、填文件名（相对 modelsRoot 或 ComfyUI 目录即可，按文件名匹配）。本地找不到的会标 ⚠。"),
				compRows.map((row, index) => h(
					"div",
					{ key: index, className: "dlo-comp-row" },
					h("select", { className: "dlo-select", value: row.role, onChange: (e) => updateComp(index, { role: e.target.value }) },
						ROLE_OPTIONS.map((role) => h("option", { key: role, value: role }, ROLE_LABEL_UI[role] || role))),
					h("input", {
						className: "dlo-input",
						style: { flex: "1 1 auto" },
						placeholder: "文件名，如 ae.safetensors",
						value: row.name,
						onChange: (e) => updateComp(index, { name: e.target.value }),
					}),
					h("button", { className: "dlo-btn dlo-btn-danger", onClick: () => removeComp(index) }, "删除"),
				)),
				h("div", { className: "dlo-actions" },
					h("button", { className: "dlo-btn", onClick: addComp }, "＋ 添加组件"),
					h("button", { className: "dlo-btn", onClick: () => setCompEdit(null) }, "取消"),
					h("button", { className: "dlo-btn dlo-btn-on", onClick: () => saveComps(asset) }, "保存组件")),
			);

			const renderComponent = (item, key) => h(
				"span",
				{
					key,
					className: "dlo-comp" + (item.exists === false ? " dlo-comp-bad" : ""),
					title: (item.file || item.desc || item.name) + (item.exists === false ? "（本地未找到）" : ""),
				},
				(ROLE_LABEL_UI[item.role] || "组件") + " · " + item.name + (item.exists === false ? " ⚠" : ""),
			);

			return h(
				"div",
				{ className: "dlo-grid" },
				h(
					"div",
					{ className: "dlo-card" },
					h(
						"div",
						{ className: "dlo-card-head" },
						h("span", { className: "dlo-card-title" }, h("b", null, "资产列表"), " 主模型 + 配套组件"),
						h("span", { className: "dlo-card-extra" },
							h("button", { className: "dlo-btn dlo-btn-on", onClick: () => setAdding((value) => !value) }, adding ? "收起" : "＋ 添加资产"),
							h("button", { className: "dlo-btn", onClick: () => onAction("sync") }, "从目录导入"),
							h("button", { className: "dlo-btn", onClick: () => onAction("discover") }, "扫描 .gguf")),
					),
					h("div", { className: "dlo-hint", style: { marginBottom: "6px" } },
						"按主模型分组：编码器 / VAE / 声码器 / mmproj 这类零件收在对应主模型下面，不单独占一行；每行标出运行框架、调用方式和连通性。换机器后模型散落各处时，用「添加资产」逐个登记（也可以直接让我加）。"),
					adding ? renderAddForm() : null,
					(frameworks && frameworks.length > 0)
						? h("div", { className: "dlo-frameworks" }, frameworks.map((fw) => h(
							"div",
							{ key: fw.id, className: "dlo-fw", title: fw.path || fw.note },
							h("div", { className: "dlo-fw-top" },
								h("i", { className: "dlo-dot " + (fw.exists ? "dlo-dot-ready" : "dlo-dot-error") }),
								h("span", { className: "dlo-fw-name" }, fw.name),
								h("span", { className: "dlo-chip", style: { fontSize: "10px", padding: "1px 6px", marginLeft: "auto" } }, fw.count + " 个资产"),
								h("span", { className: "dlo-chip" + (fw.exists ? " dlo-chip-on" : " dlo-chip-err"), style: { fontSize: "10px", padding: "1px 6px" } },
									fw.exists ? "可用" : "缺失")),
							h("div", { className: "dlo-fw-path" }, fw.path || fw.note),
						)))
						: null,
					h(
						"div",
						{ className: "dlo-cats" },
						h("button", { className: "dlo-cat" + (category === "all" ? " dlo-cat-on" : ""), onClick: () => setCategory("all") }, "全部 " + primaries.length),
						categories.map(([key, count]) => h(
							"button",
							{ key, className: "dlo-cat" + (category === key ? " dlo-cat-on" : ""), onClick: () => setCategory(key) },
							({ text: "文本", vector: "向量", image: "图像", video: "视频", music: "音乐", audio: "音频", mcp: "MCP" }[key] || key) + " " + count,
						)),
					),
					shown.length === 0
						? h("div", { className: "dlo-empty" }, "该分类下没有资产。")
						: h(
							"div",
							{ className: "dlo-assets-grid" },
							shown.map((asset) => {
								const kids = childrenOf(asset.id);
								const comps = asset.components || [];
								const compItems = [
									...comps.map((item) => ({ role: item.role, name: item.name, title: item.file || item.name, exists: item.exists })),
									...kids.map((item) => ({ role: item.role, name: item.name, title: item.task || item.name })),
								];
								const shownComps = compItems.slice(0, 6);
								const moreComps = compItems.length - shownComps.length;
								const status = asset.state === "ready" ? "运行中" : asset.state === "failed" ? "失败" : "已停止";
								return h(
									"div",
									{ key: asset.id, className: "dlo-asset" + (asset.healthy === false ? " dlo-asset-bad" : "") },
									h(
										"div",
										{ className: "dlo-asset-top" },
										h("i", { className: "dlo-dot dlo-dot-" + (asset.state === "ready" ? "ready" : asset.state === "failed" ? "error" : "pending") }),
										h("span", { className: "dlo-asset-id", title: asset.id }, asset.id),
										h("span", { className: "dlo-chip", style: { fontSize: "10px", padding: "1px 6px" } }, KIND_LABEL[asset.kind] || asset.kind),
										h("span", { className: "dlo-chip", style: { fontSize: "10px", padding: "1px 6px" } }, FRAMEWORK_LABEL[asset.framework] || asset.framework || "—"),
										h("span", { className: "dlo-chip", style: { fontSize: "10px", padding: "1px 6px" } }, asset.slot === "gpu" ? "GPU" : "CPU"),
										h("span", { className: "dlo-chip" + (asset.state === "ready" ? " dlo-chip-on" : ""), style: { fontSize: "10px", padding: "1px 6px" } }, status),
										asset.healthy === false
											? h("span", { className: "dlo-chip dlo-chip-err", style: { fontSize: "10px", padding: "1px 6px" }, title: (asset.missing || []).join("\n") },
												"缺 " + (asset.missing || []).length + " 个文件")
											: null,
										h("span", { className: "dlo-asset-meta", style: { marginLeft: "auto" } },
											h("button", { className: "dlo-btn", onClick: () => startEdit(asset) }, editing === asset.id ? "收起" : "编辑")),
									),
									h("div", { className: "dlo-asset-meta" },
										h("span", null, asset.task || asset.name),
										h("span", null, "端口 " + (asset.port || "—")),
										h("span", null, asset.estimateVramMb ? "显存 " + fmtMb(asset.estimateVramMb) : "显存未知"),
										asset.healthy === false ? h("span", { className: "dlo-err" }, "缺失：" + (asset.missing || []).join("、")) : null,
									),
									(compItems.length)
										? h("div", { className: "dlo-comps" },
											shownComps.map((item, index) => renderComponent(item, "c" + index)),
											moreComps > 0 ? h("span", { className: "dlo-comp" }, "…另 " + moreComps + " 个") : null)
										: null,
									h("div", { className: "dlo-inv" }, "调用：", h("code", null, asset.invoke || "—")),
									h("div", { className: "dlo-actions" },
										asset.healthy === false
											? h("button", { className: "dlo-btn", disabled: true, title: "本地缺文件，修好后再加载" }, "不可调用")
											: asset.state === "ready"
												? h("button", { className: "dlo-btn", onClick: () => onAction("stop", asset) }, "卸载")
												: h("button", { className: "dlo-btn", onClick: () => onAction("load", asset) }, "加载"),
										h("button", { className: "dlo-btn", onClick: () => startCompEdit(asset) }, compEdit === asset.id ? "收起组件" : "改组件"),
										h("button", { className: "dlo-btn", onClick: () => startEdit(asset) }, editing === asset.id ? "收起" : "编辑"),
										h("button", { className: "dlo-btn dlo-btn-danger", onClick: () => onAction("delete", asset) }, "删除"),
									),
									compEdit === asset.id ? renderCompEditor(asset) : null,
									editing === asset.id ? renderEditor(asset) : null,
								);
							}),
						),
				),
			);
		}

		// ------------------------------------------------------------------ 用量
		const USAGE_COLORS = ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#84cc16"];

		/** 环形图：按资产 token 占比。纯 SVG，不依赖图表库。 */
		function UsageDonut(props) {
			const items = props.items || [];
			const total = items.reduce((sum, item) => sum + item.tokens, 0);
			const size = 132;
			const thickness = 16;
			const r = (size - thickness) / 2;
			const c = 2 * Math.PI * r;
			let acc = 0;
			const segs = items.map((item, index) => {
				const dash = total > 0 ? (item.tokens / total) * c : 0;
				const el = h("circle", {
					key: index,
					cx: size / 2,
					cy: size / 2,
					r,
					fill: "none",
					stroke: USAGE_COLORS[index % USAGE_COLORS.length],
					strokeWidth: thickness,
					strokeDasharray: dash + " " + (c - dash),
					strokeDashoffset: -acc,
					transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")",
				});
				acc += dash;
				return el;
			});
			return h(
				"div",
				{ className: "dlo-donut-wrap" },
				h("div", { style: { position: "relative" } },
					h("svg", { width: size, height: size, viewBox: "0 0 " + size + " " + size },
						h("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: "var(--dsw-alias-border-l2)", strokeWidth: thickness }),
						segs),
					h("div", { className: "dlo-donut-center" },
						h("b", null, fmtNum(total)),
						h("span", null, "tokens"))),
				h("div", { className: "dlo-legend" },
					items.slice(0, 6).map((item, index) => h(
						"span",
						{ key: item.id, className: "dlo-legend-row", title: item.id },
						h("i", { style: { background: USAGE_COLORS[index % USAGE_COLORS.length] } }),
						h("span", { className: "dlo-legend-name" }, item.id),
						h("span", { className: "dlo-legend-val" }, fmtNum(item.tokens)),
					)),
					items.length > 6 ? h("span", { className: "dlo-legend-row" }, "…另 " + (items.length - 6) + " 个") : null),
			);
		}

		/** 最近 N 次调用的 token 柱状趋势。 */
		function UsageSpark(props) {
			const points = props.points || [];
			if (points.length === 0) return h("div", { className: "dlo-empty" }, "还没有调用记录。");
			const width = 560;
			const height = 96;
			const max = Math.max(1, ...points.map((item) => item.totalTokens || 0));
			const bw = width / points.length;
			return h(
				"div",
				null,
				h("svg", { width: "100%", height, viewBox: "0 0 " + width + " " + height, preserveAspectRatio: "none", className: "dlo-spark" },
					points.map((item, index) => {
						const hgt = Math.max(1, ((item.totalTokens || 0) / max) * (height - 8));
						return h("rect", {
							key: index,
							x: index * bw + 1,
							y: height - hgt,
							width: Math.max(1, bw - 3),
							height: hgt,
							rx: 1.5,
							fill: item.ok === false ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-primary, #6366f1)",
							opacity: item.ok === false ? 0.5 : 0.85,
						});
					})),
				h("div", { className: "dlo-spark-foot" },
					h("span", null, "最近 " + points.length + " 次 · 峰值 " + fmtNum(max)),
					h("span", null, "灰/红柱 = 失败或空返回")),
			);
		}

		/** 用量页：本地模型的 token 消耗、速度、上下文占用。 */
		function UsageTab(props) {
			const usage = props.usage || null;
			const summary = (usage && usage.summary) || { calls: 0, byAsset: [] };
			const recent = (usage && usage.recent) || [];
			const byAsset = summary.byAsset || [];
			const maxTokens = Math.max(1, ...byAsset.map((item) => item.tokens));
			return h(
				"div",
				{ className: "dlo-grid" },
				h(
					"div",
					{ className: "dlo-card" },
					h(
						"div",
						{ className: "dlo-card-head" },
						h("span", { className: "dlo-card-title" }, h("b", null, "本地模型用量"), " 最近 " + (summary.windowHours || 24) + " 小时"),
						h("span", { className: "dlo-card-extra" },
							h("span", { className: "dlo-hint" }, usage && usage.file ? usage.file : "usage.jsonl"),
							h("button", { className: "dlo-btn", onClick: () => props.reload() }, "刷新")),
					),
					h("div", { className: "dlo-kpis" },
						h("div", { className: "dlo-kpi" },
							h("div", { className: "dlo-kpi-l" }, "调用次数"),
							h("div", { className: "dlo-kpi-v" }, fmtNum(summary.calls)),
							h("div", { className: "dlo-kpi-s" }, "成功 " + fmtNum(summary.okCalls) + " · 失败 " + fmtNum(summary.failedCalls))),
						h("div", { className: "dlo-kpi" },
							h("div", { className: "dlo-kpi-l" }, "输出 tokens"),
							h("div", { className: "dlo-kpi-v" }, fmtNum(summary.completionTokens)),
							h("div", { className: "dlo-kpi-s" }, "输入 " + fmtNum(summary.promptTokens) + " · 合计 " + fmtNum(summary.totalTokens))),
						h("div", { className: "dlo-kpi" },
							h("div", { className: "dlo-kpi-l" }, "输出速度"),
							h("div", { className: "dlo-kpi-v" }, summary.tokensPerSec ? summary.tokensPerSec + " tok/s" : "—"),
							h("div", { className: "dlo-kpi-s" }, "推理总耗时 " + fmtSec(summary.ms))),
						h("div", { className: "dlo-kpi" },
							h("div", { className: "dlo-kpi-l" }, "平均上下文占用"),
							h("div", { className: "dlo-kpi-v" }, summary.avgCtxPct ? summary.avgCtxPct + "%" : "—"),
							h("div", { className: "dlo-kpi-s" }, "按模型 ctx 窗口算；>80% 建议调大 ctx"))),
					h("div", { className: "dlo-charts" },
						h("div", { className: "dlo-chart" },
							h("div", { className: "dlo-chart-title" }, "按资产分配"),
							byAsset.length > 0
								? h(UsageDonut, { items: byAsset.slice(0, 8) })
								: h("div", { className: "dlo-empty" }, "暂无数据")),
						h("div", { className: "dlo-chart" },
							h("div", { className: "dlo-chart-title" }, "最近调用趋势"),
							h(UsageSpark, { points: recent })),
					),
					byAsset.length > 0
						? h("div", { className: "dlo-bars" }, byAsset.slice(0, 6).map((item) => h(
							"div",
							{ key: item.id, className: "dlo-bar-row" },
							h("span", { className: "dlo-bar-name" }, item.id),
							h("span", { className: "dlo-bar-track" },
								h("span", { className: "dlo-bar-fill", style: { width: Math.max(2, (item.tokens / maxTokens) * 100) + "%" } })),
							h("span", { className: "dlo-bar-val" }, fmtNum(item.tokens) + " · " + item.calls + " 次"),
						)))
						: null,
				),
				h(
					"div",
					{ className: "dlo-card" },
					h("div", { className: "dlo-card-head" },
						h("span", { className: "dlo-card-title" }, h("b", null, "调用明细"), " 最近 " + recent.length + " 次")),
					recent.length === 0
						? h("div", { className: "dlo-empty" }, "还没有记录：跑一次 local_chat / local_step 就会出现在这里。")
						: h("table", { className: "dlo-table" },
							h("thead", null,
								h("tr", null,
									["时间", "资产", "输入", "输出", "合计", "耗时", "速度", "上下文"].map((label) => h("th", { key: label }, label)))),
							h("tbody", null, recent.slice().reverse().map((item, index) => {
								const rate = item.ms > 0 ? Math.round((item.completionTokens / (item.ms / 1000)) * 10) / 10 : null;
								const time = item.ts ? new Date(item.ts) : null;
								const ctxFill = h("span", {
									className: "dlo-ctx-fill" + ((item.ctxPct || 0) >= 80 ? " dlo-ctx-high" : ""),
									style: { width: Math.min(100, Math.max(1, item.ctxPct || 0)) + "%" },
								});
								const ctxCell = h("td", null,
									h("span", { className: "dlo-ctx" },
										h("span", { className: "dlo-ctx-track" }, ctxFill),
										h("span", null, item.ctxPct == null ? "—" : item.ctxPct + "%")));
								const assetCell = h("td", null,
									h("b", null, item.assetId),
									item.ok === false ? h("span", { className: "dlo-err" }, " 失败") : null);
								return h("tr", { key: index, className: item.ok === false ? "dlo-row-bad" : "" },
									h("td", null, time ? time.toLocaleTimeString("zh-CN", { hour12: false }) : "—"),
									assetCell,
									h("td", null, fmtNum(item.promptTokens)),
									h("td", null, fmtNum(item.completionTokens)),
									h("td", null, h("b", null, fmtNum(item.totalTokens))),
									h("td", null, item.ms ? (item.ms / 1000).toFixed(1) + "s" : "—"),
									h("td", null, rate ? rate + " tok/s" : "—"),
									ctxCell);
							}))),
				),
			);
		}

		const TASK_STATUS = {
			queued: { label: "排队", cls: "" },
			running: { label: "执行中", cls: "dlo-chip-on" },
			waiting_decision: { label: "待决策", cls: "dlo-chip-warn" },
			paused: { label: "已暂停", cls: "" },
			done: { label: "完成", cls: "dlo-chip-on" },
			error: { label: "失败", cls: "dlo-chip-err" },
			cancelled: { label: "已取消", cls: "" },
		};
		const STEP_DOT = {
			done: "dlo-dot-ready",
			running: "dlo-dot-running",
			error: "dlo-dot-error",
			skipped: "dlo-dot-skipped",
			pending: "dlo-dot-pending",
			ready: "dlo-dot-pending",
		};

		/** 任务池子页：按会话分组 + 步骤树 + 执行环/租约状态。 */
		function TaskPool(props) {
			const items = (props && props.items) || [];
			const leases = (props && props.leases) || [];
			const worker = (props && props.worker) || {};
			const onAction = props && props.onAction;
			const [open, setOpen] = useState(null);
			const [busy, setBusy] = useState("");
			const run = async (task, action) => {
				if (!onAction) return;
				setBusy(task.id + ":" + action);
				try {
					await onAction(task, action);
				} catch (e) {
					/* onAction 内部已经提示过 */
				} finally {
					setBusy("");
				}
			};
			const counts = items.reduce((acc, task) => {
				acc[task.status] = (acc[task.status] || 0) + 1;
				return acc;
			}, {});
			const active = worker.active;

			const head = h(
				"div",
				{ className: "dlo-card" },
				h("div", { className: "dlo-card-head" },
					h("span", { className: "dlo-card-title" }, h("b", null, "执行环"), " 后台按会话轮转推进任务"),
					h("span", { className: "dlo-card-extra" },
						h("span", { className: "dlo-chip " + (worker.running ? "dlo-chip-on" : "") },
							h("i", { className: "dlo-dot " + (worker.running ? "dlo-dot-running" : "dlo-dot-pending") }),
							worker.running ? "运行中" : "未启动"))),
				h("div", { className: "dlo-lease" },
					h("span", null, "任务 " + items.length +
						" · 执行中 " + (counts.running || 0) +
						" · 待决策 " + (counts.waiting_decision || 0) +
						" · 失败 " + (counts.error || 0) +
						" · 完成 " + (counts.done || 0)),
					active
						? h("span", null, "当前步骤：" + active.taskId + " #" + (active.stepIndex + 1) + "（" + active.startedSec + "s）")
						: h("span", null, "当前没有在跑的步骤"),
					h("span", null, leases.length
						? "租约：" + leases.map((lease) => lease.slot + ":" + lease.assetId).join("、")
						: "租约：空闲")),
			);

			if (items.length === 0) {
				return h("div", { className: "dlo-grid" }, head,
					h("div", { className: "dlo-empty" },
						"还没有任务。让模型调用 local_task {\"action\":\"create\",\"goal\":\"…\"} 建一个，再用 local_step 推进一步；之后后台执行环会继续跑。"));
			}

			const groups = {};
			for (const task of items) {
				const key = task.sessionId || "（无会话）";
				(groups[key] = groups[key] || []).push(task);
			}

			return h("div", { className: "dlo-grid" }, head,
				Object.keys(groups).sort().map((sessionId) =>
					h("div", { key: sessionId, className: "dlo-grid" },
						h("div", { className: "dlo-group-title" },
							"会话 " + String(sessionId).slice(0, 18),
							h("span", { className: "dlo-chip" }, groups[sessionId].length + " 个任务")),
						groups[sessionId].map((task) => {
							const meta = TASK_STATUS[task.status] || { label: task.status, cls: "" };
							const expanded = open === task.id;
							const progress = task.progress || { done: 0, total: 0 };
							const pctDone = progress.total ? (progress.done / progress.total) * 100 : 0;
							const dot = task.status === "running" ? "dlo-dot-running"
								: task.status === "error" ? "dlo-dot-error"
									: task.status === "done" ? "dlo-dot-ready" : "dlo-dot-pending";
							return h("div", { key: task.id, className: "dlo-task" },
								h("div", { className: "dlo-task-head" },
									h("i", { className: "dlo-dot " + dot }),
									h("span", { className: "dlo-task-title" }, task.title),
									h("span", { className: "dlo-chip " + meta.cls }, meta.label),
									task.autoAdvance === false ? h("span", { className: "dlo-chip" }, "手动") : null,
									h("span", { className: "dlo-task-meta" },
										h("span", null, progress.done + "/" + progress.total + " 步"),
										h("button", { className: "dlo-more", onClick: () => setOpen(expanded ? null : task.id) }, expanded ? "收起" : "详情"))),
								h("div", { className: "dlo-track" },
									h("i", { className: "dlo-fill" + (task.status === "error" ? " dlo-fill-err" : ""), style: { width: pctDone + "%" } })),
								expanded
									? h("div", { className: "dlo-steps" },
										task.steps.map((step) => h("div", { key: step.index, className: "dlo-step" },
											h("i", { className: "dlo-dot " + (STEP_DOT[step.status] || "dlo-dot-pending") }),
											h("span", { className: "dlo-step-goal" },
												(step.index + 1) + ". " + step.goal + (step.asset ? " → " + step.asset : "")),
											h("span", { className: "dlo-step-meta" },
												step.status +
												(step.ms ? " · " + fmtMs(step.ms) : "") +
												(step.attempts > 1 ? " · 重试 " + (step.attempts - 1) : "")))))
									: null,
								h("div", { className: "dlo-hint" },
									task.pauseReason || (task.planSummary ? "计划：" + task.planSummary : task.id)),
								h("div", { className: "dlo-actions" },
									task.status === "running"
										? h("button", { className: "dlo-btn", disabled: Boolean(busy), onClick: () => run(task, "pause") }, "暂停")
										: null,
									(task.status === "paused" || task.status === "waiting_decision")
										? h("button", { className: "dlo-btn dlo-btn-on", disabled: Boolean(busy), onClick: () => run(task, "resume") }, "恢复")
										: null,
									(task.status === "error" || task.status === "paused")
										? h("button", { className: "dlo-btn", disabled: Boolean(busy), onClick: () => run(task, "rollback") }, "回滚")
										: null,
									(task.status !== "done" && task.status !== "cancelled")
										? h("button", { className: "dlo-btn dlo-btn-danger", disabled: Boolean(busy), onClick: () => run(task, "cancel") }, "取消")
										: null));
						}))));
		}

		function LocalOrchestratorView(props) {
			const { data, error, reload } = usePolling();
			const [tab, setTab] = useState("overview");
			const [busy, setBusy] = useState("");
			const [toast, setToast] = useState(null);
			const timer = useRef(null);
			const notify = useCallback((message, isError) => {
				setToast({ message, isError: Boolean(isError) });
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setToast(null), 3500);
			}, []);
			useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

			const onAction = useCallback(async (action, asset) => {
				const id = asset && asset.id;
				setBusy(id || action);
				try {
					if (action === "load" || action === "stop") {
						await api("/action", { method: "POST", body: { action, asset: id } });
						notify((action === "load" ? "已加载 " : "已卸载 ") + id);
					} else if (action === "pin" || action === "toggle") {
						const patch = action === "pin" ? { id, pinned: !asset.pinned } : { id, enabled: !asset.enabled };
						await api("/assets", { method: "POST", body: { asset: patch } });
						notify("已更新 " + id);
					} else if (action === "stop_all") {
						await api("/action", { method: "POST", body: { action: "stop_all" } });
						notify("已卸载全部本地服务");
					} else if (action === "release") {
						const stopped = await api("/action", { method: "POST", body: { action: "release" } });
						notify(stopped && stopped.length ? "已释放：" + stopped.join("、") : "没有需要释放的空闲资源");
					} else if (action === "delete") {
						await api("/assets/" + encodeURIComponent(id), { method: "DELETE" });
						notify("已删除 " + id);
					} else if (action === "discover" || action === "import") {
						const value = await api("/action", { method: "POST", body: { action } });
						notify((action === "discover" ? "发现 " : "导入 ") + value.length + " 个资产");
					} else if (action === "sync") {
						const value = await api("/action", { method: "POST", body: { action: "sync" } });
						notify("同步完成，新增 " + (value.added ? value.added.length : 0) + " 项，共 " + (value.total || 0) + " 项");
					} else if (action === "cancel_run") {
						await api("/action", { method: "POST", body: { action: "cancel", runId: id } });
						notify("已请求取消任务");
					}
					reload();
				} catch (e) {
					const message = e.message || String(e);
					notify(/未知 action/.test(message)
						? "Node 侧是旧版本：取消要重启 DSH 应用才生效（当前任务会随重启清掉，进程没有启动，不会占资源）。"
						: message, true);
				} finally {
					setBusy("");
				}
			}, [notify, reload]);

			const onTask = useCallback(async (task, action) => {
				try {
					await api("/tasks", { method: "POST", body: { taskId: task.id, action } });
					const label = { pause: "已暂停", resume: "已恢复", cancel: "已取消", rollback: "已回滚", auto: "已切换自动推进" }[action] || "已更新";
					notify(label + " " + task.id);
					reload();
				} catch (e) {
					notify(e && e.message ? e.message : String(e), true);
					throw e;
				}
			}, [notify, reload]);

			if (error && !data) {
				return h("div", { className: "dlo-root" }, h("div", { className: "dlo-empty dlo-err" }, "无法连接本地调度服务：" + error));
			}
			if (!data) return h("div", { className: "dlo-root" }, h("div", { className: "dlo-loading" }, "正在读取本地资源…"));

			const hw = data.hardware || {};
			const mem = hw.memory || {};
			const vram = hw.vram || {};
			const cpu = hw.cpu || {};
			const budget = data.budget || {};
			const running = data.running || [];
			const assets = data.assets || [];
			const runs = data.runs || [];
			const io = data.io || { decision: [], local: [], mcp: [], system: [] };
			const vramPct = vram.totalMb ? (vram.usedMb / vram.totalMb) * 100 : 0;
			const memPct = mem.usedPct || 0;
			const gpuBusy = (data.slots && data.slots.gpu && data.slots.gpu.current) || null;
			const caps = data.capabilities || {};
			const staleNode = !caps.cancel;
			const taskItems = (data.tasks && data.tasks.items) || [];
			const leaseItems = data.leases || [];
			const workerInfo = data.worker || {};
			const budgetTable = data.budgetTable || { bySource: [], entries: [], usableMb: null, committedVramMb: 0 };
			const usage = data.usage || null;
			const activeTasks = taskItems.filter((task) => task.status !== "done" && task.status !== "cancelled").length;
			// 显存三段：真实占用 / 本插件可调度 / 不参与调度的保留
			const vramUsed = Number(vram.usedMb) || 0;
			const vramTotal = Number(vram.totalMb) || 0;
			const vramUsable = Number(budget.vramUsableMb) || 0;
			const vramHeld = Math.max(0, vramTotal - vramUsed - vramUsable);
			const vramReservePolicy = Number(budget.vramReservedMb) || 0;
			const vramFixedReserve = Number(data.config && data.config.hardware && data.config.hardware.reserveVramMb) || 768;
			// 已用里拆出「插件自己加载的模型」：其余就是系统 / 浏览器 / 驱动，避免以为插件在占卡
			const pluginVram = Math.min(vramUsed, Number(budgetTable.committedVramMb) || 0);
			const otherVram = Math.max(0, vramUsed - pluginVram);
			const vramSegments = vramTotal
				? [
					{ kind: "used", value: vramUsed, title: `已用：系统/浏览器/驱动 ${fmtMb(otherVram)}` + (pluginVram ? ` + 插件模型 ${fmtMb(pluginVram)}` : "") + "（WDDM 下无法逐进程归因）" },
					{ kind: "usable", value: vramUsable, title: "本插件还能调度的显存" },
					{ kind: "reserved", value: vramHeld, title: `不参与调度的保留（策略上限 ${fmtMb(vramReservePolicy)}）` },
				]
				: null;
			// 核显 / 独显 / 虚拟显示器：核显共享系统内存，虚拟显示器不算显卡
			const adapters = hw.adapters || [];
			const dgpu = adapters.find((item) => item.kind === "discrete");
			const igpu = adapters.find((item) => item.kind === "integrated");
			const virtualCount = adapters.filter((item) => item.kind === "virtual").length;
			const gpuHint = [
				dgpu ? "独显 " + dgpu.name : "",
				igpu ? "核显 " + igpu.name + "（共享内存，不参与调度）" : "",
				virtualCount ? "已忽略 " + virtualCount + " 个虚拟显示器" : "",
				pluginVram
					? "已用中插件模型 " + fmtMb(pluginVram) + "，其余 " + fmtMb(otherVram) + " 是系统/浏览器"
					: "当前没有插件模型加载；" + fmtMb(otherVram) + " 占用来自系统 / 浏览器 / 驱动",
			].filter(Boolean).join(" · ");

			const tabs = [
				{ id: "overview", label: "总览" },
				{ id: "tasks", label: "任务池", n: activeTasks },
				{ id: "runs", label: "任务", n: runs.filter((r) => r.status === "running").length },
				{ id: "io", label: "输入输出", n: io.decision.length + io.local.length + io.mcp.length },
				{ id: "usage", label: "用量", n: usage && usage.summary ? usage.summary.calls : 0 },
				{ id: "assets", label: "资产", n: assets.length },
				{ id: "settings", label: "设置" },
			];

			return h(
				"div",
				{ className: "dlo-root" },
				h(
					"div",
					{ className: "dlo-head" },
					h("div", { className: "dlo-title" }, "本地资源调度", h("span", { className: "dlo-sub" }, "GPU 槽 " + (data.slots && data.slots.gpu && data.slots.gpu.exclusive !== false ? "互斥" : "并发"))),
					h("div", { className: "dlo-chips" },
						h(LocalFirstToggle, { sessionId: props && (props.sessionId || (props.session && props.session.id)) }),
						h("span", { className: "dlo-chip " + (running.length > 0 ? "dlo-chip-on" : "") }, h("i", { className: "dlo-dot " + (running.length > 0 ? "dlo-dot-running" : "dlo-dot-pending") }), "已加载 " + running.length),
						h("span", { className: "dlo-chip" }, "运行任务 " + runs.filter((r) => r.status === "running").length),
						h("span", { className: "dlo-chip" }, "排队 " + (data.queue || 0)),
						h("span", { className: "dlo-chip" }, "决策 " + (data.config && data.config.decision ? data.config.decision.mode : "session")),
					),
				),
				h("div", { className: "dlo-tabs" }, tabs.map((item) => h(
					"button",
					{ key: item.id, className: "dlo-tab" + (tab === item.id ? " dlo-tab-on" : ""), onClick: () => setTab(item.id) },
					item.label,
					item.n ? h("span", { className: "dlo-tab-n" }, String(item.n)) : null,
				))),
				toast ? h("div", { className: toast.isError ? "dlo-err" : "dlo-ok" }, toast.message) : null,
				staleNode
					? h("div", { className: "dlo-empty dlo-err", style: { marginBottom: "8px", textAlign: "left" } },
						"Node 侧还是旧版本：当前页面已热更新，但「取消 / 自动选工作流 / ComfyUI 修复」要重启应用才生效。请完全退出 DSH 再重新打开（刷新页面不够）。")
					: null,

				tab === "overview"
					? h(
						"div",
						{ className: "dlo-grid" },
						h(
							"div",
							{ className: "dlo-grid dlo-grid-4" },
							h(MetricCard, { title: "CPU", value: (cpu.loadPct == null ? "—" : cpu.loadPct + "%"), unit: cpu.cores + " 核", percent: cpu.loadPct || 0, left: "负载", right: cpu.model ? String(cpu.model).slice(0, 28) : "" }),
							h(MetricCard, { title: "内存", value: fmtMb(mem.usedMb), unit: "/ " + fmtMb(mem.totalMb), percent: memPct, left: (mem.usedPct == null ? "—" : mem.usedPct + "%"), right: "可用 " + fmtMb(mem.freeMb) }),
							h(MetricCard, {
								title: "显存",
								value: fmtMb(vramUsed),
								unit: "/ " + fmtMb(vramTotal),
								total: vramTotal,
								segments: vramSegments,
								legend: vramTotal
									? [
										{ kind: "used", label: "已用 " + fmtMb(vramUsed), title: "系统、浏览器、已加载的本地模型" },
										{ kind: "usable", label: "可调度 " + fmtMb(vramUsable), title: "插件还能加载 / 生成的空间" },
										{ kind: "reserved", label: "保留 " + fmtMb(vramHeld), title: `预留策略：固定 ${fmtMb(vramFixedReserve)} + 总量 8%（上限 ${fmtMb(vramReservePolicy)}）` },
									]
									: null,
								left: "空闲 " + fmtMb(vram.freeMb),
								right: vramTotal ? "策略预留 " + fmtMb(vramReservePolicy) : "",
								hint: gpuHint,
							}),
							h(MetricCard, { title: "GPU 槽", value: gpuBusy ? gpuBusy : "空闲", unit: "", percent: gpuBusy ? 100 : 0, left: "CPU 槽 " + ((data.slots && data.slots.cpu && data.slots.cpu.used) || 0) + "/" + ((data.slots && data.slots.cpu && data.slots.cpu.max) || 0), right: "队列 " + (data.queue || 0) }),
						),
						h(
							"div",
							{ className: "dlo-grid dlo-grid-3" },
							h(StatusCard, {
								title: "决策模型",
								value: ((data.config && data.config.decision && data.config.decision.mode) || "session"),
								hint:
									((data.config && data.config.decision && [data.config.decision.provider, data.config.decision.model].filter(Boolean).join(" / ")) || "由当前会话模型决策") +
									" · 规划 " + ((data.config && data.config.decision && data.config.decision.planning !== false) ? "开" : "关") +
									" · 已记录 " + (io.decision || []).length + " 次调用",
							}),
							h(StatusCard, {
								title: "MCP 服务",
								value: "CPU 槽 · " + assets.filter((asset) => asset.kind === "tool").length + " 个",
								hint: assets.filter((asset) => asset.kind === "tool").map((asset) => asset.id).join("、") || "在 config.json 的 mcpServers 里登记",
							}),
							h(StatusCard, {
								title: "生成工作流",
								value: (data.workflows || []).length + " 个模板",
								hint: (data.workflows || []).slice(0, 4).join("、") || "把 ComfyUI API 工作流放到 <数据目录>/workflows/",
							}),
						),
						h(
							"div",
							{ className: "dlo-card" },
							h("div", { className: "dlo-card-head" }, h("span", { className: "dlo-card-title" }, h("b", null, "本地资产")),
								h("span", { className: "dlo-card-extra" },
									h("button", { className: "dlo-btn", onClick: () => onAction("release") }, "释放空闲"),
									h("button", { className: "dlo-btn", onClick: () => onAction("stop_all") }, "全部卸载"),
									h("button", { className: "dlo-btn", onClick: reload }, "刷新"))),
							assets.length === 0
								? h("div", { className: "dlo-empty" }, "还没有登记资产：去「资产」页扫描模型目录。")
								: h("div", { className: "dlo-assets" }, assets.map((asset) => h(AssetCard, { key: asset.id, asset, busy: busy === asset.id, onAction }))),
						),
						h(
							"div",
							{ className: "dlo-card" },
							h("div", { className: "dlo-card-head" },
								h("span", { className: "dlo-card-title" }, h("b", null, "预算表"), " 显存按科目记账"),
								h("span", { className: "dlo-card-extra" },
									h("span", { className: "dlo-chip" }, "可用 " + fmtMb(budgetTable.usableMb)),
									h("span", { className: "dlo-chip dlo-chip-on" }, "已登记 " + fmtMb(budgetTable.committedVramMb)))),
							(budgetTable.bySource || []).length === 0
								? h("div", { className: "dlo-hint" }, "当前没有占用：加载模型、跑工作流或脚本后，会按科目出现在这里（LLM / 生成工作流 / 一次性脚本 / MCP）。")
								: h("div", { className: "dlo-lease" },
									budgetTable.bySource.map((item) => h("span", { key: item.source },
										item.label + " " + fmtMb(item.vramMb) + "（" + item.count + " 项）"))),
						),
					)
					: null,

				tab === "tasks" ? h(TaskPool, { items: taskItems, leases: leaseItems, worker: workerInfo, onAction: onTask }) : null,

				tab === "runs"
					? h(
						"div",
						{ className: "dlo-grid" },
						runs.length === 0
							? h("div", { className: "dlo-empty" }, "还没有任务。调用 local_chat / local_delegate，或在上方加载模型后，这里会实时出现框图。")
							: runs.map((run) => h(RunCard, { key: run.id, run, onCancel: (item) => onAction("cancel_run", item) })),
					)
					: null,

				tab === "io"
					? h(
						"div",
						{ className: "dlo-io" },
						h(IoColumn, { title: "决策模型", entries: io.decision || [], empty: "决策模型还没有调用（session 模式下由会话模型直接决策）" }),
						h(IoColumn, { title: "本地模型 / 运行", entries: [...(io.local || []), ...(io.system || [])], empty: "本地模型还没有输入输出" }),
						h(IoColumn, { title: "MCP / 生成服务", entries: io.mcp || [], empty: "ComfyUI 工作流与 MCP 调用会出现在这里" }),
					)
					: null,

				tab === "usage" ? h(UsageTab, { usage, reload }) : null,
				tab === "assets" ? h(AssetsTab, { assets, frameworks: data.frameworks || [], onAction, notify, reload }) : null,
				tab === "settings" ? h(SettingsTab, { config: data.config || {}, assets, workflows: data.workflows || [], workflowProfiles: data.workflowProfiles || [], onSaved: reload, notify }) : null,
			);
		}

		function LocalFirstToggle(props) {
			const sessionId = (props && (props.sessionId || (props.session && props.session.id))) || null;
			const [on, setOn] = useState(false);
			const [busy, setBusy] = useState(false);
			useEffect(() => {
				let alive = true;
				const query = sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "";
				fetch(BASE + "/prefs" + query, { cache: "no-store" })
					.then((res) => res.json())
					.then((json) => {
						if (alive && json && json.ok) setOn(Boolean(json.value && json.value.preferLocal));
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [sessionId]);
			const toggle = async () => {
				if (busy) return;
				setBusy(true);
				const next = !on;
				try {
					const res = await fetch(BASE + "/prefs", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, preferLocal: next }),
					});
					const json = await res.json();
					if (json && json.ok) setOn(Boolean(json.value && json.value.preferLocal));
				} catch (e) {
					/* 静默：下次轮询/点击再试 */
				} finally {
					setBusy(false);
				}
			};
			return h(
				"button",
				{
					type: "button",
					className: "dlo-pref" + (on ? " dlo-pref-on" : ""),
					onClick: toggle,
					disabled: busy,
					title: on ? "已开启：优先把任务交给本地模型/算力（点击关闭）" : "开启后优先把任务交给本地模型/算力",
				},
				h("span", { className: "dlo-pref-dot" }),
				"本地优先",
			);
		}

		function apply(ctx) {
			ensureCss();
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: "local-orchestrator",
						order: 45,
						label: () => "本地调度",
					},
					LocalOrchestratorView,
				),
			);
			// 输入框旁的「本地优先」开关：只影响当前会话的系统提示指令
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: "local-first-toggle",
						order: 20,
					},
					LocalFirstToggle,
				),
			);
		}

		const inject = ["slots"];
		const name = "dsh-local-orchestrator";
		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		// 测试钩子：暴露纯组件，便于在没有浏览器时做渲染结构冒烟测试
		exports.__internals = { LocalOrchestratorView, TaskPool, RunCard, IoCard, AssetsTab, UsageTab, SettingsTab, LocalFirstToggle, usePolling };
		return module.exports;
	}
});
