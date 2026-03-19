# Database restore (Shiiman Leads)

## Backup location and schedule

- **Location:** By default, backups are stored under `backend/data/backups/` (or the path set by `BACKUP_DIR`).
- **Schedule:** A daily backup runs at 04:00 UTC (configurable via cron in `backend/services/scheduler/cron.js`).
- **Retention:** The last **7** backup files are kept (configurable with `BACKUP_KEEP`).

Backup filenames look like: `shiiman-leads-2026-03-17T04-00-00.db`.

## Restore steps

1. **Stop the application** so the database is not in use.

2. **Locate the backup file** you want to restore (e.g. `backend/data/backups/shiiman-leads-2026-03-17T04-00-00.db`).

3. **Back up the current DB** (optional but recommended):
   ```bash
   cp backend/data/shiiman-leads.db backend/data/shiiman-leads.db.pre-restore
   ```

4. **Overwrite the live database** with the backup:
   ```bash
   cp backend/data/backups/shiiman-leads-2026-03-17T04-00-00.db backend/data/shiiman-leads.db
   ```
   (Use your actual backup filename and the path from `SQLITE_DB_PATH` or `config.environment.DB_PATH` if you changed it.)

5. **Restart the application.**

6. **Verify:** Log in, check sources and recent leads to confirm the restore.

## Production (e.g. Railway)

- If the app runs on Railway or another host, ensure the volume or disk that holds `backend/data/` (and thus `backend/data/backups/`) is persistent.
- For disaster recovery, copy backups to external storage (e.g. S3/R2) in a separate job if required.

## Manual backup

To create a backup on demand (from the project root):

```bash
cd backend
node -e "require('./services/backup').runBackup().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })"
```
