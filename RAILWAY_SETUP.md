# Railway Persistent Storage Setup

To prevent data loss on redeploy:

1. Railway Dashboard → your service → **Storage** tab
2. Click **Add Volume** → mount path: `/data` → size: 1 GB
3. Go to **Variables** tab → add: `DB_PATH=/data/habits.db`
4. Redeploy

Without this, SQLite data resets on every deploy.
