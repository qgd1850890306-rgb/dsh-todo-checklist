// v1.3.0 反馈①：分段式提醒时间输入 —— 替换原生 datetime-local（点击哪段 + 就加哪段）
// 需求实证：用户点「日/月」段后点 +，要求日/月变化；原生控件 closed shadow root 无法感知聚焦段（_tmp_shadow_probe2/3 实证），自绘分段。
// 行为规格：
//   - 五段：月(01-12) 日(01-31) 年(4位) 时(00-23) 分(00-59)，点击即选中该段（高亮底色）
//   - ± 按钮：作用在选中段。分±30、时±1、日±1、月±1、年±1，Date 自动进位（1/31→月+1 自动 2/28 等）
//   - 键盘可调：聚焦分段后 ↑/↓ 同 ±；←/→ 移动分段
//   - value 字符串格式 'YYYY-MM-DDTHH:mm'（与原 datetime-local 一致，空串=未设置）
//   - 空值时点任何分段或 ± ：用当前时间初始化（保留 v1.1.6 行为）
'use strict'
import { createElement as h, useCallback, useState } from 'react'

const pad2 = (v) => String(v).padStart(2, '0')

/** 'YYYY-MM-DDTHH:mm' → {y,mo,dd,hh,mi}；非法/空返回 null */
function parseDueLocal (s) {
  if (typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const dd = Number(m[3]); const hh = Number(m[4]); const mi = Number(m[5])
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) return null
  const d = new Date(y, mo - 1, dd, hh, mi)
  if (Number.isNaN(d.getTime())) return null
  return { d, y, mo, dd, hh, mi }
}

/** 当前时间的 'YYYY-MM-DDTHH:mm' */
function nowDueLocal () {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const SEG_STEP = { minute: 30, hour: 1, day: 1, month: 1, year: 1 } // 步长（分钟按 30）
const SEG_ORDER = ['year', 'month', 'day', 'hour', 'minute']

/**
 * 分段式提醒时间输入。
 * @param {{ value: string, onChange: (next: string) => void, style?: object, inputStyle?: object }} props
 */
function SegmentDueInput ({ value, onChange, style, inputStyle }) {
  const [activeSeg, setActiveSeg] = useState('day') // 默认选「日」，符合最常用直觉
  const parsed = parseDueLocal(value)
  const valid = parsed !== null
  // 显示值：value 合法用它；否则用「当前时间」（不回写，只在用户操作时才落值）
  const disp = parsed ?? parseDueLocal(nowDueLocal())

  /** 步进：seg 方向 dir。全部经 Date 进位。 */
  const stepSeg = useCallback((seg, dir) => {
    const base = parseDueLocal(value) ?? parseDueLocal(nowDueLocal())
    const d = base.d
    if (seg === 'minute') d.setMinutes(d.getMinutes() + dir * 30)
    else if (seg === 'hour') d.setHours(d.getHours() + dir)
    else if (seg === 'day') d.setDate(d.getDate() + dir)
    else if (seg === 'month') d.setMonth(d.getMonth() + dir)
    else d.setFullYear(d.getFullYear() + dir)
    onChange(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
  }, [value, onChange])

  /** 分段键盘 ↑/↓ */
  const onSegKeyDown = useCallback((seg, e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); stepSeg(seg, +1) } else if (e.key === 'ArrowDown') { e.preventDefault(); stepSeg(seg, -1) } else if (e.key === 'ArrowLeft') { const i = SEG_ORDER.indexOf(seg); if (i > 0) setActiveSeg(SEG_ORDER[i - 1]) } else if (e.key === 'ArrowRight') { const i = SEG_ORDER.indexOf(seg); if (i < SEG_ORDER.length - 1) setActiveSeg(SEG_ORDER[i + 1]) }
  }, [stepSeg])

  const segStyle = (seg) => ({
    padding: '2px 3px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: '20px',
    userSelect: 'none',
    background: activeSeg === seg ? 'rgba(255,170,0,.22)' : 'transparent',
    boxShadow: activeSeg === seg ? '0 1px 0 0 currentColor' : 'none',
  })

  const segBtn = (seg, text) => h('span', {
    key: seg,
    style: segStyle(seg),
    tabIndex: 0,
    role: 'spinbutton',
    'aria-label': seg,
    onMouseDown: (e) => { e.preventDefault(); setActiveSeg(seg) },
    onKeyDown: (e) => onSegKeyDown(seg, e),
  }, text)

  const sep = (t) => h('span', { style: { fontSize: 13, lineHeight: '20px', opacity: 0.65 } }, t)

  return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', ...style } },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0,
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        padding: '6px 8px', boxSizing: 'border-box', ...inputStyle,
      },
    },
      segBtn('year', String(disp.y)),
      sep('-'),
      segBtn('month', pad2(disp.mo)),
      sep('-'),
      segBtn('day', pad2(disp.dd)),
      sep(' '),
      segBtn('hour', pad2(disp.hh)),
      sep(':'),
      segBtn('minute', pad2(disp.mi)),
      valid ? null : h('span', { style: { fontSize: 10, opacity: 0.6, marginLeft: 4 } }, '(未设置)'),
    ),
    h('button', {
      type: 'button', title: `减：${({ year: '年', month: '月', day: '日', hour: '小时', minute: '分钟' })[activeSeg]} −1 步`, 'aria-label': '减少提醒时间',
      onClick: () => stepSeg(activeSeg, -1),
      style: { width: 32, height: 32, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', flexShrink: 0, lineHeight: 1 },
    }, '−'),
    h('button', {
      type: 'button', title: `加：${({ year: '年', month: '月', day: '日', hour: '小时', minute: '分钟' })[activeSeg]} +1 步`, 'aria-label': '增加提醒时间',
      onClick: () => stepSeg(activeSeg, +1),
      style: { width: 32, height: 32, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', flexShrink: 0, lineHeight: 1 },
    }, '+'),
  )
}

export { SegmentDueInput, parseDueLocal, nowDueLocal }
