// Simple static build for Netlify
// Generates dist/index.html from EJS landing, copies dashboard and /frontend assets

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function copyFile(src, dest) { ensureDir(path.dirname(dest)); fs.copyFileSync(src, dest); }
function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d); else copyFile(s, d);
  }
}

async function build() {
  ensureDir(DIST);
  // 1) Render landing.ejs -> dist/index.html using layout
  const landingPath = path.join(ROOT, 'views', 'landing.ejs');
  const layoutPath = path.join(ROOT, 'views', 'layout.ejs');
  
  // Render body content first
  const bodyHtml = ejs.render(
    fs.readFileSync(landingPath, 'utf-8'),
    { title: 'Home', query: {}, user: null, path: '/' },
    { filename: landingPath }
  );
  
  // Now render layout with body injected
  const pageHtml = ejs.render(
    fs.readFileSync(layoutPath, 'utf-8'),
    { title: 'Home', body: bodyHtml, user: null, path: '/' },
    { filename: layoutPath }
  );
  
  fs.writeFileSync(path.join(DIST, 'index.html'), pageHtml, 'utf-8');

  // 2) Copy static dashboard
  const dashboardSrc = path.join(ROOT, 'output', 'dashboard.html');
  if (fs.existsSync(dashboardSrc)) {
    copyFile(dashboardSrc, path.join(DIST, 'dashboard', 'index.html'));
  }

  // 3) Copy frontend static bundle
  const frontendSrc = path.join(ROOT, '..', 'frontend');
  if (fs.existsSync(frontendSrc)) {
    copyDir(frontendSrc, path.join(DIST, 'frontend'));
  }

  // 4) Netlify redirects (optional): route /app/* to / (static site cannot serve auth app)
  const redirects = `/* /index.html 200\n`;
  fs.writeFileSync(path.join(DIST, '_redirects'), redirects, 'utf-8');

  console.log('Build complete →', DIST);
}

build().catch(err => { console.error(err); process.exit(1); });
