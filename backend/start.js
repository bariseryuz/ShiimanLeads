// Combined starter for Railway deployment
// Starts both the web server (server.js) and scraper (index.js)

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting Shiiman Leads (Web Server + Scraper)');

// Start index.js (scraper + cron)
const scraper = spawn('node', ['index.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env }
});

// Start server.js (web UI)
const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env }
});

// Handle exits
scraper.on('exit', (code) => {
  console.error(`❌ Scraper (index.js) exited with code ${code}`);
  process.exit(code || 1);
});

server.on('exit', (code) => {
  console.error(`❌ Server (server.js) exited with code ${code}`);
  process.exit(code || 1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  scraper.kill();
  server.kill();
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  scraper.kill();
  server.kill();
});
