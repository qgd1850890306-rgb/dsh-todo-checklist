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

// v1.5.11 反馈③：用户要「时间像日历那样」。分段式只适合微调（±30 分、±1 天），
// 但「下个月 15 号」要连点十几次；原生 datetime-local 又感知不到聚焦段。
// 折中：保留分段做精确微调，另加一个日历面板做「一眼选到某天」，两者读写同一个 value。
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 某年某月的天数（mo 从 1 起） */
function daysInMonth (y, mo) {
  return new Date(y, mo, 0).getDate()
}

/** 某年某月 1 号是周几，周一为 0（中文日历习惯周一起始） */
function firstWeekdayMon (y, mo) {
  return (new Date(y, mo - 1, 1).getDay() + 6) % 7
}

/**
 * 日历选择面板（月视图 + 时分下拉）。
 * 与 SegmentDueInput 共用 'YYYY-MM-DDTHH:mm' 的 value 协议，空串 = 未设置。
 * @param {{ value: string, onChange: (next: string) => void, onClose?: () => void }} props
 */
function CalendarForm ({ value, onChange, onClose }) {
  const today = parseDueLocal(nowDueLocal())
  const sel = parseDueLocal(value)
  // 视图月份：优先跟随已选日期，没选就跟随今天
  const [view, setView] = useState(() => {
    const base = sel ?? today
    return { y: base.y, mo: base.mo }
  })

  const baseTime = sel ?? today

  /** 点某天：只改年月日，时分沿用已选值（没选过就用今天此刻） */
  const pickDay = (dd) => {
    onChange(`${view.y}-${pad2(view.mo)}-${pad2(dd)}T${pad2(baseTime.hh)}:${pad2(baseTime.mi)}`)
  }

  const setPart = (hh, mi) => {
    onChange(`${baseTime.y}-${pad2(baseTime.mo)}-${pad2(baseTime.dd)}T${pad2(hh)}:${pad2(mi)}`)
  }

  const shiftMonth = (delta) => {
    setView((v) => {
      const d = new Date(v.y, v.mo - 1 + delta, 1)
      return { y: d.getFullYear(), mo: d.getMonth() + 1 }
    })
  }

  const goToday = () => {
    setView({ y: today.y, mo: today.mo })
    // 「今天」按钮的直觉是「跳到今天并选中」，小时分钟保留已选
    onChange(`${today.y}-${pad2(today.mo)}-${pad2(today.dd)}T${pad2(baseTime.hh)}:${pad2(baseTime.mi)}`)
  }

  const navBtn = (label, title, onClick) => h('button', {
    type: 'button', title, 'aria-label': title, onClick,
    style: {
      width: 26, height: 26, borderRadius: 6, cursor: 'pointer', fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      lineHeight: 1, padding: 0,
    },
  }, label)

  const cells = []
  const lead = firstWeekdayMon(view.y, view.mo)
  for (let i = 0; i < lead; i += 1) cells.push(h('span', { key: `lead-${i}`, style: { width: 32, height: 28 } }))
  for (let dd = 1; dd <= daysInMonth(view.y, view.mo); dd += 1) {
    const isSel = sel !== null && sel.y === view.y && sel.mo === view.mo && sel.dd === dd
    const isToday = today.y === view.y && today.mo === view.mo && today.dd === dd
    cells.push(h('button', {
      key: `d-${dd}`,
      type: 'button',
      'aria-label': `${view.y}年${view.mo}月${dd}日`,
      'aria-pressed': isSel,
      onClick: () => pickDay(dd),
      style: {
        width: 32, height: 28, borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: 0,
        border: isToday ? '1px dashed var(--dsw-alias-brand-primary, #f59e0b)' : '1px solid transparent',
        background: isSel ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'transparent',
        color: isSel ? '#fff' : 'var(--dsw-alias-label-primary)',
        fontWeight: isSel ? 600 : 400,
      },
    }, String(dd)))
  }

  const timeSelect = (val, from, to, onPick, label) => h('select', {
    value: val,
    'aria-label': label,
    onChange: (e) => onPick(Number(e.target.value)),
    style: {
      padding: '4px 6px', fontSize: 12, borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    },
  }, Array.from({ length: to - from + 1 }, (_, i) => {
    const v = from + i
    return h('option', { key: v, value: v }, pad2(v))
  }))

  return h('div', {
    style: {
      marginTop: 8, padding: 10, borderRadius: 10, width: 268, boxSizing: 'border-box',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2, #f8f8f8)',
      color: 'var(--dsw-alias-label-primary)',
    },
  },
    // 月份导航行
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
      navBtn('‹', '上个月', () => shiftMonth(-1)),
      h('span', { style: { fontSize: 13, fontWeight: 600, minWidth: 90, textAlign: 'center' } }, `${view.y} 年 ${view.mo} 月`),
      navBtn('›', '下个月', () => shiftMonth(+1)),
      h('button', {
        type: 'button', onClick: goToday,
        style: {
          marginLeft: 'auto', padding: '3px 8px', fontSize: 11, borderRadius: 999, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)',
        },
      }, '今天'),
    ),
    // 星期表头
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 32px)', gap: 2, marginBottom: 2 } },
      WEEKDAY_LABELS.map((w) => h('span', {
        key: w,
        style: { fontSize: 10, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '18px' },
      }, w)),
    ),
    // 日期格
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 32px)', gap: 2 } }, cells),
    // 时分 + 清空
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 } },
      timeSelect(baseTime.hh, 0, 23, (hh) => setPart(hh, baseTime.mi), '小时'),
      h('span', { style: { fontSize: 12, opacity: 0.7 } }, ':'),
      timeSelect(baseTime.mi, 0, 59, (mi) => setPart(baseTime.hh, mi), '分钟'),
      h('button', {
        type: 'button',
        title: '清空提醒时间',
        onClick: () => { onChange(''); if (typeof onClose === 'function') onClose() },
        style: {
          marginLeft: 'auto', padding: '3px 8px', fontSize: 11, borderRadius: 999, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-tertiary)',
        },
      }, '清空'),
      onClose === undefined ? null : h('button', {
        type: 'button',
        onClick: onClose,
        style: {
          padding: '3px 8px', fontSize: 11, borderRadius: 999, cursor: 'pointer', border: 'none',
          background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)',
        },
      }, '收起'),
    ),
  )
}

/**
 * 分段式提醒时间输入。
 * @param {{ value: string, onChange: (next: string) => void, style?: object, inputStyle?: object }} props
 */
function SegmentDueInput ({ value, onChange, style, inputStyle }) {
  const [activeSeg, setActiveSeg] = useState('day') // 默认选「日」，符合最常用直觉
  // v1.5.11 反馈③：日历面板开关。默认收起，不抢分段式的默认心智。
  const [calendarOpen, setCalendarOpen] = useState(false)
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

  return h('div', { style: { display: 'flex', flexDirection: 'column', ...style } },
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
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
      // v1.5.11 反馈③：日历开关。图标用「▦」，避免和日期文字混淆。
      h('button', {
        type: 'button',
        title: calendarOpen ? '收起日历' : '用日历选日期',
        'aria-label': '日历',
        'aria-expanded': calendarOpen,
        onClick: () => setCalendarOpen((v) => !v),
        style: {
          width: 32, height: 32, borderRadius: 8, fontSize: 14, cursor: 'pointer', flexShrink: 0,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: calendarOpen ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'var(--dsw-alias-bg-layer-1)',
          color: calendarOpen ? '#fff' : 'var(--dsw-alias-label-primary)',
          lineHeight: 1,
        },
      }, '▦'),
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
    ),
    calendarOpen
      ? h(CalendarForm, {
        value,
        onChange,
        onClose: () => setCalendarOpen(false),
      })
      : null,
  )
}

export { SegmentDueInput, CalendarForm, parseDueLocal, nowDueLocal }
