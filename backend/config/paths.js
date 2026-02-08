const path = require('path');
const fs = require('fs');

const isProduction = process.env.NODE_ENV === 'production';

// Base paths
const paths = {
  root: path.join(__dirname, '..'),
  data: path.join(__dirname, '..', 'data'),
  output: path.join(__dirname, '..', 'output'),
  logs: path.join(__dirname, '..', 'logs'),
  screenshots: isProduction
    ? '/app/backend/data/screenshots'  // Railway: Volume (persistent)
    : path.join(__dirname, '..', 'output')   // Local: backend/output
};

// Ensure directories exist
Object.values(paths).forEach(dirPath => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// Named exports for convenience
const SCREENSHOT_DIR = paths.screenshots;
const DB_PATH = path.join(paths.data, 'leads.db');
const SESSIONS_DB_PATH = path.join(paths.data, 'sessions.db');

module.exports = {
  ...paths,
  SCREENSHOT_DIR,
  DB_PATH,
  SESSIONS_DB_PATH
};
