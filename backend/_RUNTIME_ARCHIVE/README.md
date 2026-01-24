```markdown
# Repo setup (minimal)

1. Copy the example:
   - cp .env.example .env
2. Edit `.env` locally:
   - Fill SMTP_USER, SMTP_PASS, GEMINI_API_KEY, and set SESSION_SECRET (strong random).
   - Trim trailing spaces (e.g., SMTP_HOST and AUTO_SCRAPE_INTERVAL).
3. Protect secrets:
   - Ensure `.env` is in `.gitignore` (it is).
   - If secrets were committed, rotate them now.
4. Prepare directories:
   - mkdir -p data logs output
5. Install & run:
   - npm install
   - npm start
6. Quick checks:
   - curl http://localhost:3000/health
   - Visit /api/test-ai (if GEMINI_API_KEY set) and /test-email (if SMTP configured).

Security notes (short)
- Never commit `.env` with real credentials.
- Rotate any API keys/passwords that were posted or pushed.
- Use a secrets manager in production (Railway/Heroku/Cloud).
```