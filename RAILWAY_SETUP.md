# Railway Persistent Storage Setup

To prevent data loss on redeploy, add a Volume once:

## Steps

**Option A — Right-click (easiest):**
1. Go to your Railway project canvas (the view showing all services)
2. **Right-click on empty space** on the canvas
3. Select **"Add Volume"**
4. Connect it to your `habitpilot` service
5. Set mount path: **`/app/data`**
6. Save

**Option B — Command palette:**
1. Press **⌘K** (Mac) or **Ctrl+K** (Windows) in Railway
2. Type `volume` → select **"New Volume"**
3. Same steps above

## Then set the environment variable

Go to your `habitpilot` service → **Variables** tab → Add:
```
DB_PATH=/app/data/habits.db
```

## Redeploy

Push any commit or click "Redeploy" in Railway.

---

> ⚠️ Mount path must be `/app/data` — Railway puts Node apps in `/app/`, so `./data` = `/app/data`.
> Without this, all user data (habits, logs, streaks) is wiped on every code push.
