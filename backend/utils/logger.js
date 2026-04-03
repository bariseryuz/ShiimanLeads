const winston = require('winston');
const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const useJson = String(process.env.LOG_FORMAT || '').trim().toLowerCase() === 'json';

const lineFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(i => `${i.timestamp} [${i.level.toUpperCase()}] ${i.message}`)
);

const jsonFormat = winston.format.combine(winston.format.timestamp(), winston.format.json());

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: useJson ? jsonFormat : lineFormat,
  defaultMeta: useJson ? { service: 'shiiman-leads' } : undefined,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'combined.log') })
  ]
});

module.exports = logger;
