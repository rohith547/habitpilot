# HabitPilot 🧘

> Minimalist Telegram habit tracking bot. Log daily health routines with minimal effort.

Built with Node.js + SQLite + node-cron. Deployed on Railway.

---

## Philosophy

**Steve Jobs style UX** — calm, disciplined, frictionless.

- Only 2 notifications per day (morning + night)
- One tap per habit: ✗ / 25% / 50% / ✓
- No motivational spam
- Rich `/dashboard` with progress bars and streaks

---

## Features

| Feature | Details |
|---------|---------|
| Multi-user | Each Telegram user gets their own isolated habits |
| Default habits | 9 pre-loaded on `/start` (food, supplements, exercise, hydration) |
| Inline logging | Tap buttons — no typing needed |
| Configurable | Change habit name, target, check-in slot, notification times, timezone |
| Dashboard | Week / Month / Year — consistency %, streaks, exercise totals, sparkline |
| Scheduler | Timezone-aware, deduplication prevents double-sends |
| Admin panel | Broadcast messages, view user count |

---

## Commands

| Command | Action |
|---------|--------|
| `/start` | Register + load 9 default habits |
| `/log` | Log today's habits with inline buttons |
| `/status` | Today's snapshot with score |
| `/dashboard` | Week / Month / Year analytics |
| `/addhabit` | Add a habit (name → category → target → check-in slot) |
| `/edithabit` | Edit name, target, or check-in slot of existing habit |
| `/removehabit` | Remove a habit |
| `/config` | Change notification times and timezone |
| `/help` | Show all commands |
| `/admin` | Admin: user count, broadcast _(owner only)_ |

---

## Default Habits

**Morning check-in (7:30 AM)**
- Seeds mix
- Eggs / protein
- Vitamins & supplements
- Morning water (1L)

**Night review (9:30 PM)**
- Pushups — target: 150
- Squats — target: 150
- Greens
- Magnesium
- Total water intake (3L)

All customizable per user via `/addhabit`, `/edithabit`, `/removehabit`.

---

## Dashboard Preview

```
📊 DASHBOARD

📅 THIS WEEK
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
🟢 Consistency: 85%
`█████████░░░`

7-day activity:
`● ◑ ● ● · ● ●`
● full  ◑ partial  · none

🌅 Morning: 6/7 days
🌙 Night:   5/7 days

💪 Exercise this week
   Pushups: 620 reps
   Squats:  480 reps

💧 Hydration avg: 2.7L / day

Habit breakdown:
🟢 Seeds mix: 100%
🟡 Eggs / protein: 71%
🔴 Magnesium: 43%

📅 THIS MONTH
🔥 Streak: 11 days 🔥🔥
🏆 Best habit: Hydration
```

---

## Project Structure

```
habitpilot/
├── index.js        Entry point — starts server, DB, bot, scheduler
├── server.js       Express /health endpoint for Railway
├── telegram.js     All bot commands + callback handlers + state machine
├── scheduler.js    Cron every minute — timezone-aware check-in sender
├── database.js     SQLite schema + all CRUD functions
├── habits.js       Helpers: emoji, keyboard builder, completion labels
├── dashboard.js    Week/month/year analytics report generator
├── config.js       Environment variable loading
├── package.json
├── railway.toml
└── .env.example
```

---

## Tech Stack

- **Runtime:** Node.js
- **Bot:** node-telegram-bot-api
- **Database:** SQLite via better-sqlite3
- **Scheduler:** node-cron
- **Server:** Express (health check)
- **Deploy:** Railway + Railway Volume (persistent storage)

---

## Setup

### 1. Clone

```bash
git clone https://github.com/rohith547/habitpilot
cd habitpilot
npm install
```

### 2. Create bot

1. Open Telegram → search `@BotFather`
2. Send `/newbot` → follow prompts
3. Copy the bot token

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_token_here
ADMIN_TELEGRAM_ID=your_telegram_user_id
DB_PATH=./data/habits.db
PORT=3000
```

> Get your Telegram user ID from `@userinfobot`

### 4. Run locally

```bash
npm start
```

---

## Deploy to Railway

### 1. Push to GitHub

```bash
git remote add origin https://github.com/yourname/habitpilot
git push -u origin main
```

### 2. Create Railway project

```bash
railway login
railway init
railway up
```

### 3. Set environment variables

```bash
railway variables --set "TELEGRAM_BOT_TOKEN=xxxx"
railway variables --set "ADMIN_TELEGRAM_ID=xxxx"
railway variables --set "DB_PATH=/data/habits.db"
railway variables --set "PORT=8080"
```

### 4. Add persistent volume

```bash
railway volume add --mount-path /data
```

This mounts a 500MB Railway Volume at `/data` — your SQLite database persists across all deploys and restarts.

### 5. Verify

```bash
railway logs --tail 10
curl https://your-app.up.railway.app/health
```

---

## Database Schema

```sql
users         — telegram_id, username, first_name, timezone
habits        — user_id, habit_name, category, target_value, notify_morning, notify_night
habit_logs    — user_id, habit_id, date, completion_value (0/25/50/100)
notifications — user_id, notification_time, notification_type, last_sent
```

---

## Notification System

- Scheduler checks every minute
- Compares current time in each user's timezone against their notification schedule
- `last_sent` field prevents duplicate sends on the same day
- Default: 7:30 AM morning + 9:30 PM night (both configurable per user)

---

## Consistency Score

Daily score = `sum(completion_values) / (num_habits × 100) × 100`

Color thresholds:
- 🟢 ≥ 80%
- 🟡 ≥ 50%
- 🔴 < 50%

Streak = consecutive days with score ≥ 50%

---

## Live Bot

Telegram: [@dai1y_habit_bot](https://t.me/dai1y_habit_bot)
