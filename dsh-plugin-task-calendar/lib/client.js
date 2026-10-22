/**
 * Browser half of the task-calendar plugin (hand-written bundle).
 *
 * Contributes three seats to the shipped web shell:
 * - `sidebar.panellist` — the calendar icon that selects the main panel,
 * - `main` key `calendar` — the month grid, day detail, and task editing,
 * - `shell.overlay` — the reminder toast stack plus system notifications.
 *
 * Data comes from the host half's loopback JSON API (`/dsh-task-calendar`). The
 * bundle is written against the frozen platform module table, so it may only
 * require `react`, `react-dom`, `react/jsx-runtime`, `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
 * `@deepseek-ai/dsh-client-ui-primitives`, and `@deepseek-ai/dsh-client-ui-dockkit`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-task-calendar',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-task-calendar'
    const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
    const PRIORITY_LABELS = { high: '高', normal: '中', low: '低' }
    const STATUS_LABELS = { todo: '待办', doing: '进行中', done: '已完成' }
    const TOAST_TTL_MS = 12_000
    const POLL_MS = 30_000
    /** Gantt geometry. */
    const DAY_MS = 86_400_000
    const GANTT_DAY_PX = 34
    const GANTT_HOUR_PX = 52
    const GANTT_NAME_PX = 200
    const GANTT_PRESETS = [
      { id: 'day', label: '一天' },
      { id: 'week', label: '本周' },
      { id: 'fortnight', label: '两周' },
      { id: 'month', label: '本月' },
      { id: 'all', label: '全部' },
    ]
    const SEVERITY_WEIGHT = { error: 0, warn: 1, info: 2, idle: 3 }
    /** Month-grid spanning bands: one lane per multi-day task, 3 lanes max per week row. */
    const BAND_MAX_LANES = 3
    /** One band lane: a 16px bar plus the 1px rule under it. */
    const BAND_LANE_PX = 17
    /**
     * Month-cell metrics, in CSS pixels, mirroring the stylesheet. They exist so
     * the panel can size a row to its content instead of guessing: a row that
     * cannot hold its own bands would otherwise have to drop some of them.
     */
    const CELL_TOP_PX = 19
    const CELL_BOTTOM_PX = 3
    const CHIP_PX = 16
    const CHIP_GAP_PX = 3
    /** Chip lines a row will grow to show before it starts folding into "+N". */
    const CHIP_LINES_CAP = 3
    /** Smallest week row, so a short window never collapses the grid. */
    const ROW_MIN_PX = 66
    /** Upper bound on a grown row, so one busy week cannot swallow the month. */
    const ROW_MAX_PX = 216
    /** Nominal hover-card box, used to keep it inside the panel. */
    const CARD_WIDTH_PX = 300
    const CARD_HEIGHT_PX = 170

    /**
     * How many task chips fit in one day cell without clipping.
     * @param rowHeight - measured height of a week row.
     * @param bandSpace - pixels the row's spanning bands reserve at the top.
     * @returns the number of chip lines the cell can show (0 when nothing fits).
     */
    function chipSlots(rowHeight, bandSpace) {
      const usable = rowHeight - CELL_TOP_PX - bandSpace - CELL_BOTTOM_PX
      if (!Number.isFinite(usable) || usable <= 0) return 0
      // A flex column puts a gap BETWEEN lines only, so `L` lines need
      // `L * CHIP + (L - 1) * GAP`. Solving that for L is exact here, and both
      // branches of `chipWindow` (all chips, or all-but-one plus the counter)
      // stay within this budget.
      return Math.max(0, Math.min(CHIP_LINES_CAP + 3, Math.floor((usable + CHIP_GAP_PX) / (CHIP_PX + CHIP_GAP_PX))))
    }

    /**
     * Which chips a cell shows, and how many it hides. The "+N" line costs a
     * full row of its own, so a cell that is about to overflow shows one fewer
     * chip — that is what keeps every rendered glyph fully visible.
     * @param count - tasks on that day.
     * @param slots - result of `chipSlots`.
     * @returns `{ show, hidden, more }`; `more` is false when there is no room
     * for the counter line at all, so the cell shows real tasks (or nothing)
     * instead of a half-cut line.
     */
    function chipWindow(count, slots) {
      if (slots <= 0) return { show: 0, hidden: count, more: false }
      if (count <= slots) return { show: count, hidden: 0, more: false }
      // One slot: name the first task and fold the rest onto its line
      // (`+3` rides the chip) rather than spending the only line on a counter.
      if (slots === 1) return { show: 1, hidden: count - 1, more: false, inline: true }
      return { show: slots - 1, hidden: count - (slots - 1), more: true }
    }

    const CSS = `
.dsc-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.dsc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsc-title{font-size:15px;font-weight:600;letter-spacing:.2px}
.dsc-clock{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-stats{display:flex;gap:6px;flex-wrap:wrap}
.dsc-stat{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsc-stat b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsc-stat--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsc-stat--error b{color:var(--dsw-alias-state-error-primary)}
.dsc-stat--warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsc-stat--warn b{color:var(--dsw-alias-state-warn-primary)}
.dsc-spacer{flex:1 1 auto}
.dsc-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;line-height:18px}
.dsc-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsc-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:500}
.dsc-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsc-banner{margin:10px 16px 0;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px}
.dsc-banner--error{border-color:var(--dsw-alias-state-error-primary)}
.dsc-banner-row{display:flex;align-items:center;gap:8px;font-size:12px}
.dsc-banner-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-error{margin:10px 16px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px}
.dsc-body{flex:1 1 auto;display:flex;min-height:180px}
.dsc-cal{position:relative;flex:1 1 auto;display:flex;flex-direction:column;min-width:0;padding:10px 14px 14px}
.dsc-weekdays{display:grid;grid-template-columns:repeat(7,1fr);padding:0 0 6px}
.dsc-weekday{text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* One seamless block: rows and cells tile with shared 1px rules instead of
   gaps, so the month reads as a single grid rather than loose cards. */
.dsc-grid{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow-y:auto;overflow-x:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsc-week{position:relative;flex:1 1 0;min-height:68px;display:flex;border-top:1px solid var(--dsw-alias-border-l1)}
.dsc-week:first-child{border-top:0}
.dsc-week-more{position:absolute;right:5px;top:2px;z-index:3;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);border-radius:3px;padding:0 3px}
.dsc-week-cells{flex:1 1 auto;display:grid;grid-template-columns:repeat(7,1fr);min-height:0}
.dsc-band-layer{position:absolute;left:0;right:0;top:19px;display:grid;grid-template-columns:repeat(7,1fr);row-gap:1px;pointer-events:none;z-index:2}
.dsc-band{position:relative;pointer-events:auto;box-sizing:border-box;height:16px;line-height:16px;padding:0 5px;border:0;appearance:none;border-radius:4px;font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)}
.dsc-band--open-left{border-top-left-radius:0;border-bottom-left-radius:0}
.dsc-band--open-right{border-top-right-radius:0;border-bottom-right-radius:0}
.dsc-cellbody{display:flex;flex-direction:column;gap:3px;min-height:0;overflow:hidden}
.dsc-cell{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;min-height:0;padding:3px 6px;background:transparent;cursor:pointer;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l1)}
.dsc-cell:first-child{border-left:0}
.dsc-cell:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 7%,transparent)}
.dsc-cell--out{opacity:.45}
.dsc-cell--selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.dsc-cellhead{display:flex;align-items:center;justify-content:space-between;font-size:12px;line-height:14px;color:var(--dsw-alias-label-secondary)}
.dsc-today .dsc-daynum{color:var(--dsw-alias-brand-primary);font-weight:700}
.dsc-daynum{font-size:12px}
.dsc-chip{position:relative;display:block;width:100%;box-sizing:border-box;text-align:left;border:0;appearance:none;border-radius:4px;padding:0 5px;font-size:12px;line-height:16px;height:16px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 24%,transparent);color:var(--dsw-alias-label-primary)}
/* Calendar chips, spanning bands and gantt bars share one palette: a pale
   track under a solid progress overlay. Keeping the selectors together is what
   stops the month grid and the board from drifting apart. */
.dsc-chip--error,.dsc-band--error,.dsc-gantt-bar--error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,transparent)}
.dsc-chip--warn,.dsc-band--warn,.dsc-gantt-bar--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 24%,transparent)}
.dsc-chip--info,.dsc-band--info,.dsc-gantt-bar--info{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dsc-chip--success,.dsc-band--success,.dsc-gantt-bar--success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 24%,transparent)}
.dsc-chip--idle,.dsc-band--idle,.dsc-gantt-bar--idle{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)}
.dsc-chip--success,.dsc-band--success,.dsc-gantt-bar--success{color:var(--dsw-alias-label-secondary)}
/* The solid elapsed portion, shared by all three. */
.dsc-chip-fill,.dsc-band-fill,.dsc-gantt-fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px 0 0 4px}
.dsc-chip-fill--error,.dsc-band-fill--error,.dsc-gantt-fill--error{background:var(--dsw-alias-state-error-primary)}
.dsc-chip-fill--warn,.dsc-band-fill--warn,.dsc-gantt-fill--warn{background:var(--dsw-alias-state-warn-primary)}
.dsc-chip-fill--info,.dsc-band-fill--info,.dsc-gantt-fill--info{background:var(--dsw-alias-brand-primary)}
.dsc-chip-fill--success,.dsc-band-fill--success,.dsc-gantt-fill--success{background:var(--dsw-alias-state-success-primary)}
.dsc-chip-fill--idle,.dsc-band-fill--idle,.dsc-gantt-fill--idle{background:var(--dsw-alias-label-secondary)}
.dsc-chip-text,.dsc-band-text{position:relative;z-index:1}
.dsc-more{display:block;font-size:11px;line-height:18px;height:18px;color:var(--dsw-alias-label-secondary);padding-left:2px;overflow:hidden;white-space:nowrap}
.dsc-chip-more{font-size:10px;color:var(--dsw-alias-label-secondary)}
.dsc-side{width:330px;flex:0 0 auto;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}
.dsc-sidehead{padding:12px 14px 6px;display:flex;align-items:baseline;gap:8px}
.dsc-sidedate{font-size:13px;font-weight:600}
.dsc-sidesub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-list{flex:1 1 auto;overflow:auto;padding:4px 14px 14px;display:flex;flex-direction:column;gap:8px}
.dsc-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:5px}
.dsc-card--error{border-color:var(--dsw-alias-state-error-primary)}
.dsc-card--warn{border-color:var(--dsw-alias-state-warn-primary)}
.dsc-card--success{border-color:var(--dsw-alias-state-success-primary)}
.dsc-card-title{font-size:13px;font-weight:500;line-height:18px;word-break:break-word}
.dsc-card--done .dsc-card-title{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.dsc-meta{display:flex;flex-wrap:wrap;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-badge{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;line-height:16px;border:1px solid var(--dsw-alias-border-l1)}
.dsc-badge--error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsc-badge--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsc-badge--info{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsc-badge--success{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsc-badge--idle{color:var(--dsw-alias-label-secondary)}
.dsc-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsc-note{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.dsc-empty{padding:24px 8px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-foot{padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dsc-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.dsc-field label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:12px;font-family:inherit}
.dsc-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsc-row{display:flex;gap:8px}
.dsc-row>*{flex:1 1 0;min-width:0}
.dsc-overlay{position:fixed;right:18px;bottom:18px;z-index:80;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(360px,90vw)}
.dsc-toast{pointer-events:auto;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.22);padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.dsc-toast--error{border-color:var(--dsw-alias-state-error-primary)}
.dsc-toast--warn{border-color:var(--dsw-alias-state-warn-primary)}
.dsc-toast-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.dsc-toast-body{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsc-toast-actions{display:flex;gap:6px;justify-content:flex-end}
.dsc-icon-badge{position:relative;display:inline-flex}
.dsc-icon-dot{position:absolute;top:-1px;right:-2px;min-width:12px;height:12px;border-radius:999px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:9px;line-height:12px;text-align:center;padding:0 3px}
.dsc-splitter{flex:0 0 auto;height:6px;cursor:row-resize;border-top:1px solid var(--dsw-alias-border-l1)}
.dsc-splitter:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.dsc-gantt{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden}
.dsc-gantt-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 14px 4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-gantt-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin-right:2px}
.dsc-gantt-body{flex:1 1 auto;min-height:0;overflow:auto}
.dsc-gantt-inner{position:relative;display:inline-block;min-width:100%}
.dsc-gantt-axis{position:sticky;top:0;z-index:3;display:flex;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsc-gantt-axisname{position:sticky;left:0;z-index:4;flex:0 0 200px;width:200px;box-sizing:border-box;background:var(--dsw-alias-bg-base);border-right:1px solid var(--dsw-alias-border-l1);padding:2px 8px;font-size:10px;line-height:13px;display:flex;align-items:center;color:var(--dsw-alias-label-secondary)}
.dsc-gantt-ticks{display:flex;flex:0 0 auto}
.dsc-gantt-tick{flex:0 0 auto;box-sizing:border-box;text-align:center;font-size:10px;line-height:13px;padding:2px 0;border-left:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap}
.dsc-gantt-tick--weekend{opacity:.55}
.dsc-gantt-tick--today{color:var(--dsw-alias-brand-primary);font-weight:700;opacity:1}
.dsc-gantt-row{display:flex;height:30px;align-items:stretch}
.dsc-gantt-name{position:sticky;left:0;z-index:2;flex:0 0 200px;width:200px;box-sizing:border-box;background:var(--dsw-alias-bg-base);border-right:1px solid var(--dsw-alias-border-l1);padding:0 8px;font-size:11px;line-height:30px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsc-gantt-name--click{cursor:pointer}
.dsc-gantt-name--click:hover{color:var(--dsw-alias-brand-primary)}
.dsc-gantt-name--done{text-decoration:line-through;opacity:.55}
.dsc-gantt-track{position:relative;flex:0 0 auto;height:100%;overflow:hidden;background-image:repeating-linear-gradient(to right,transparent 0 calc(var(--dsc-gridw,34px) * 6 - 1px),var(--dsw-alias-border-l2) calc(var(--dsc-gridw,34px) * 6 - 1px) calc(var(--dsc-gridw,34px) * 6)),repeating-linear-gradient(to right,var(--dsw-alias-border-l1) 0 1px,transparent 1px var(--dsc-gridw,34px))}
.dsc-gantt-nav{display:inline-flex;align-items:center;gap:4px}
.dsc-gantt-navday{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:104px;text-align:center}
.dsc-gantt-bar--allday{background-image:repeating-linear-gradient(45deg,transparent 0 4px,color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent) 4px 8px)}
.dsc-gantt-row:hover .dsc-gantt-track{background-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 6%,transparent)}
.dsc-gantt-bar{position:absolute;top:7px;height:16px;border-radius:4px;overflow:hidden;cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 20%,transparent);display:flex;align-items:center}
/* A deadline-only task is a solid diamond in its own tone: green once done,
   red once overdue, amber while it is merely today's work. */
.dsc-gantt-bar--milestone{top:9px;height:12px;border:0;border-radius:2px;transform:rotate(45deg)}
.dsc-gantt-bar--milestone.dsc-gantt-bar--error{background:var(--dsw-alias-state-error-primary)}
.dsc-gantt-bar--milestone.dsc-gantt-bar--warn{background:var(--dsw-alias-state-warn-primary)}
.dsc-gantt-bar--milestone.dsc-gantt-bar--info{background:var(--dsw-alias-brand-primary)}
.dsc-gantt-bar--milestone.dsc-gantt-bar--success{background:var(--dsw-alias-state-success-primary)}
.dsc-gantt-bar--milestone.dsc-gantt-bar--idle{background:var(--dsw-alias-label-secondary)}
.dsc-chip--done,.dsc-band--done,.dsc-gantt-bar--done{opacity:.9}
.dsc-gantt-label{position:relative;z-index:1;font-size:10px;line-height:16px;padding:0 5px;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-primary)}
.dsc-gantt-now{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-brand-primary);opacity:.75;z-index:1}
.dsc-gantt-empty{padding:16px;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-gantt-legend{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsc-hover-card{position:absolute;z-index:30;width:300px;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 26px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:4px;pointer-events:none}
.dsc-hover-card-head{display:flex;align-items:center;gap:6px;min-width:0}
.dsc-hover-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-hover-card-row{display:flex;gap:8px;font-size:11px;line-height:15px}
.dsc-hover-card-label{flex:0 0 40px;color:var(--dsw-alias-label-secondary)}
.dsc-hover-card-value{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word}
.dsc-hover-card-notes{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);max-height:45px;overflow:hidden;word-break:break-word;white-space:pre-wrap}
.dsc-hover-card-hint{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px}
`

    /** Inject the stylesheet once per document, with the build's dataset convention. */
    const STYLE_TAG_ID = 'dsh-plugin-task-calendar/client.css'
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-task-calendar'
      style.dataset.pluginCss = STYLE_TAG_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ────────────────────────────── state ──────────────────────────────

    let snapshot = {
      status: 'loading',
      error: null,
      data: null,
      toasts: [],
      busy: false,
    }
    const listeners = new Set()
    const seenAlerts = new Set()

    function emit() {
      for (const listener of [...listeners]) listener()
    }

    function commit(patch) {
      snapshot = { ...snapshot, ...patch }
      emit()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** React binding for the module-level store. */
    function useSnapshot() {
      const [value, setValue] = useState(snapshot)
      useEffect(() => subscribe(() => setValue(snapshot)), [])
      return value
    }

    function apiPath(path) {
      return API + path
    }

    /** One JSON call against the host route. */
    async function api(path, options = {}) {
      const init = { method: options.method ?? 'GET', headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(apiPath(path), init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) throw new Error(`日历接口无响应（HTTP ${response.status}）`)
      if (payload.ok === false) throw new Error(payload.error ?? `日历接口出错（HTTP ${response.status}）`)
      if (!response.ok) throw new Error(payload.error ?? `日历接口出错（HTTP ${response.status}）`)
      return payload
    }

    /** Ask for, and remember, the browser notification permission. */
    async function ensureNotificationPermission() {
      try {
        if (typeof Notification === 'undefined') return 'unsupported'
        if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission
        return await Notification.requestPermission()
      } catch {
        return 'unsupported'
      }
    }

    /** Fire one system notification when the user allowed it. */
    function notifySystem(alert) {
      try {
        if (snapshot.data?.config?.systemNotify === false) return
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        const detail = alert.countdown === undefined || alert.countdown === '' ? alert.text : `${alert.text}（${alert.countdown}）`
        // eslint-disable-next-line no-new -- the browser owns the notification lifetime
        new Notification(alert.kind === 'overdue' ? '任务日历 · 已逾期' : '任务日历提醒', {
          body: detail,
          tag: alert.key,
        })
      } catch {
        // Notifications are best-effort.
      }
    }

    /** Refetch the projection; queue toasts for reminders not yet shown. */
    async function refresh() {
      try {
        const data = await api('/state')
        const toasts = [...snapshot.toasts]
        const known = new Set(toasts.map((toast) => toast.key))
        for (const alert of data.alerts ?? []) {
          if (known.has(alert.key) || seenAlerts.has(alert.key)) continue
          known.add(alert.key)
          seenAlerts.add(alert.key)
          toasts.push({ ...alert, shownAt: Date.now() })
          notifySystem(alert)
        }
        commit({ status: 'ready', data, error: null, toasts })
        // Superseded milestones are retired silently so they never surface.
        if (Array.isArray(data.staleKeys) && data.staleKeys.length > 0) {
          api('/ack', { method: 'POST', body: { keys: data.staleKeys } }).catch(() => {})
        }
      } catch (error) {
        commit({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }

    /** Acknowledge reminder keys so the host stops reporting them. */
    async function ackKeys(keys) {
      const wanted = (Array.isArray(keys) ? keys : [keys]).filter((key) => typeof key === 'string' && key !== '')
      if (wanted.length === 0) return
      const removing = new Set(wanted)
      commit({ toasts: snapshot.toasts.filter((toast) => !removing.has(toast.key)) })
      try {
        await api('/ack', { method: 'POST', body: { keys: wanted } })
        await refresh()
      } catch (error) {
        commit({ error: error instanceof Error ? error.message : String(error) })
      }
    }

    /** Run a mutating call and refresh the projection. */
    async function mutate(path, options) {
      commit({ busy: true })
      try {
        await api(path, options)
        await refresh()
        return true
      } catch (error) {
        commit({ error: error instanceof Error ? error.message : String(error) })
        return false
      } finally {
        commit({ busy: false })
      }
    }

    // ────────────────────────────── dates ──────────────────────────────

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function dayKey(date) {
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function parseDay(key) {
      const parts = String(key).split('-').map(Number)
      return new Date(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1)
    }

    /** Shift a `YYYY-MM-DD` key by whole days. */
    function shiftDay(key, delta) {
      const date = parseDay(key)
      return dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta))
    }

    /** Six week rows covering the month, Monday first. */
    function monthMatrix(year, month) {
      const first = new Date(year, month, 1)
      const offset = (first.getDay() + 6) % 7
      const start = new Date(year, month, 1 - offset)
      const rows = []
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
        rows.push({ key: dayKey(date), date, inMonth: date.getMonth() === month })
      }
      return rows
    }

    function monthLabel(year, month) {
      return `${year} 年 ${month + 1} 月`
    }

    /**
     * The inclusive day range a task occupies, as `YYYY-MM-DD` keys.
     *
     * A span that ends exactly at midnight belongs to the day it runs through,
     * not to the empty day that starts at that instant — otherwise every
     * "…到次日 00:00" task would paint a phantom second day.
     * @param task - projected task.
     * @returns `{ from, to }`, or null when the task has no date at all.
     */
    function taskDayRange(task) {
      const startDay = task.start === null || task.start === undefined ? null : String(task.start).slice(0, 10)
      const dueDay = task.due === null || task.due === undefined ? null : String(task.due).slice(0, 10)
      if (startDay === null && dueDay === null) return null
      let from = startDay ?? dueDay
      let to = dueDay ?? startDay
      if (to < from) { const swap = from; from = to; to = swap }
      // `…00:00` means the deadline lands at the very start of `to`: the work
      // was done on the previous day.
      if (dueDay !== null && timeOf(task.due) === '00:00' && to > from) to = shiftDay(to, -1)
      return { from, to }
    }

    /**
     * Pack one week row: tasks covering more than one day of the row become
     * spanning bands laid out in lanes, everything else stays a day chip.
     *
     * Bands are what make a multi-day task read as ONE continuous bar instead of
     * a chip on its first day: the row renders them as a 7-column overlay, so a
     * band's left/right edges land exactly on the cells it covers. A task that
     * continues into the next week gets a flat edge there (no rounded cap), and
     * `_edge` flags tell the renderer which caps to round.
     * @param days - the row's seven `YYYY-MM-DD` keys, Monday first.
     * @param tasks - every projected task.
     * @param maxLanes - how many band lanes this row may use. The renderer
     * lowers it on a short row so bands can never squeeze single-day work out
     * of sight; the excess is reported as `hiddenBands`.
     * @returns `{ bands, lanes, hiddenBands, singles }` where `singles` maps a
     * day key to the single-day tasks on it.
     */
    function weekLayout(days, tasks, maxLanes = BAND_MAX_LANES) {
      const column = new Map(days.map((day, index) => [day, index]))
      const first = days[0]
      const last = days[6]
      const singles = new Map()
      const spanning = []
      for (const task of tasks) {
        const range = taskDayRange(task)
        if (range === null) continue
        if (range.to < first || range.from > last) continue
        if (range.from === range.to) {
          const list = singles.get(range.from) ?? []
          list.push(task)
          singles.set(range.from, list)
          continue
        }
        // Clamp the band to this row; the flags keep the true caps rounded.
        const col = column.get(range.from) ?? 0
        const endCol = column.has(range.to) ? column.get(range.to) : 6
        spanning.push({
          task,
          col,
          endCol,
          roundLeft: range.from >= first,
          roundRight: range.to <= last,
        })
      }
      // Longest-first within the same start column keeps the layout stable and
      // packs short work into the lanes the long bars leave empty.
      spanning.sort((a, b) => (a.col - b.col) || ((b.endCol - b.col) - (a.endCol - a.col)))
      const laneEnds = []
      const bands = []
      let hiddenBands = 0
      for (const span of spanning) {
        let lane = laneEnds.findIndex((end) => end < span.col)
        if (lane === -1) {
          if (laneEnds.length >= maxLanes) { hiddenBands += 1; continue }
          lane = laneEnds.length
        }
        laneEnds[lane] = span.endCol
        bands.push({ ...span, lane })
      }
      return { bands, lanes: Math.min(laneEnds.length, maxLanes), hiddenBands, singles }
    }

    function timeOf(value) {
      return typeof value === 'string' && value.length >= 16 ? value.slice(11, 16) : null
    }

    function humanDay(key, today) {
      if (key === today) return '今天'
      const delta = Math.round((parseDay(key) - parseDay(today)) / 86_400_000)
      if (delta === 1) return '明天'
      if (delta === -1) return '昨天'
      const date = parseDay(key)
      const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]
      return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${weekday}`
    }

    function splitTags(text) {
      return String(text ?? '')
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '')
    }

    /**
     * The one colour decision for a task, shared by the month chips, the day
     * list and the gantt board: a finished task is green regardless of how it
     * would otherwise project, an overdue one is red, and everything else keeps
     * the host's severity.
     * @param task - projected task from the host.
     * @returns `success | error | warn | info | idle`.
     */
    function taskTone(task) {
      if (task.status === 'done') return 'success'
      const severity = task.project?.severity
      return severity === 'error' || severity === 'warn' || severity === 'info' || severity === 'idle'
        ? severity
        : 'idle'
    }

    /** Parse a canonical `YYYY-MM-DD` / `YYYY-MM-DD HH:mm` into a local Date. */
    function parseMoment(value) {
      if (typeof value !== 'string' || value.length < 10) return null
      const date = parseDay(value.slice(0, 10))
      if (Number.isNaN(date.getTime())) return null
      const time = timeOf(value)
      if (time !== null) date.setHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0, 0)
      return date
    }

    /** Local midnight of a Date. */
    function midnight(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate())
    }

    /**
     * The visible window of the gantt chart.
     * @param tasks - projected tasks from the host.
     * @param todayKey - `YYYY-MM-DD` of today.
     * @param preset - one of GANTT_PRESETS ids.
     * @param anchorDay - `YYYY-MM-DD` the `day` window is centred on (defaults to today).
     * @returns `{ start, end, days, granularity, pxPerDay, pxPerGrid }` where
     * `end` is exclusive midnight and `pxPerGrid` is the pixel period of one
     * grid line (an hour in the day window, a day everywhere else).
     */
    function ganttAxis(tasks, todayKey, preset, anchorDay) {
      const today = midnight(parseDay(todayKey))
      let start
      let end
      if (preset === 'day') {
        const anchor = anchorDay === undefined || anchorDay === null || anchorDay === '' ? today : midnight(parseDay(anchorDay))
        start = anchor
        end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1)
      } else if (preset === 'week') {
        const weekday = (today.getDay() + 6) % 7
        start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekday)
        end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
      } else if (preset === 'month') {
        start = new Date(today.getFullYear(), today.getMonth(), 1)
        end = new Date(today.getFullYear(), today.getMonth() + 1, 1)
      } else if (preset === 'all') {
        const stamps = [today.getTime()]
        for (const task of tasks) {
          for (const value of [task.start, task.due]) {
            const date = parseMoment(value)
            if (date !== null) stamps.push(date.getTime())
          }
        }
        const min = new Date(Math.min(...stamps))
        const max = new Date(Math.max(...stamps))
        start = new Date(min.getFullYear(), min.getMonth(), min.getDate() - 1)
        end = new Date(max.getFullYear(), max.getMonth(), max.getDate() + 2)
      } else {
        // Default: three days back, ten days ahead — the window most personal
        // task lists actually live in.
        start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3)
        end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 11)
      }
      const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS))
      const granularity = preset === 'day' ? 'hour' : 'day'
      const pxPerDay = granularity === 'hour' ? 24 * GANTT_HOUR_PX : GANTT_DAY_PX
      return {
        start,
        end,
        days,
        granularity,
        pxPerDay,
        pxPerGrid: granularity === 'hour' ? GANTT_HOUR_PX : GANTT_DAY_PX,
      }
    }

    /**
     * Lay every scheduled task onto the axis.
     *
     * A task with both ends draws a span; a task that carries only a *timed*
     * deadline draws a milestone at that instant (so the chart never invents a
     * start). A date without a time of day means an all-day commitment, which
     * covers its whole day instead of collapsing to a point — that is what
     * makes the single-day window readable. `progress` is the filled fraction
     * of the bar itself, so a span already behind us reads as fully elapsed.
     * @param tasks - projected tasks.
     * @param axis - result of `ganttAxis`.
     * @param now - reference moment.
     * @returns rows sorted overdue-first, then by start/deadline, each flagged
     * `offscreen` when it falls entirely outside the window.
     */
    function ganttRows(tasks, axis, now = new Date()) {
      const span = axis.days * DAY_MS
      const ratio = (date) => (date.getTime() - axis.start.getTime()) / span
      const scheduled = tasks.filter((task) => parseMoment(task.start) !== null || parseMoment(task.due) !== null)
      scheduled.sort((a, b) => {
        const wa = SEVERITY_WEIGHT[a.project?.severity] ?? 3
        const wb = SEVERITY_WEIGHT[b.project?.severity] ?? 3
        if (wa !== wb) return wa - wb
        const ta = (parseMoment(a.start ?? a.due) ?? new Date(8.64e15)).getTime()
        const tb = (parseMoment(b.start ?? b.due) ?? new Date(8.64e15)).getTime()
        return ta - tb
      })
      return scheduled.map((task) => {
        const start = parseMoment(task.start)
        const due = parseMoment(task.due)
        const done = task.status === 'done'
        // A date-only value spans its day; only a timed deadline is a point.
        const startAllDay = start !== null && timeOf(task.start) === null
        const dueAllDay = due !== null && timeOf(task.due) === null
        // A milestone is a timed deadline with no start: it must sit exactly on
        // that instant, never at the midnight that opens its day.
        const milestone = start === null && due !== null && !dueAllDay
        const begin = start ?? (milestone ? due : midnight(due))
        let finish
        if (due === null) {
          finish = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
        } else if (dueAllDay) {
          finish = new Date(due.getFullYear(), due.getMonth(), due.getDate() + 1)
        } else {
          finish = due
        }
        const left = ratio(begin)
        const right = ratio(finish)
        const width = Math.max(right - left, 0)
        // Same fraction the calendar blocks paint, so both views agree.
        const elapsed = taskProgress(task, now)
        return {
          task,
          done,
          milestone,
          allDay: startAllDay || dueAllDay,
          severity: taskTone(task),
          left,
          width,
          progress: done ? 1 : elapsed,
          offscreen: right < 0 || left > 1,
        }
      })
    }

    /**
     * Header counters, derived from the task list.
     *
     * "In progress" is a fact about the clock — the window has opened and the
     * deadline has not passed — not an extra status someone has to remember to
     * set. Mirrors `summarize` in the host so both faces agree.
     * @param tasks - projected tasks.
     * @param now - reference moment.
     * @returns `{ total, today, doing, overdue, done, upcoming }`.
     */
    function liveStats(tasks, now = new Date()) {
      const todayKey = dayKey(now)
      const nowKey = `${dayKey(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`
      const stats = { total: tasks.length, today: 0, doing: 0, overdue: 0, done: 0, upcoming: 0 }
      for (const task of tasks) {
        if (task.status === 'done') { stats.done += 1; continue }
        const start = task.start === null || task.start === undefined ? null : String(task.start)
        const due = task.due === null || task.due === undefined ? null : String(task.due)
        const overdue = due !== null && due < nowKey
        if (overdue) stats.overdue += 1
        if (due !== null && due.slice(0, 10) === todayKey) stats.today += 1
        // Started and not past its deadline. A task with no start time can only
        // be running once its own day has arrived.
        const startedBy = start !== null
          ? start <= nowKey
          : (due !== null && due.slice(0, 10) <= todayKey)
        if (startedBy && !overdue) stats.doing += 1
        const phase = task.project?.phase
        if (phase === 'upcoming' || phase === 'tomorrow') stats.upcoming += 1
      }
      return stats
    }

    /**
     * How much of a task's own window has already elapsed, as a 0..1 fraction.
     *
     * The calendar blocks and the gantt bars both paint this as a solid overlay
     * on a pale track, so the two views read the same way and must agree; this
     * is the single place the number is derived.
     * @param task - projected task.
     * @param now - reference moment.
     * @returns 0 for work that has not started, 1 once the window has passed.
     */
    function taskProgress(task, now = new Date()) {
      if (task.status === 'done') return 1
      const start = parseMoment(task.start)
      const due = parseMoment(task.due)
      if (start !== null && due !== null) {
        if (due.getTime() <= start.getTime()) return now.getTime() >= due.getTime() ? 1 : 0
        return Math.max(0, Math.min(1, (now.getTime() - start.getTime()) / (due.getTime() - start.getTime())))
      }
      if (due !== null) return now.getTime() >= due.getTime() ? 1 : 0
      if (start !== null) return now.getTime() >= start.getTime() ? 1 : 0
      return 0
    }

    /**
     * Everything a hover card says about one task block.
     *
     * The blocks themselves (calendar bars, gantt bars) stay pure colour — a
     * label squeezed into a small box is unreadable and clips on narrow bars —
     * so all the detail lives here and is shown on hover instead. The flags are
     * derived from the task, so the calendar and the gantt board can share it.
     * @param task - projected task.
     * @returns `{ title, tone, countdown, facts, notes }`.
     */
    function ganttCard(task) {
      const facts = []
      facts.push({ label: '状态', value: STATUS_LABELS[task.status] ?? task.status })
      if (task.start !== null && task.start !== undefined) facts.push({ label: '开始', value: task.start })
      if (task.due !== null && task.due !== undefined) facts.push({ label: '截止', value: task.due })
      const allDay = timeOf(task.start) === null && timeOf(task.due) === null
      const milestone = (task.start === null || task.start === undefined)
        && task.due !== null && task.due !== undefined && timeOf(task.due) !== null
      if (milestone) facts.push({ label: '类型', value: '只有截止时刻' })
      else if (allDay) facts.push({ label: '类型', value: '全天' })
      const startMoment = parseMoment(task.start)
      const dueMoment = parseMoment(task.due)
      if (startMoment !== null && dueMoment !== null && dueMoment > startMoment) {
        const minutes = Math.round((dueMoment.getTime() - startMoment.getTime()) / 60_000)
        const days = Math.floor(minutes / 1440)
        const hours = Math.floor((minutes % 1440) / 60)
        const rest = minutes % 60
        const parts = []
        if (days > 0) parts.push(`${days} 天`)
        if (hours > 0) parts.push(`${hours} 小时`)
        if (rest > 0 && days === 0) parts.push(`${rest} 分钟`)
        facts.push({ label: '时长', value: parts.join(' ') || `${minutes} 分钟` })
      }
      if (task.owner !== '') facts.push({ label: '负责', value: task.owner })
      if (task.priority === 'high') facts.push({ label: '优先级', value: '高' })
      if (task.source !== null && task.source !== undefined && task.source.title !== '') {
        facts.push({ label: '来源', value: [task.source.title, task.source.date].filter((part) => part !== '').join(' · ') })
      }
      if (Array.isArray(task.tags) && task.tags.length > 0) facts.push({ label: '标签', value: task.tags.join(' ') })
      return {
        title: task.title,
        tone: taskTone(task),
        countdown: task.project?.text ?? '',
        facts,
        notes: typeof task.notes === 'string' ? task.notes : '',
      }
    }

    /**
     * Where to put the floating card so it stays inside the panel and away from
     * the pointer.
     * @param box - the panel's bounding rect.
     * @param point - pointer position in viewport coordinates.
     * @returns panel-relative `{ x, y }`.
     */
    function placeCard(box, point, width = CARD_WIDTH_PX, height = CARD_HEIGHT_PX) {
      const localX = point.clientX - box.left
      const localY = point.clientY - box.top
      return {
        x: Math.max(4, Math.min(localX + 14, Math.max(4, box.width - width - 4))),
        y: Math.max(4, Math.min(localY + 14, Math.max(4, box.height - height - 4))),
      }
    }

    /**
     * The floating detail card shared by the calendar and the gantt board: both
     * draw tasks as unlabelled colour blocks, so this is where a hovered block
     * explains itself.
     * @param props.hover - `{ task, x, y }`, or null when nothing is hovered.
     */
    function TaskHoverCard(props) {
      const hover = props.hover
      if (hover === null || hover === undefined) return null
      const card = ganttCard(hover.task)
      return h(
        'div',
        { className: 'dsc-hover-card', style: { left: `${hover.x}px`, top: `${hover.y}px` } },
        h(
          'div',
          { className: 'dsc-hover-card-head' },
          h('span', { className: `dsc-badge dsc-badge--${card.tone}` }, card.countdown === '' ? '任务' : card.countdown),
          h('span', { className: 'dsc-hover-card-title' }, card.title),
        ),
        ...card.facts.map((fact) => h(
          'div',
          { className: 'dsc-hover-card-row', key: fact.label },
          h('span', { className: 'dsc-hover-card-label' }, fact.label),
          h('span', { className: 'dsc-hover-card-value' }, fact.value),
        )),
        card.notes === '' ? null : h('div', { className: 'dsc-hover-card-notes' }, card.notes),
        h('div', { className: 'dsc-hover-card-hint' }, '单击可编辑'),
      )
    }

    // ──────────────────────────── components ────────────────────────────

    /** Sidebar glyph with an overdue/today badge. */
    function CalendarGlyph(props) {
      const size = props?.size ?? 18
      const active = props?.active === true
      const state = useSnapshot()
      const stats = state.data?.stats
      const count = (stats?.overdue ?? 0) + (stats?.today ?? 0)
      const glyph = h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('rect', {
          x: 1.75, y: 2.75, width: 12.5, height: 11.5, rx: 2,
          stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3,
        }),
        h('path', {
          d: 'M1.75 6.25h12.5', stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3,
        }),
        h('path', {
          d: 'M5 1.5v2.5M11 1.5v2.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      )
      if (count === 0) return glyph
      return h(
        'span',
        { className: 'dsc-icon-badge' },
        glyph,
        h('span', { className: 'dsc-icon-dot' }, count > 99 ? '99+' : String(count)),
      )
    }

    /** Small labelled form field. */
    function Field(props) {
      return h(
        'div',
        { className: 'dsc-field' },
        h('label', null, props.label),
        props.children,
      )
    }

    function TextInput(props) {
      return h('input', {
        className: 'dsc-input',
        value: props.value ?? '',
        placeholder: props.placeholder ?? '',
        onChange: (event) => { props.onChange(event.target.value) },
        type: props.type ?? 'text',
      })
    }

    function TextArea(props) {
      return h('textarea', {
        className: 'dsc-input',
        rows: props.rows ?? 3,
        value: props.value ?? '',
        placeholder: props.placeholder ?? '',
        onChange: (event) => { props.onChange(event.target.value) },
      })
    }

    function Select(props) {
      return h(
        'select',
        {
          className: 'dsc-input',
          value: props.value,
          onChange: (event) => { props.onChange(event.target.value) },
        },
        props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    /** Create/edit dialog for one task. */
    function TaskEditor(props) {
      const task = props.task
      const [form, setForm] = useState(() => ({
        title: task?.title ?? '',
        start: task?.start ?? '',
        due: task?.due ?? '',
        priority: task?.priority ?? 'normal',
        status: task?.status ?? 'todo',
        owner: task?.owner ?? '',
        notes: task?.notes ?? '',
        tags: (task?.tags ?? []).join(' '),
      }))
      const [saving, setSaving] = useState(false)
      const update = (key) => (value) => { setForm((previous) => ({ ...previous, [key]: value })) }
      const submit = async () => {
        if (form.title.trim() === '') { commit({ error: '任务标题不能为空' }); return }
        const payload = {
          title: form.title.trim(),
          start: form.start.trim(),
          due: form.due.trim(),
          priority: form.priority,
          status: form.status,
          owner: form.owner.trim(),
          notes: form.notes,
          tags: splitTags(form.tags),
        }
        setSaving(true)
        const ok = await props.onSubmit(payload)
        setSaving(false)
        if (ok !== false) props.onClose()
      }
      return h(
        primitives.Modal,
        {
          open: true,
          onClose: props.onClose,
          closeLabel: '关闭',
          title: task === null ? '新建任务' : '编辑任务',
          footer: h(
            'div',
            { className: 'dsc-actions' },
            h(primitives.Button, { variant: 'outline', size: 'sm', onClick: props.onClose }, '取消'),
            h(primitives.Button, { variant: 'primary', size: 'sm', onClick: submit, disabled: saving }, saving ? '保存中…' : '保存'),
          ),
        },
        h(Field, { label: '任务' }, h(TextInput, { value: form.title, onChange: update('title'), placeholder: '例如：完成 Q4 预算初稿' })),
        h(
          'div',
          { className: 'dsc-row' },
          h(Field, { label: '开始时间（可选，用于开始提醒）' }, h(TextInput, { value: form.start, onChange: update('start'), placeholder: '2026-10-12 14:00' })),
          h(Field, { label: '截止时间（可选，用于逾期提醒）' }, h(TextInput, { value: form.due, onChange: update('due'), placeholder: '2026-10-15 18:00' })),
        ),
        h(
          'div',
          { className: 'dsc-row' },
          h(Field, { label: '状态' }, h(Select, {
            value: form.status,
            onChange: update('status'),
            options: Object.keys(STATUS_LABELS).map((value) => ({ value, label: STATUS_LABELS[value] })),
          })),
          h(Field, { label: '优先级' }, h(Select, {
            value: form.priority,
            onChange: update('priority'),
            options: Object.keys(PRIORITY_LABELS).map((value) => ({ value, label: `${PRIORITY_LABELS[value]}（${value}）` })),
          })),
        ),
        h(
          'div',
          { className: 'dsc-row' },
          h(Field, { label: '负责人（可选）' }, h(TextInput, { value: form.owner, onChange: update('owner'), placeholder: '张三' })),
          h(Field, { label: '标签（空格或逗号分隔）' }, h(TextInput, { value: form.tags, onChange: update('tags'), placeholder: '预算 财务' })),
        ),
        h(Field, { label: '备注（可选）' }, h(TextArea, { value: form.notes, onChange: update('notes'), placeholder: '验收标准、上下文、相关链接…' })),
      )
    }

    /** Reminder policy dialog. */
    function ConfigEditor(props) {
      const config = props.config
      const [form, setForm] = useState(() => ({
        leadDays: (config.leadDays ?? []).join(' '),
        leadHours: (config.leadHours ?? []).join(' '),
        startLeadMinutes: String(config.startLeadMinutes ?? 30),
        overdueDailyHour: String(config.overdueDailyHour ?? 9),
        maxAlerts: String(config.maxAlerts ?? 6),
        systemNotify: config.systemNotify !== false,
      }))
      const update = (key) => (value) => { setForm((previous) => ({ ...previous, [key]: value })) }
      const submit = async () => {
        const numbers = (text) => splitTags(text).map(Number).filter((value) => Number.isFinite(value))
        const ok = await props.onSubmit({
          leadDays: numbers(form.leadDays),
          leadHours: numbers(form.leadHours),
          startLeadMinutes: Number(form.startLeadMinutes) || 0,
          overdueDailyHour: Number(form.overdueDailyHour) || 0,
          maxAlerts: Number(form.maxAlerts) || 6,
          systemNotify: form.systemNotify,
        })
        if (ok !== false) props.onClose()
      }
      return h(
        primitives.Modal,
        {
          open: true,
          onClose: props.onClose,
          closeLabel: '关闭',
          title: '提醒设置',
          footer: h(
            'div',
            { className: 'dsc-actions' },
            h(primitives.Button, { variant: 'outline', size: 'sm', onClick: props.onClose }, '取消'),
            h(primitives.Button, { variant: 'primary', size: 'sm', onClick: submit }, '保存'),
          ),
        },
        h(Field, { label: '到期前多少天提醒（空格分隔，如 3 1）' }, h(TextInput, { value: form.leadDays, onChange: update('leadDays') })),
        h(Field, { label: '到期前多少小时提醒（空格分隔，如 2）' }, h(TextInput, { value: form.leadHours, onChange: update('leadHours') })),
        h(
          'div',
          { className: 'dsc-row' },
          h(Field, { label: '开始前多少分钟提醒' }, h(TextInput, { value: form.startLeadMinutes, onChange: update('startLeadMinutes') })),
          h(Field, { label: '逾期后每天几点提醒' }, h(TextInput, { value: form.overdueDailyHour, onChange: update('overdueDailyHour') })),
        ),
        h(Field, { label: '一次最多弹出几条提醒' }, h(TextInput, { value: form.maxAlerts, onChange: update('maxAlerts') })),
        h(
          'label',
          { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
          h('input', {
            type: 'checkbox',
            checked: form.systemNotify,
            onChange: async (event) => {
              const next = event.target.checked
              update('systemNotify')(next)
              if (next) {
                const result = await ensureNotificationPermission()
                if (result === 'denied') commit({ error: '浏览器已拒绝通知权限，请在系统/浏览器设置里允许后重试' })
              }
            },
          }),
          '同时发送系统通知（需要授权）',
        ),
      )
    }

    /** One task row in the day detail list. */
    function TaskCard(props) {
      const task = props.task
      const project = task.project ?? { severity: 'idle', text: '' }
      const tone = taskTone(task)
      const toggle = () => {
        props.onPatch(task.id, { status: task.status === 'done' ? 'todo' : 'done' })
      }
      const meta = []
      if (task.start !== null && task.start !== undefined) meta.push(`开始 ${task.start}`)
      if (task.due !== null && task.due !== undefined) meta.push(`截止 ${task.due}`)
      if (task.owner !== '') meta.push(`@${task.owner}`)
      // A multi-day task shows up on every day it covers; name the position so
      // "第 2/3 天" is not mistaken for a duplicate.
      const range = taskDayRange(task)
      const spanDays = range === null ? 0 : Math.round((parseDay(range.to) - parseDay(range.from)) / 86_400_000) + 1
      const dayIndex = range === null ? 0 : Math.round((parseDay(props.day ?? range.from) - parseDay(range.from)) / 86_400_000) + 1
      return h(
        'div',
        { className: `dsc-card dsc-card--${tone}${task.status === 'done' ? ' dsc-card--done' : ''}` },
        h('div', { className: 'dsc-card-title' }, task.title),
        h(
          'div',
          { className: 'dsc-meta' },
          h('span', { className: `dsc-badge dsc-badge--${tone}` }, project.text),
          h('span', { className: `dsc-badge dsc-badge--${task.status === 'done' ? 'success' : 'idle'}` }, STATUS_LABELS[task.status] ?? task.status),
          task.priority === 'high' ? h('span', { className: 'dsc-badge dsc-badge--warn' }, '高优先') : null,
          spanDays > 1 ? h('span', { className: 'dsc-badge dsc-badge--info' }, `跨天 ${dayIndex}/${spanDays}`) : null,
          ...meta.map((entry) => h('span', { key: entry }, entry)),
        ),
        task.source !== null && task.source !== undefined && (task.source.title !== '' || task.source.date !== '')
          ? h('div', { className: 'dsc-note' }, `来源：${[task.source.title, task.source.date].filter((part) => part !== '').join(' · ')}`)
          : null,
        task.notes !== '' ? h('div', { className: 'dsc-note' }, task.notes) : null,
        h(
          'div',
          { className: 'dsc-actions' },
          h('button', { type: 'button', className: 'dsc-btn', onClick: toggle }, task.status === 'done' ? '↩ 恢复' : '✓ 完成'),
          h('button', { type: 'button', className: 'dsc-btn', onClick: () => { props.onEdit(task) } }, '编辑'),
          h('button', {
            type: 'button',
            className: 'dsc-btn dsc-btn--danger',
            onClick: () => {
              if (window.confirm(`删除「${task.title}」？`)) props.onDelete(task.id)
            },
          }, '删除'),
        ),
      )
    }

    /**
     * The gantt board under the month grid: one row per scheduled task, a
     * horizontal bar per task, a filled portion for the elapsed part of the
     * span, and a "today" line across the whole chart.
     */
    function GanttChart(props) {
      const tasks = props.tasks ?? []
      const todayKey = props.todayKey
      const preset = props.preset
      const now = new Date()
      const axis = ganttAxis(tasks, todayKey, preset, props.anchorDay)
      const allRows = ganttRows(tasks, axis, now)
      const rows = allRows.filter((row) => !row.offscreen)
      const hiddenCount = allRows.length - rows.length
      const trackWidth = axis.days * axis.pxPerDay
      const bodyRef = useRef(null)
      const rootRef = useRef(null)
      // The hover card is anchored to the panel, not the scrolling body, so it
      // is never clipped by the timeline's own overflow.
      const [hover, setHover] = useState(null)

      const showCard = (task, event) => {
        const root = rootRef.current
        if (root === null) return
        const spot = placeCard(root.getBoundingClientRect(), event)
        setHover({ task, x: spot.x, y: spot.y })
      }
      const hideCard = () => { setHover(null) }

      // The marker is the current instant, so the single-day window shows a
      // minute-accurate "now" and the coarse windows mark where we are today.
      const nowLeft = ((now.getTime() - axis.start.getTime()) / DAY_MS) * axis.pxPerDay
      const nowVisible = nowLeft >= 0 && nowLeft <= trackWidth
      const isDayView = axis.granularity === 'hour'

      // Bring the marker into view whenever the window changes.
      useEffect(() => {
        const element = bodyRef.current
        if (element === null || !nowVisible) return
        element.scrollLeft = Math.max(0, nowLeft - element.clientWidth / 2 + GANTT_NAME_PX / 2)
      }, [preset, todayKey, props.anchorDay, rows.length, nowVisible, nowLeft])

      const ticks = []
      if (isDayView) {
        for (let hour = 0; hour < 24; hour += 1) {
          const isNowHour = hour === now.getHours() && dayKey(axis.start) === todayKey
          ticks.push(h(
            'div',
            {
              key: `h${hour}`,
              className: `dsc-gantt-tick${isNowHour ? ' dsc-gantt-tick--today' : ''}`,
              style: { width: `${GANTT_HOUR_PX}px` },
            },
            `${pad(hour)}:00`,
          ))
        }
      } else {
        for (let index = 0; index < axis.days; index += 1) {
          const date = new Date(axis.start.getFullYear(), axis.start.getMonth(), axis.start.getDate() + index)
          const key = dayKey(date)
          const weekend = date.getDay() === 0 || date.getDay() === 6
          ticks.push(h(
            'div',
            {
              key,
              className: `dsc-gantt-tick${weekend ? ' dsc-gantt-tick--weekend' : ''}${key === todayKey ? ' dsc-gantt-tick--today' : ''}`,
              style: { width: `${GANTT_DAY_PX}px` },
              title: `${key} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]}`,
            },
            `${date.getDate()}`,
            h('br', null),
            WEEKDAY_LABELS[(date.getDay() + 6) % 7],
          ))
        }
      }

      return h(
        'div',
        { className: 'dsc-gantt', ref: rootRef },
        h(
          'div',
          { className: 'dsc-gantt-head' },
          h('span', { className: 'dsc-gantt-title' }, '甘特图 · 任务进度'),
          ...GANTT_PRESETS.map((entry) => h(
            'button',
            {
              key: entry.id,
              type: 'button',
              className: `dsc-btn${preset === entry.id ? ' dsc-btn--primary' : ''}`,
              onClick: () => { props.onPreset(entry.id) },
            },
            entry.label,
          )),
          isDayView
            ? h(
              'span',
              { className: 'dsc-gantt-nav' },
              h('button', {
                type: 'button',
                className: 'dsc-btn',
                title: '前一天',
                onClick: () => { props.onAnchorDay(shiftDay(dayKey(axis.start), -1)) },
              }, '‹'),
              h('span', { className: 'dsc-gantt-navday' }, `${dayKey(axis.start)} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][axis.start.getDay()]}`),
              h('button', {
                type: 'button',
                className: 'dsc-btn',
                title: '后一天',
                onClick: () => { props.onAnchorDay(shiftDay(dayKey(axis.start), 1)) },
              }, '›'),
              dayKey(axis.start) === todayKey
                ? null
                : h('button', {
                  type: 'button',
                  className: 'dsc-btn',
                  onClick: () => { props.onAnchorDay(todayKey) },
                }, '今天'),
            )
            : null,
          h('span', { className: 'dsc-spacer' }),
          h(
            'span',
            { className: 'dsc-gantt-legend' },
            isDayView
              ? `${rows.length} 条任务 · 精确到分钟 · 竖线=现在${hiddenCount > 0 ? ` · 另有 ${hiddenCount} 条不在本日` : ''}`
              : `${rows.length} 条排期任务 · 竖线=现在 · 实色=已过时间${hiddenCount > 0 ? ` · 另有 ${hiddenCount} 条不在当前范围` : ''}`,
          ),
          h('button', {
            type: 'button',
            className: 'dsc-btn',
            onClick: () => { props.onToggle() },
          }, props.collapsed ? '展开' : '收起'),
        ),
        props.collapsed
          ? null
          : h(
            'div',
            { className: 'dsc-gantt-body', ref: bodyRef },
            rows.length === 0
              ? h('div', { className: 'dsc-gantt-empty' },
                isDayView
                  ? '这一天没有排期任务。给任务加上开始/截止时间（可精确到分钟，如 14:30），这里就会画出时间条。'
                  : '还没有带时间的任务。给任务加上开始/截止时间，这里就会画出进度条。')
              : h(
                'div',
                { className: 'dsc-gantt-inner' },
                h(
                  'div',
                  { className: 'dsc-gantt-axis' },
                  h('div', { className: 'dsc-gantt-axisname' }, isDayView ? `${dayKey(axis.start)} 时间轴` : '任务'),
                  h('div', { className: 'dsc-gantt-ticks' }, ...ticks),
                ),
                ...rows.map((row) => {
                  const task = row.task
                  // Clamp the drawn bar to the window so a span crossing midnight
                  // reads as "continues off this edge" instead of an oversized box.
                  const startRatio = Math.max(0, Math.min(1, row.left))
                  const endRatio = Math.max(startRatio, Math.min(1, row.left + row.width))
                  const left = startRatio * trackWidth
                  const drawnWidth = (endRatio - startRatio) * trackWidth
                  const width = Math.max(drawnWidth, row.milestone ? 0 : 4)
                  const spillsLeft = row.left < 0
                  const spillsRight = row.left + row.width > 1
                  const barClass = `dsc-gantt-bar dsc-gantt-bar--${row.severity}${row.done ? ' dsc-gantt-bar--done' : ''}${row.milestone ? ' dsc-gantt-bar--milestone' : ''}${row.allDay ? ' dsc-gantt-bar--allday' : ''}`
                  // The bar labels itself when it is wide enough to hold the
                  // text; a narrow bar shows the hover card instead.
                  const startClock = timeOf(task.start)
                  const dueClock = timeOf(task.due)
                  const startMoment = parseMoment(task.start)
                  const dueMoment = parseMoment(task.due)
                  let span
                  if (startClock !== null && dueClock !== null) {
                    const sameDay = startMoment !== null && dueMoment !== null && dayKey(startMoment) === dayKey(dueMoment)
                    span = sameDay ? `${startClock}–${dueClock}` : `${startClock} → 次日 ${dueClock}`
                  } else if (startClock !== null) span = `${startClock} 起`
                  else if (dueClock !== null) span = `截止 ${dueClock}`
                  else span = '全天'
                  if (spillsLeft) span = `← ${span}`
                  if (spillsRight && !span.includes('次日')) span = `${span} →`
                  const tip = [...new Set([
                    task.title,
                    span,
                    task.status === 'done' ? '已完成' : '',
                    task.project?.text ?? '',
                    task.owner !== '' ? `负责 ${task.owner}` : '',
                  ])].filter((part) => part !== '').join(' · ')
                  return h(
                    'div',
                    { className: 'dsc-gantt-row', key: task.id },
                    h('div', {
                      className: `dsc-gantt-name dsc-gantt-name--click${row.done ? ' dsc-gantt-name--done' : ''}`,
                      title: tip,
                      onClick: () => { props.onEdit(task) },
                    }, task.title),
                    h(
                      'div',
                      {
                        className: 'dsc-gantt-track',
                        style: { width: `${trackWidth}px`, '--dsc-gridw': `${axis.pxPerGrid}px` },
                      },
                      nowVisible
                        ? h('div', { className: 'dsc-gantt-now', style: { left: `${nowLeft}px` }, title: `现在 ${pad(now.getHours())}:${pad(now.getMinutes())}` })
                        : null,
                      h(
                        'div',
                        {
                          className: barClass,
                          style: row.milestone
                            // A 12px diamond centred on the deadline instant.
                            ? { left: `${Math.max(0, left - 6)}px`, width: '12px' }
                            : { left: `${left}px`, width: `${width}px` },
                          'aria-label': tip,
                          onClick: () => { props.onEdit(task) },
                          onMouseEnter: (event) => { showCard(task, event) },
                          onMouseLeave: hideCard,
                        },
                        row.milestone
                          ? null
                          : h('div', {
                            className: `dsc-gantt-fill dsc-gantt-fill--${row.severity}`,
                            style: { width: `${Math.round(row.progress * 100)}%` },
                          }),
                        !row.milestone && width > (isDayView ? 62 : 78)
                          ? h('span', { className: 'dsc-gantt-label' }, isDayView ? span : (task.project?.text ?? ''))
                          : null,
                      ),
                    ),
                  )
                }),
              ),
          ),
        h(TaskHoverCard, { hover }),
      )
    }

    /** The whole calendar main panel. */
    function CalendarPanel() {
      const state = useSnapshot()
      const data = state.data
      const today = data?.today ?? dayKey(new Date())
      const [cursor, setCursor] = useState(() => {
        const now = new Date()
        return { year: now.getFullYear(), month: now.getMonth() }
      })
      const [selected, setSelected] = useState(today)
      const [editing, setEditing] = useState(null)
      const [configOpen, setConfigOpen] = useState(false)
      const [ganttPreset, setGanttPreset] = useState('fortnight')
      const [ganttHeight, setGanttHeight] = useState(236)
      const [ganttCollapsed, setGanttCollapsed] = useState(false)
      const initialised = useRef(false)

      useEffect(() => {
        ensureStyle()
        void refresh()
        // The plugin-level poll in `apply` owns the steady cadence; the panel
        // only needs an immediate read and a refresh whenever it regains focus.
        const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
        window.addEventListener('focus', onVisible)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.removeEventListener('focus', onVisible)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      useEffect(() => {
        if (initialised.current || data === null) return
        initialised.current = true
        setSelected(data.today)
      }, [data])

      const tasks = data?.tasks ?? []
      // One clock reading for every block painted this pass, so the fills agree.
      const nowForCards = new Date()
      // Every day a task covers, so the right-hand list shows a multi-day task
      // on each of its days — not just the day it starts.
      const tasksByDay = useMemo(() => {
        const map = new Map()
        for (const task of tasks) {
          const range = taskDayRange(task)
          if (range === null) continue
          let day = range.from
          // Guard against a runaway loop if a document ever holds absurd dates.
          for (let step = 0; step < 400; step += 1) {
            const list = map.get(day) ?? []
            list.push(task)
            map.set(day, list)
            if (day >= range.to) break
            day = shiftDay(day, 1)
          }
        }
        return map
      }, [tasks])

      const selectedTasks = tasksByDay.get(selected) ?? []
      const unscheduled = tasks.filter((task) => taskDayRange(task) === null && task.status !== 'done')
      // Computed here rather than trusted from /state, so the header is correct
      // even before the host process is restarted with the same rule.
      const stats = liveStats(tasks, nowForCards)
      const alerts = data?.alerts ?? []

      const openCreate = () => { setEditing({ task: null, day: selected }) }
      const submitEditor = async (payload) => {
        const fallbackDay = editing?.day ?? selected
        if (editing.task === null) {
          // A task created from the calendar lands on that day when the user
          // named no date; `due` (not `start`) keeps the countdown meaningful.
          const due = payload.due !== '' ? payload.due : (payload.start === '' ? fallbackDay : '')
          return mutate('/tasks', { method: 'POST', body: { ...payload, due } })
        }
        return mutate(`/tasks/${encodeURIComponent(editing.task.id)}`, { method: 'PATCH', body: payload })
      }

      const gotoMonth = (delta) => {
        setCursor((previous) => {
          const date = new Date(previous.year, previous.month + delta, 1)
          return { year: date.getFullYear(), month: date.getMonth() }
        })
      }

      const cells = useMemo(() => monthMatrix(cursor.year, cursor.month), [cursor.year, cursor.month])
      // Six Monday-first week rows; each row lays its own spanning bands out.
      const weeks = useMemo(() => {
        const rows = []
        for (let index = 0; index < cells.length; index += 7) rows.push(cells.slice(index, index + 7))
        return rows
      }, [cells])

      // Measure a real week row so the cell content is sized to what is
      // actually on screen: a fixed chip count would be clipped on a short
      // window (the text would be cut through the middle of the glyphs).
      const gridRef = useRef(null)
      const calRef = useRef(null)
      // The month's task blocks stay unlabelled colour (a title in a small cell
      // is unreadable), so hovering one shows the shared detail card.
      const [hover, setHover] = useState(null)
      const showCard = useCallback((task, event) => {
        const root = calRef.current
        if (root === null) return
        const spot = placeCard(root.getBoundingClientRect(), event)
        setHover({ task, x: spot.x, y: spot.y })
      }, [])
      const hideCard = useCallback(() => { setHover(null) }, [])
      const [rowHeight, setRowHeight] = useState(80)
      useEffect(() => {
        const element = gridRef.current
        if (element === null || typeof ResizeObserver === 'undefined') return undefined
        const measure = () => {
          const first = element.firstElementChild
          if (first === null) return
          const height = first.getBoundingClientRect().height
          if (height > 0) setRowHeight(height)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => { observer.disconnect() }
      }, [])

      // Drag the divider between the month grid and the gantt board. The
      // listeners live on `window` so a fast drag stays smooth past the 6px
      // handle, and are removed on mouseup.
      const startResize = useCallback((event) => {
        event.preventDefault()
        const origin = { y: event.clientY, height: ganttHeight }
        const onMove = (moveEvent) => {
          const next = origin.height - (moveEvent.clientY - origin.y)
          setGanttHeight(Math.max(120, Math.min(620, next)))
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }, [ganttHeight])

      const openTask = useCallback((task) => {
        setEditing({ task, day: task.day ?? selected })
      }, [selected])

      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'div',
          { className: 'dsc-head' },
          h('span', { className: 'dsc-title' }, '任务日历'),
          data !== null ? h('span', { className: 'dsc-clock' }, data.clock) : null,
          h(
            'div',
            { className: 'dsc-stats' },
            h('span', { className: 'dsc-stat' }, '共 ', h('b', null, String(stats.total))),
            h('span', { className: `dsc-stat${stats.overdue > 0 ? ' dsc-stat--error' : ''}` }, '逾期 ', h('b', null, String(stats.overdue))),
            h('span', { className: `dsc-stat${stats.today > 0 ? ' dsc-stat--warn' : ''}` }, '今天 ', h('b', null, String(stats.today))),
            h('span', { className: 'dsc-stat' }, '进行中 ', h('b', null, String(stats.doing))),
            h('span', { className: 'dsc-stat' }, '已完成 ', h('b', null, String(stats.done))),
          ),
          h('span', { className: 'dsc-spacer' }),
          h('button', { type: 'button', className: 'dsc-btn', onClick: () => { gotoMonth(-1) } }, '‹'),
          h('button', {
            type: 'button',
            className: 'dsc-btn',
            onClick: () => {
              const now = new Date()
              setCursor({ year: now.getFullYear(), month: now.getMonth() })
              setSelected(dayKey(now))
            },
          }, '今天'),
          h('button', { type: 'button', className: 'dsc-btn', onClick: () => { gotoMonth(1) } }, '›'),
          h('span', { className: 'dsc-clock' }, monthLabel(cursor.year, cursor.month)),
          h('button', { type: 'button', className: 'dsc-btn dsc-btn--primary', onClick: openCreate }, '＋ 新建任务'),
          h('button', { type: 'button', className: 'dsc-btn', onClick: () => { setConfigOpen(true) } }, '提醒设置'),
          h('button', { type: 'button', className: 'dsc-btn', onClick: () => { void refresh() } }, state.busy ? '刷新中…' : '刷新'),
        ),
        state.error !== null ? h('div', { className: 'dsc-error' }, `⚠ ${state.error}`) : null,
        alerts.length > 0
          ? h(
            'div',
            { className: `dsc-banner${alerts.some((alert) => alert.level === 'error') ? ' dsc-banner--error' : ''}` },
            ...alerts.map((alert) => h(
              'div',
              { className: 'dsc-banner-row', key: alert.key },
              h('span', null, alert.level === 'error' ? '⚠' : '⏰'),
              h('span', { className: 'dsc-banner-text' }, `${alert.text} · ${alert.countdown}`),
              h('button', {
                type: 'button',
                className: 'dsc-btn',
                onClick: () => { void ackKeys([alert.key]) },
              }, '知道了'),
            )),
          )
          : null,
        h(
          'div',
          { className: 'dsc-body' },
          h(
            'div',
            { className: 'dsc-cal', ref: calRef },
            h('div', { className: 'dsc-weekdays' }, ...WEEKDAY_LABELS.map((label) => h('div', { className: 'dsc-weekday', key: label }, label))),
            h(
              'div',
              { className: 'dsc-grid', ref: gridRef },
              ...weeks.map((week) => {
                const dayKeys = week.map((cell) => cell.key)
                // Lay the row out with every lane available, then give the row
                // the height its own content needs (bands + up to a few chip
                // lines). A row that grows keeps ALL of its bands visible; the
                // grid scrolls rather than hiding work.
                const layout = weekLayout(dayKeys, tasks, BAND_MAX_LANES)
                const busiest = Math.max(0, ...[...layout.singles.values()].map((list) => list.length))
                const chipLines = Math.min(busiest, CHIP_LINES_CAP)
                const bandSpace = layout.lanes * BAND_LANE_PX
                const contentBox = CELL_TOP_PX + CELL_BOTTOM_PX + bandSpace
                  + (chipLines > 0 ? chipLines * CHIP_PX + (chipLines - 1) * CHIP_GAP_PX : 0)
                const rowBox = Math.max(ROW_MIN_PX, Math.min(ROW_MAX_PX, contentBox))
                // The row's own box is a floor: when the grid is taller than its
                // content, flex hands the row the extra space and more chips fit.
                const slots = chipSlots(Math.max(rowHeight, rowBox), bandSpace)
                return h(
                  'div',
                  { className: 'dsc-week', key: week[0].key, style: { minHeight: `${rowBox}px` } },
                  // Bands that did not fit this row's lane budget are named
                  // rather than dropped, so a short window never hides work
                  // without saying so.
                  layout.hiddenBands > 0
                    ? h('span', {
                      className: 'dsc-week-more',
                      title: `本行还有 ${layout.hiddenBands} 条跨天任务未显示（行太矮，可拖动分隔条让日历更高）`,
                    }, `+${layout.hiddenBands} 跨天`)
                    : null,
                  // Spanning bands first: the overlay grid shares the cells'
                  // column geometry, so a band's edges land exactly on the days
                  // it covers and reads as one continuous bar.
                  layout.bands.length > 0
                    ? h(
                      'div',
                      {
                        className: 'dsc-band-layer',
                        style: { gridTemplateRows: `repeat(${layout.lanes}, 16px)` },
                      },
                      ...layout.bands.map((band) => h(
                        'button',
                        {
                          key: band.task.id,
                          type: 'button',
                          className: `dsc-band dsc-band--${taskTone(band.task)}${band.roundLeft ? '' : ' dsc-band--open-left'}${band.roundRight ? '' : ' dsc-band--open-right'}`,
                          style: {
                            gridColumn: `${band.col + 1} / span ${band.endCol - band.col + 1}`,
                            gridRow: `${band.lane + 1}`,
                          },
                          'aria-label': `${band.task.title} · ${band.task.start ?? ''} → ${band.task.due ?? ''} · ${band.task.project?.text ?? ''}`,
                          onClick: (event) => {
                            event.stopPropagation()
                            setSelected(band.task.day ?? week[0].key)
                            setEditing({ task: band.task, day: band.task.day ?? week[0].key })
                          },
                          onMouseEnter: (event) => { showCard(band.task, event) },
                          onMouseLeave: hideCard,
                        },
                        // A band spans several days, so its fill shows how far
                        // through the whole span today is.
                        h('span', {
                          className: `dsc-band-fill dsc-band-fill--${taskTone(band.task)}`,
                          style: { width: `${Math.round(taskProgress(band.task, nowForCards) * 100)}%` },
                        }),
                      )),
                    )
                    : null,
                  h(
                    'div',
                    { className: 'dsc-week-cells' },
                    ...week.map((cell) => {
                      const dayTasks = layout.singles.get(cell.key) ?? []
                      // Only as many chips as the measured cell can show; the
                      // rest collapse into "+N" so no glyph is ever sliced.
                      const window = chipWindow(dayTasks.length, slots)
                      const visible = dayTasks.slice(0, window.show)
                      return h(
                        'div',
                        {
                          key: cell.key,
                          className: `dsc-cell${cell.inMonth ? '' : ' dsc-cell--out'}${cell.key === today ? ' dsc-today' : ''}${cell.key === selected ? ' dsc-cell--selected' : ''}`,
                          onClick: () => { setSelected(cell.key) },
                          onDoubleClick: () => { setSelected(cell.key); setEditing({ task: null, day: cell.key }) },
                        },
                        h(
                          'div',
                          { className: 'dsc-cellhead' },
                          h('span', { className: 'dsc-daynum' }, `${cell.date.getMonth() + 1}/${cell.date.getDate()}`),
                          cell.key === today ? h('span', null, '今天') : null,
                        ),
                        h(
                          'div',
                          { className: 'dsc-cellbody', style: bandSpace > 0 ? { marginTop: `${bandSpace}px` } : undefined },
                          ...visible.map((task) => h(
                            'button',
                            {
                              key: task.id,
                              type: 'button',
                              className: `dsc-chip dsc-chip--${taskTone(task)}`,
                              'aria-label': `${timeOf(task.due ?? task.start) !== null ? `${timeOf(task.due ?? task.start)} ` : ''}${task.title} · ${task.project?.text ?? ''}`,
                              onClick: (event) => { event.stopPropagation(); setEditing({ task, day: cell.key }) },
                              onMouseEnter: (event) => { showCard(task, event) },
                              onMouseLeave: hideCard,
                            },
                            // Same paint as a gantt bar: pale track + solid
                            // elapsed portion, just without the title text.
                            h('span', {
                              className: `dsc-chip-fill dsc-chip-fill--${taskTone(task)}`,
                              style: { width: `${Math.round(taskProgress(task, nowForCards) * 100)}%` },
                            }),
                            // The folded backlog rides the chip's own line, so the
                            // counter costs no extra row.
                            window.inline === true && task.id === visible[0]?.id && window.hidden > 0
                              ? h('span', { className: 'dsc-chip-more' }, `+${window.hidden}`)
                              : null,
                          )),
                          window.more
                            ? h('span', { className: 'dsc-more' }, `+${window.hidden}`)
                            : null,
                        ),
                      )
                    }),
                  ),
                )
              }),
            ),
          ),
          h(
            'div',
            { className: 'dsc-side' },
            h(
              'div',
              { className: 'dsc-sidehead' },
              h('span', { className: 'dsc-sidedate' }, humanDay(selected, today)),
              h('span', { className: 'dsc-sidesub' }, `${selectedTasks.length} 项${selectedTasks.length === 0 ? '' : ''}`),
              h('span', { className: 'dsc-spacer' }),
              h('button', {
                type: 'button',
                className: 'dsc-btn',
                onClick: () => { setEditing({ task: null, day: selected }) },
              }, '＋'),
            ),
            h(
              'div',
              { className: 'dsc-list' },
              selectedTasks.length === 0
                ? h('div', { className: 'dsc-empty' }, '这一天没有任务，双击日历格子或点 ＋ 新建。')
                : selectedTasks.map((task) => h(TaskCard, {
                  key: task.id,
                  task,
                  day: selected,
                  onEdit: (target) => { setEditing({ task: target, day: selected }) },
                  onPatch: (id, patch) => { void mutate(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }) },
                  onDelete: (id) => { void mutate(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
                })),
              unscheduled.length > 0
                ? h(
                  'div',
                  null,
                  h('div', { className: 'dsc-sidesub', style: { margin: '10px 0 4px' } }, `未排期（${unscheduled.length}）`),
                  ...unscheduled.map((task) => h(TaskCard, {
                    key: task.id,
                    task,
                    day: selected,
                    onEdit: (target) => { setEditing({ task: target, day: selected }) },
                    onPatch: (id, patch) => { void mutate(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }) },
                    onDelete: (id) => { void mutate(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
                  })),
                )
                : null,
            ),
          ),
        ),
        h('div', {
          className: 'dsc-splitter',
          title: '拖动调整甘特图高度',
          onMouseDown: startResize,
        }),
        h(
          'div',
          {
            // `0 1 <h>px`: the board keeps the height the user dragged to, but
            // yields on a short window instead of pushing the footer out.
            style: ganttCollapsed
              ? { flex: '0 0 auto', display: 'flex', minHeight: 0 }
              : { flex: `0 1 ${ganttHeight}px`, display: 'flex', minHeight: '120px' },
          },
          h(GanttChart, {
            tasks,
            todayKey: today,
            preset: ganttPreset,
            // The day window follows the day selected in the month grid, so
            // clicking a cell and switching to 「一天」 line up without a second
            // cursor to keep in sync.
            anchorDay: selected,
            onAnchorDay: (day) => {
              setSelected(day)
              const date = parseDay(day)
              setCursor({ year: date.getFullYear(), month: date.getMonth() })
            },
            collapsed: ganttCollapsed,
            onPreset: setGanttPreset,
            onToggle: () => { setGanttCollapsed((value) => !value) },
            onEdit: openTask,
          }),
        ),
        h(
          'div',
          { className: 'dsc-foot' },
          data !== null
            ? h('span', null, `提醒：到期前 ${(data.config.leadDays ?? []).join('/')} 天 · 提前 ${data.config.startLeadMinutes} 分钟开始 · 逾期后每天 ${pad(data.config.overdueDailyHour)}:00`)
            : h('span', null, '正在连接日历服务…'),
          h('span', { className: 'dsc-spacer' }),
          data !== null ? h('span', null, `数据文件：${data.storeFile}`) : null,
        ),
        editing !== null ? h(TaskEditor, {
          task: editing.task,
          onClose: () => { setEditing(null) },
          onSubmit: submitEditor,
        }) : null,
        h(TaskHoverCard, { hover }),
        configOpen && data !== null ? h(ConfigEditor, {
          config: data.config,
          onClose: () => { setConfigOpen(false) },
          onSubmit: (patch) => mutate('/config', { method: 'POST', body: patch }),
        }) : null,
      )
    }

    /** Reminder toast stack in the frame-wide overlay. */
    function ReminderOverlay() {
      const state = useSnapshot()
      useEffect(() => {
        ensureStyle()
        if (state.toasts.length === 0) return undefined
        const timer = window.setTimeout(() => {
          const oldest = snapshot.toasts[0]
          if (oldest !== undefined) {
            commit({ toasts: snapshot.toasts.filter((toast) => toast.key !== oldest.key) })
          }
        }, TOAST_TTL_MS)
        return () => { window.clearTimeout(timer) }
      }, [state.toasts])
      if (state.toasts.length === 0) return null
      return h(
        'div',
        { className: 'dsc-overlay' },
        ...state.toasts.map((toast) => h(
          'div',
          { className: `dsc-toast dsc-toast--${toast.level ?? 'info'}`, key: toast.key },
          h(
            'div',
            { className: 'dsc-toast-head' },
            h('span', null, toast.level === 'error' ? '⚠' : '⏰'),
            h('span', { className: 'dsc-spacer' }),
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, toast.at ?? ''),
          ),
          h('div', { className: 'dsc-toast-body' }, toast.text),
          h('div', { className: 'dsc-toast-actions' }, h('button', {
            type: 'button',
            className: 'dsc-btn',
            onClick: () => { void ackKeys([toast.key]) },
          }, '知道了')),
        )),
      )
    }

    // ──────────────────────────── plugin body ────────────────────────────

    /** Services the browser half needs. */
    const inject = ['slots']

    /**
     * Register the three seats.
     * @param ctx - client Cordis context.
     */
    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'calendar',
        order: 40,
        label: '任务日历',
      }, CalendarGlyph))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'calendar',
      }, CalendarPanel))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'calendar-reminders',
        order: 25,
        label: '任务提醒',
      }, ReminderOverlay))
      // Start the clock as soon as the plugin loads, so reminders can fire even
      // before the user opens the calendar panel.
      void refresh()
      ctx.effect(() => {
        const timer = window.setInterval(() => { void refresh() }, POLL_MS)
        return () => { window.clearInterval(timer) }
      }, 'task-calendar: reminder poll')
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      monthMatrix, humanDay, splitTags, dayKey, parseDay, ackKeys, refresh,
      parseMoment, ganttAxis, ganttRows, taskTone, ganttCard, placeCard, taskProgress, liveStats,
      taskDayRange, weekLayout, shiftDay, chipSlots, chipWindow,
    }
    return module.exports
  },
})
