const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// Utility to safely stringify objects, handling circular references
function safeStringify(obj, indent = 2) {
  const cache = new Set();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (cache.has(value)) {
          return '[Circular]';
        }
        cache.add(value);
      }
      return value;
    },
    indent
  );
}

// Custom log format
const logFormat = winston.format.printf(({ timestamp, level, message, ...metadata }) => {
  let logMessage = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length) {
    logMessage += ` ${safeStringify(metadata)}`;
  }
  return logMessage;
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    logFormat
  ),
  transports: [
    // Console logs for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    // Daily rotating log file
    new DailyRotateFile({
      filename: 'logs/app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d'
    })
  ],
  exitOnError: false
});

module.exports = logger;