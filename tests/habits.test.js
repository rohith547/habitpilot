/**
 * tests/habits.test.js
 * Unit tests for pure helper functions in habits.js
 */

// Set env before any require that loads config.js
process.env.TELEGRAM_BOT_TOKEN = 'test-token'

const { getToday, getUserTime, completionLabel, categoryEmoji, extractNumber, buildLogKeyboard, buildHeatmap, buildAllDoneKeyboard } = require('../habits')

// ── getToday ────────────────────────────────────────────────────────────────
describe('getToday', () => {
  it('returns a date string in YYYY-MM-DD format', () => {
    const result = getToday('America/Chicago')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns a valid date', () => {
    const result = getToday('America/New_York')
    const parsed = new Date(result)
    expect(parsed.toString()).not.toBe('Invalid Date')
  })

  it('works with different timezones', () => {
    const chicago = getToday('America/Chicago')
    const kolkata  = getToday('Asia/Kolkata')
    // Both should be valid YYYY-MM-DD strings
    expect(chicago).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(kolkata).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ── getUserTime ─────────────────────────────────────────────────────────────
describe('getUserTime', () => {
  it('returns HH:MM format', () => {
    const result = getUserTime('America/Chicago')
    expect(result).toMatch(/^\d{2}:\d{2}$/)
  })

  it('returns valid hours (00–23)', () => {
    const result = getUserTime('America/New_York')
    const [h] = result.split(':').map(Number)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(23)
  })

  it('returns valid minutes (00–59)', () => {
    const result = getUserTime('Europe/London')
    const [, m] = result.split(':').map(Number)
    expect(m).toBeGreaterThanOrEqual(0)
    expect(m).toBeLessThanOrEqual(59)
  })

  it('is exactly 5 characters', () => {
    expect(getUserTime('Asia/Kolkata')).toHaveLength(5)
  })
})

// ── completionLabel ─────────────────────────────────────────────────────────
describe('completionLabel', () => {
  it('returns ✅ for 100', () => {
    expect(completionLabel(100)).toBe('✅')
  })
  it('returns 🔶 for 50', () => {
    expect(completionLabel(50)).toBe('🔶')
  })
  it('returns 🔸 for 25', () => {
    expect(completionLabel(25)).toBe('🔸')
  })
  it('returns ⬜ for 0', () => {
    expect(completionLabel(0)).toBe('⬜')
  })
  it('returns ⬜ for unknown value', () => {
    expect(completionLabel(75)).toBe('⬜')
  })
})

// ── categoryEmoji ───────────────────────────────────────────────────────────
describe('categoryEmoji', () => {
  it('returns correct emoji for food', () => {
    expect(categoryEmoji('food')).toBe('🥗')
  })
  it('returns correct emoji for supplement', () => {
    expect(categoryEmoji('supplement')).toBe('💊')
  })
  it('returns correct emoji for exercise', () => {
    expect(categoryEmoji('exercise')).toBe('💪')
  })
  it('returns correct emoji for hydration', () => {
    expect(categoryEmoji('hydration')).toBe('💧')
  })
  it('returns correct emoji for recovery', () => {
    expect(categoryEmoji('recovery')).toBe('😴')
  })
  it('returns 📌 fallback for unknown category', () => {
    expect(categoryEmoji('unknown')).toBe('📌')
    expect(categoryEmoji('')).toBe('📌')
    expect(categoryEmoji(null)).toBe('📌')
  })
})

// ── extractNumber ───────────────────────────────────────────────────────────
describe('extractNumber', () => {
  it('extracts integer from "150 reps"', () => {
    expect(extractNumber('150 reps')).toBe(150)
  })
  it('extracts decimal from "3.5L"', () => {
    expect(extractNumber('3.5L')).toBe(3.5)
  })
  it('extracts plain number', () => {
    expect(extractNumber('42')).toBe(42)
  })
  it('returns null for null input', () => {
    expect(extractNumber(null)).toBeNull()
  })
  it('returns null for string with no number', () => {
    expect(extractNumber('reps only')).toBeNull()
  })
  it('extracts first number from "3 sets of 10"', () => {
    expect(extractNumber('3 sets of 10')).toBe(3)
  })
})

// ── buildLogKeyboard ────────────────────────────────────────────────────────
describe('buildLogKeyboard', () => {
  it('returns an inline_keyboard array', () => {
    const kb = buildLogKeyboard(1, '2024-01-01')
    expect(kb).toHaveProperty('inline_keyboard')
    expect(Array.isArray(kb.inline_keyboard)).toBe(true)
  })

  it('has exactly 4 buttons', () => {
    const kb = buildLogKeyboard(1, '2024-01-01')
    expect(kb.inline_keyboard[0]).toHaveLength(4)
  })

  it('encodes habitId and date in callback_data', () => {
    const kb = buildLogKeyboard(7, '2024-03-15')
    const buttons = kb.inline_keyboard[0]
    expect(buttons.every(b => b.callback_data.includes('7') && b.callback_data.includes('2024-03-15'))).toBe(true)
  })

  it('marks current value with dot prefix', () => {
    const kb = buildLogKeyboard(1, '2024-01-01', 100)
    const buttons = kb.inline_keyboard[0]
    const done = buttons.find(b => b.callback_data.includes(':100:'))
    expect(done.text).toContain('·')
  })

  it('callback_data format is log:{habitId}:{value}:{date}', () => {
    const kb = buildLogKeyboard(3, '2024-06-01')
    const buttons = kb.inline_keyboard[0]
    buttons.forEach(b => {
      expect(b.callback_data).toMatch(/^log:\d+:\d+:\d{4}-\d{2}-\d{2}$/)
    })
  })
})

// ── buildHeatmap ─────────────────────────────────────────────────────────────
describe('buildHeatmap', () => {
  it('returns 4 rows for 28 days', () => {
    const rows = buildHeatmap([], 28).split('\n')
    expect(rows).toHaveLength(4)
  })

  it('each row has 7 cells (emojis)', () => {
    const rows = buildHeatmap([], 28).split('\n')
    rows.forEach(row => {
      const emojiCount = [...row].filter(c => c.codePointAt(0) > 0x2000).length
      expect(emojiCount).toBe(7)
    })
  })

  it('shows ⬜ for unlogged days', () => {
    const result = buildHeatmap([], 28)
    expect(result).toContain('⬜')
  })

  it('shows 🟩 for 100% days', () => {
    const today = new Date().toISOString().slice(0, 10)
    const result = buildHeatmap([{ date: today, completion_value: 100 }], 28)
    expect(result).toContain('🟩')
  })

  it('shows 🟨 for 50% days', () => {
    const today = new Date().toISOString().slice(0, 10)
    const result = buildHeatmap([{ date: today, completion_value: 50 }], 28)
    expect(result).toContain('🟨')
  })

  it('shows 🟧 for 25% days', () => {
    const today = new Date().toISOString().slice(0, 10)
    const result = buildHeatmap([{ date: today, completion_value: 25 }], 28)
    expect(result).toContain('🟧')
  })

  it('shows 🟥 for skipped (0) logged days', () => {
    const today = new Date().toISOString().slice(0, 10)
    const result = buildHeatmap([{ date: today, completion_value: 0 }], 28)
    expect(result).toContain('🟥')
  })
})

// ── buildAllDoneKeyboard ─────────────────────────────────────────────────────
describe('buildAllDoneKeyboard', () => {
  it('returns an object with inline_keyboard', () => {
    const kb = buildAllDoneKeyboard('2024-01-01')
    expect(kb).toHaveProperty('inline_keyboard')
  })

  it('has exactly one button', () => {
    const kb = buildAllDoneKeyboard('2024-01-01')
    expect(kb.inline_keyboard[0]).toHaveLength(1)
  })

  it('callback_data starts with alldone:', () => {
    const kb = buildAllDoneKeyboard('2024-06-15')
    expect(kb.inline_keyboard[0][0].callback_data).toBe('alldone:2024-06-15')
  })

  it('button text contains Mark all done', () => {
    const kb = buildAllDoneKeyboard('2024-01-01')
    expect(kb.inline_keyboard[0][0].text).toContain('Mark all done')
  })
})
