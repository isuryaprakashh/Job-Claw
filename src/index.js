// Load environment variables
require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const connectDB = require('./config/db');
const logger = require('./utils/logger');
const { initScheduler } = require('./services/scheduler');

// Express App setup for Health Checks and Render Keep-Alive
const app = express();
const PORT = process.env.PORT || 3000;

// Log HTTP requests
app.use(morgan('dev', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

app.use(express.json());

// Health Check Route
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date(),
    uptime: process.uptime()
  });
});

async function startApp() {
  try {
    // 1. Connect to Database
    await connectDB();

    // 2. Initialize Telegram Bot
    // Requiring bot.js initializes it and begins polling automatically
    logger.info('Starting Telegram Bot service...');
    require('./services/bot');

    // 3. Initialize Scheduler
    logger.info('Starting scheduler service...');
    initScheduler();

    // 4. Start HTTP Server
    app.listen(PORT, () => {
      logger.info('HTTP health check server running on port %d', PORT);
    });

  } catch (error) {
    logger.error('Startup failed: %s', error.stack || error.message);
    process.exit(1);
  }
}

startApp();
