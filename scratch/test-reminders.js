require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Job = require('../src/models/Job');
const Group = require('../src/models/Group');
const PollResponse = require('../src/models/PollResponse');
const Reminder = require('../src/models/Reminder');
const bot = require('../src/services/bot');
const { checkJobs } = require('../src/services/scheduler');
const logger = require('../src/utils/logger');

// Mock bot.sendMessage to log to console instead of sending real Telegram requests
const sentMessages = [];
bot.sendMessage = async (userId, text, options) => {
  logger.info(`[MOCK BOT SEND] To: ${userId} | Message: ${text.substring(0, 100).replace(/\n/g, ' ')}...`);
  sentMessages.push({ userId, text, options });
  return { message_id: 99999 + sentMessages.length };
};

async function testReminderScheduler() {
  try {
    logger.info('=== STARTING REMINDERS SCHEDULER INTEGRATION TEST ===');
    await connectDB();

    // 1. Clean up any previous test mock data
    const mockGroupId = 999888777;
    const mockUserId = 888777666;
    
    await Job.deleteMany({ telegramGroupId: mockGroupId });
    await Group.deleteMany({ telegramGroupId: mockGroupId });
    await PollResponse.deleteMany({ userId: mockUserId });
    await Reminder.deleteMany({ userId: mockUserId });

    logger.info('Cleaned up previous mock data.');

    // 2. Setup mock group and user
    const group = new Group({
      telegramGroupId: mockGroupId,
      groupName: 'Mock Test Placement Group',
      members: [
        {
          userId: mockUserId,
          username: 'testuser',
          firstName: 'Test',
          lastName: 'User'
        }
      ]
    });
    await group.save();
    logger.info('Mock Group and User created.');

    // --- TEST CASE 1: FAR DEADLINE (should trigger 12h recurring, skip 6h deadline) ---
    logger.info('--- RUNNING TEST CASE 1: FAR DEADLINE ---');
    const now = new Date();
    const createdAtTime1 = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const deadlineTime1 = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h away

    const job1 = new Job({
      company: 'Far Mock Corp',
      role: 'Software Test Engineer 1',
      applyLink: 'https://careers.mockcorp.com/jobs/1',
      deadline: deadlineTime1,
      telegramMessageId: 1001,
      telegramGroupId: mockGroupId,
      telegramPollId: 'mock-poll-111',
      status: 'active'
    });
    job1.createdAt = createdAtTime1;
    await job1.save();

    const respondedAtTime1 = new Date(now.getTime() - 4.5 * 60 * 60 * 1000);
    const pollResponse1 = new PollResponse({
      jobId: job1._id,
      userId: mockUserId,
      username: 'testuser',
      response: 'no',
      respondedAt: respondedAtTime1
    });
    await pollResponse1.save();

    logger.info('Executing checkJobs() for Test Case 1...');
    await checkJobs();

    const savedReminders1 = await Reminder.find({ jobId: job1._id, userId: mockUserId });
    const savedTypes1 = savedReminders1.map(r => r.reminderType);
    logger.info(`Saved reminder types for Case 1: [${savedTypes1.join(', ')}]`);

    const expected1 = ['3h_post_vote', '6h_post_creation', '12h_recur_12'];
    let passed1 = true;
    for (const exp of expected1) {
      if (savedTypes1.includes(exp)) {
        logger.info(`✅ Match Found (Case 1): '${exp}' triggered successfully.`);
      } else {
        logger.error(`❌ Match Missing (Case 1): '${exp}' was not triggered!`);
        passed1 = false;
      }
    }

    // Check that 6h_deadline was NOT triggered
    if (savedTypes1.includes('6h_deadline')) {
      logger.error(`❌ Case 1 Failure: '6h_deadline' was triggered even though deadline is 24h away!`);
      passed1 = false;
    } else {
      logger.info(`✅ Match Success (Case 1): '6h_deadline' was correctly NOT triggered.`);
    }

    // --- TEST CASE 2: NEAR DEADLINE (should trigger 6h deadline, skip 12h recurring due to safety check) ---
    logger.info('\n--- RUNNING TEST CASE 2: NEAR DEADLINE ---');
    const createdAtTime2 = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const deadlineTime2 = new Date(now.getTime() + 5 * 60 * 60 * 1000); // 5 hours away

    const job2 = new Job({
      company: 'Near Mock Corp',
      role: 'Software Test Engineer 2',
      applyLink: 'https://careers.mockcorp.com/jobs/2',
      deadline: deadlineTime2,
      telegramMessageId: 1002,
      telegramGroupId: mockGroupId,
      telegramPollId: 'mock-poll-222',
      status: 'active'
    });
    job2.createdAt = createdAtTime2;
    await job2.save();

    const respondedAtTime2 = new Date(now.getTime() - 4.5 * 60 * 60 * 1000);
    const pollResponse2 = new PollResponse({
      jobId: job2._id,
      userId: mockUserId,
      username: 'testuser',
      response: 'no',
      respondedAt: respondedAtTime2
    });
    await pollResponse2.save();

    logger.info('Executing checkJobs() for Test Case 2...');
    await checkJobs();

    const savedReminders2 = await Reminder.find({ jobId: job2._id, userId: mockUserId });
    const savedTypes2 = savedReminders2.map(r => r.reminderType);
    logger.info(`Saved reminder types for Case 2: [${savedTypes2.join(', ')}]`);

    const expected2 = ['6h_deadline', '3h_post_vote', '6h_post_creation'];
    let passed2 = true;
    for (const exp of expected2) {
      if (savedTypes2.includes(exp)) {
        logger.info(`✅ Match Found (Case 2): '${exp}' triggered successfully.`);
      } else {
        logger.error(`❌ Match Missing (Case 2): '${exp}' was not triggered!`);
        passed2 = false;
      }
    }

    // Check that 12h_recur_12 was NOT triggered (skipped due to deadline closeness)
    if (savedTypes2.includes('12h_recur_12')) {
      logger.error(`❌ Case 2 Failure: '12h_recur_12' was triggered even though deadline is <12h away!`);
      passed2 = false;
    } else {
      logger.info(`✅ Match Success (Case 2): '12h_recur_12' was correctly NOT triggered.`);
    }

    // 7. Cleanup
    await Job.deleteMany({ telegramGroupId: mockGroupId });
    await Group.deleteMany({ telegramGroupId: mockGroupId });
    await PollResponse.deleteMany({ userId: mockUserId });
    await Reminder.deleteMany({ userId: mockUserId });
    logger.info('Mock data cleaned up.');

    if (passed1 && passed2) {
      logger.info('\n=== INTEGRATION TEST PASSED SUCCESSFULLY ===');
    } else {
      logger.error('\n=== INTEGRATION TEST FAILED ===');
    }

    mongoose.connection.close();
  } catch (err) {
    logger.error('Test error encountered: %s', err.stack);
    mongoose.connection.close();
  }
}

testReminderScheduler();
