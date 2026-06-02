const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_DB_URI || 'mongodb://localhost:27017/jobpulse';
  
  try {
    logger.info('Connecting to MongoDB...');
    await mongoose.connect(uri);
    logger.info('MongoDB connected successfully.');
  } catch (error) {
    logger.error('Error connecting to MongoDB: %s', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
