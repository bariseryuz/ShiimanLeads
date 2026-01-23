Local SQLite database files removed from the repository workspace.

Reason: This project is configured to use a single canonical SQLite database provided by the Railway volume.
To avoid storing PII (leads, users) in the local workspace, the local DB files were removed.

If you need to restore any file manually, check backups outside this repo.

Removed files (deleted from workspace):
- backend/leads.db
- backend/sessions.db
- backend/data/leads.db
- backend/data/sessions.db
- backend/data/data.db
- backend/data/database.db

The app now uses the path from environment variable `SQLITE_DB_PATH`.
Set `SQLITE_DB_PATH` in your Railway environment to the Railway SQLite volume path.
