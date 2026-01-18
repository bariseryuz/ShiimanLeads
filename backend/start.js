// Unified starter - Single server for everything
// Runs index.js which includes web UI + scraper + cron jobs

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting Shiiman Leads (Unified Server on Port 3000)');
console.log('   ✅ Web UI + API');
console.log('   ✅ Background scraping every 8 hours');
console.log('   ✅ Multi-user authentication');

// Start index.js (single unified server)
const server = spawn('node', ['index.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env }
});

server.on('error', (err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

server.on('exit', (code) => {
  if (code !== 0) {
    console.error(`❌ Server exited with code ${code}`);
    process.exit(code);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.kill();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.kill();
  process.exit(0);
});
