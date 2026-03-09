/**
 * tests/database.test.js
 * Integration tests for all DB functions using an in-memory SQLite database.
 * Uses a temp DB path so production data is never touched.
 */

const path = require('path')
const os   = require('os')

// Point DB_PATH to a temp file BEFORE requiring database.js
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.DB_PATH = path.join(os.tmpdir(), `habitpilot-test-${Date.now()}.db`)

const db = require('../database')

// Initialize the DB (creates schema, opens file)
db.getDb()

// Helper: create a test user
function makeUser(id = '999', name = 'TestUser') {
  return db.getOrCreateUser(id, name, name).user
}

// ── getOrCreateUser ─────────────────────────────────────────────────────────
describe('getOrCreateUser', () => {
  it('creates a new user', () => {
    const { user, isNew } = db.getOrCreateUser('1001', 'alice', 'Alice')
    expect(isNew).toBe(true)
    expect(user.telegram_id).toBe('1001')
    expect(user.first_name).toBe('Alice')
  })

  it('returns existing user on second call', () => {
    db.getOrCreateUser('1002', 'bob', 'Bob')
    const { isNew } = db.getOrCreateUser('1002', 'bob', 'Bob')
    expect(isNew).toBe(false)
  })

  it('assigns a numeric id', () => {
    const { user } = db.getOrCreateUser('1003', 'carol', 'Carol')
    expect(typeof user.id).toBe('number')
  })
})

// ── getUser ─────────────────────────────────────────────────────────────────
describe('getUser', () => {
  it('returns user by telegram id', () => {
    db.getOrCreateUser('2001', 'dave', 'Dave')
    const user = db.getUser('2001')
    expect(user).toBeDefined()
    expect(user.first_name).toBe('Dave')
  })

  it('returns undefined for unknown id', () => {
    expect(db.getUser('0000000')).toBeUndefined()
  })
})

// ── Notifications ───────────────────────────────────────────────────────────
describe('notifications', () => {
  let user

  beforeEach(() => {
    user = makeUser(String(Date.now()))
    db.setDefaultNotifications(user.id)
  })

  it('setDefaultNotifications creates morning 07:30 and night 21:30', () => {
    const notifs = db.getNotifications(user.id)
    expect(notifs).toHaveLength(2)
    const morning = notifs.find(n => n.notification_type === 'morning')
    const night   = notifs.find(n => n.notification_type === 'night')
    expect(morning.notification_time).toBe('07:30')
    expect(night.notification_time).toBe('21:30')
  })

  // ✅ This test catches the bug we just fixed — morning time not updating
  it('updateNotification updates MORNING time correctly', () => {
    db.updateNotification(user.id, 'morning', '10:00')
    const notifs  = db.getNotifications(user.id)
    const morning = notifs.find(n => n.notification_type === 'morning')
    expect(morning.notification_time).toBe('10:00')
  })

  it('updateNotification updates NIGHT time correctly', () => {
    db.updateNotification(user.id, 'night', '22:00')
    const notifs = db.getNotifications(user.id)
    const night  = notifs.find(n => n.notification_type === 'night')
    expect(night.notification_time).toBe('22:00')
  })

  it('updating morning does not affect night', () => {
    db.updateNotification(user.id, 'morning', '09:00')
    const notifs = db.getNotifications(user.id)
    const night  = notifs.find(n => n.notification_type === 'night')
    expect(night.notification_time).toBe('21:30') // unchanged
  })

  it('updating night does not affect morning', () => {
    db.updateNotification(user.id, 'night', '23:00')
    const notifs  = db.getNotifications(user.id)
    const morning = notifs.find(n => n.notification_type === 'morning')
    expect(morning.notification_time).toBe('07:30') // unchanged
  })

  it('markNotificationSent sets last_sent', () => {
    const notifs = db.getNotifications(user.id)
    db.markNotificationSent(notifs[0].id, '2024-01-01')
    const updated = db.getNotifications(user.id)
    const sent = updated.find(n => n.id === notifs[0].id)
    expect(sent.last_sent).toBe('2024-01-01')
  })
})

// ── Habits ──────────────────────────────────────────────────────────────────
describe('habits', () => {
  let user

  beforeEach(() => {
    user = makeUser(String(Date.now() + Math.random()))
  })

  it('addHabit creates a habit', () => {
    db.addHabit(user.id, 'Water', 'hydration', '3L', true, false)
    const habits = db.getHabits(user.id)
    expect(habits).toHaveLength(1)
    expect(habits[0].habit_name).toBe('Water')
  })

  it('getHabits returns only active habits', () => {
    db.addHabit(user.id, 'Water', 'hydration', '3L', true, false)
    db.addHabit(user.id, 'Run',   'exercise',  '5k', true, true)
    expect(db.getHabits(user.id)).toHaveLength(2)
  })

  it('removeHabit deactivates the habit', () => {
    db.addHabit(user.id, 'Water', 'hydration', '3L', true, false)
    const [habit] = db.getHabits(user.id)
    db.removeHabit(habit.id, user.id)
    expect(db.getHabits(user.id)).toHaveLength(0)
  })

  it('updateHabit changes name', () => {
    db.addHabit(user.id, 'Old Name', 'food', null, true, false)
    const [habit] = db.getHabits(user.id)
    db.updateHabit(habit.id, user.id, { habit_name: 'New Name' })
    const updated = db.getHabits(user.id)
    expect(updated[0].habit_name).toBe('New Name')
  })

  it('updateHabit changes notify_morning and notify_night slot', () => {
    db.addHabit(user.id, 'Run', 'exercise', '5k', true, false)
    const [habit] = db.getHabits(user.id)
    db.updateHabit(habit.id, user.id, { notify_morning: 0, notify_night: 1 })
    const updated = db.getHabits(user.id)
    expect(updated[0].notify_morning).toBe(0)
    expect(updated[0].notify_night).toBe(1)
  })
})

// ── Habit Logs ──────────────────────────────────────────────────────────────
describe('habit logs', () => {
  let user, habitId

  beforeEach(() => {
    user = makeUser(String(Date.now() + Math.random()))
    db.addHabit(user.id, 'Push-ups', 'exercise', '50 reps', true, false)
    habitId = db.getHabits(user.id)[0].id
  })

  it('logHabit inserts a log entry', () => {
    db.logHabit(user.id, habitId, '2024-01-01', 100)
    const log = db.getLog(user.id, habitId, '2024-01-01')
    expect(log).toBeDefined()
    expect(log.completion_value).toBe(100)
  })

  it('logHabit upserts — second log overwrites first', () => {
    db.logHabit(user.id, habitId, '2024-01-01', 50)
    db.logHabit(user.id, habitId, '2024-01-01', 100)
    const log = db.getLog(user.id, habitId, '2024-01-01')
    expect(log.completion_value).toBe(100)
  })

  it('getLog returns undefined for non-existent entry', () => {
    expect(db.getLog(user.id, habitId, '2000-01-01')).toBeUndefined()
  })

  it('getLogs returns all logs for a user and date', () => {
    db.addHabit(user.id, 'Water', 'hydration', '3L', true, false)
    const habits = db.getHabits(user.id)
    habits.forEach(h => db.logHabit(user.id, h.id, '2024-01-01', 100))
    const logs = db.getTodayLogs(user.id, '2024-01-01')
    expect(logs.length).toBe(habits.length)
  })
})

// ── updateUserTimezone ───────────────────────────────────────────────────────
describe('updateUserTimezone', () => {
  it('updates timezone', () => {
    const { user } = db.getOrCreateUser('3001', 'eve', 'Eve')
    db.updateUserTimezone('3001', 'Asia/Kolkata')
    const updated = db.getUser('3001')
    expect(updated.timezone).toBe('Asia/Kolkata')
  })
})
