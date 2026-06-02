const cron = require('node-cron');
const Job = require('../models/Job');
const Group = require('../models/Group');
const PollResponse = require('../models/PollResponse');
const Reminder = require('../models/Reminder');
const bot = require('./bot');
const logger = require('../utils/logger');

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


/**
 * Sends a direct message reminder to a user
 */
async function sendDMReminder(userId, username, job, reminderType) {
  try {
    const now = new Date();
    const timeRemainingMs = job.deadline ? (job.deadline.getTime() - now.getTime()) : 0;
    const hoursRemaining = Math.floor(timeRemainingMs / (1000 * 60 * 60));
    const minutesRemaining = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));

    let closesInStr = '';
    if (hoursRemaining > 0) {
      closesInStr = `closes in ${hoursRemaining}h ${minutesRemaining}m`;
    } else if (minutesRemaining > 0) {
      closesInStr = `closes in ${minutesRemaining}m`;
    } else {
      closesInStr = 'closing now';
    }

    const deadlineFormatted = job.deadline ? new Date(job.deadline).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) : '';

    const text = `🚨 <b>Application Reminder</b>

⏰ Apply to <b>${escapeHTML(job.company)}</b> for <b>${escapeHTML(job.role)}</b> before it closes!
📅 <b>Deadline:</b> ${escapeHTML(deadlineFormatted)} (<b>${escapeHTML(closesInStr)}</b>)`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔗 Apply Now', url: job.applyLink }
        ]
      ]
    };

    if (String(job.telegramGroupId).startsWith('-100')) {
      const cleanGroupId = String(job.telegramGroupId).replace('-100', '');
      const pollLink = `https://t.me/c/${cleanGroupId}/${job.telegramMessageId}`;
      keyboard.inline_keyboard[0].push({ text: '💬 View Poll', url: pollLink });
    }

    await bot.sendMessage(userId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard
    });
    logger.info('Successfully sent %s DM reminder to user %d (%s) for job %s', reminderType, userId, username, job._id);
    return true;
  } catch (err) {
    logger.warn('Failed to send DM reminder to user %d (%s): %s', userId, username, err.message);
    return false;
  }
}

const MOTIVATIONAL_LINES = [
  "Every application is a step closer to your dream job. Don't wait!",
  "The best time to apply was yesterday; the second best time is now!",
  "Opportunities don't wait, and neither should you. Apply today!",
  "You miss 100% of the shots you don't take. Go for it!",
  "Small steps everyday lead to big results. Fill out that application!",
  "Believe you can and you're halfway there. Submit your application!",
  "Your future self will thank you for applying today. Don't procrastinate!",
  "Success is the sum of small efforts repeated day in and day out. Take action!"
];

function getRandomMotivation() {
  const index = Math.floor(Math.random() * MOTIVATIONAL_LINES.length);
  return MOTIVATIONAL_LINES[index];
}

async function sendPostCreationReminder(userId, username, job) {
  try {
    const motivation = getRandomMotivation();
    let text = '';

    if (job.deadline) {
      const now = new Date();
      const timeRemainingMs = job.deadline.getTime() - now.getTime();
      const hoursRemaining = Math.floor(timeRemainingMs / (1000 * 60 * 60));
      const minutesRemaining = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));

      let closesInStr = '';
      if (hoursRemaining > 0) {
        closesInStr = `closes in ${hoursRemaining}h ${minutesRemaining}m`;
      } else if (minutesRemaining > 0) {
        closesInStr = `closes in ${minutesRemaining}m`;
      } else {
        closesInStr = 'closing now';
      }

      const deadlineFormatted = new Date(job.deadline).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

      text = `⏰ <b>Pending Application:</b> <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)}
📅 <b>Deadline:</b> ${escapeHTML(deadlineFormatted)} (<b>${escapeHTML(closesInStr)}</b>)

💡 <i>"${motivation}"</i>`;
    } else {
      text = `⏰ <b>Pending Application:</b> <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)} (<b>submit asap</b>)

💡 <i>"${motivation}"</i>`;
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔗 Apply Now', url: job.applyLink }
        ]
      ]
    };

    if (String(job.telegramGroupId).startsWith('-100')) {
      const cleanGroupId = String(job.telegramGroupId).replace('-100', '');
      const pollLink = `https://t.me/c/${cleanGroupId}/${job.telegramMessageId}`;
      keyboard.inline_keyboard[0].push({ text: '💬 View Poll', url: pollLink });
    }

    await bot.sendMessage(userId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard
    });
    logger.info('Successfully sent post-creation DM reminder to user %d (%s) for job %s', userId, username, job._id);
    return true;
  } catch (err) {
    logger.warn('Failed to send post-creation DM reminder to user %d (%s): %s', userId, username, err.message);
    return false;
  }
}

/**
 * Checks all active jobs, triggers reminders, and closes expired jobs.
 */
async function checkJobs() {
  logger.debug('Scheduler: Running job check...');
  const now = new Date();

  try {
    // 1. Process active jobs
    const activeJobs = await Job.find({ status: 'active' });

    for (const job of activeJobs) {
      const timeSinceCreatedMs = now.getTime() - job.createdAt.getTime();
      const minutesSinceCreated = timeSinceCreatedMs / (1000 * 60);

      // Find group record and target users (fetch once per job)
      const group = await Group.findOne({ telegramGroupId: job.telegramGroupId });
      if (group) {
        const responses = await PollResponse.find({ jobId: job._id });
        const yesVotedUserIds = new Set(responses.filter(r => r.response === 'yes').map(r => r.userId));
        
        // Target users: voted "no" or never responded
        const targetUsers = group.members.filter(member => !yesVotedUserIds.has(member.userId));

        // A. Process post-creation reminder
        const postCreationThreshold = parseInt(process.env.REMINDER_POST_CREATION_MINUTES || '180', 10);
        if (minutesSinceCreated >= postCreationThreshold) {
          for (const target of targetUsers) {
            const alreadySent = await Reminder.findOne({
              jobId: job._id,
              userId: target.userId,
              reminderType: '24h_post'
            });

            if (!alreadySent) {
              await sendPostCreationReminder(target.userId, target.username, job);
              const reminderRecord = new Reminder({
                jobId: job._id,
                userId: target.userId,
                reminderType: '24h_post',
                sentAt: new Date()
              });
              await reminderRecord.save();
            }
          }
        }

        // B. Process standard deadline-based reminders
        if (job.deadline) {
          const timeRemainingMs = job.deadline.getTime() - now.getTime();

          // Check if deadline has passed
          if (timeRemainingMs <= 0) {
            logger.info('Job %s (%s - %s) has passed its deadline. Marking as closed.', job._id, job.company, job.role);
            job.status = 'closed';
            await job.save();
            
            // Notify group
            try {
              await bot.sendMessage(job.telegramGroupId, `🔒 <b>Deadline Passed:</b> Applications for <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b> are now closed. Reminders locked.`, { parse_mode: 'HTML' });
            } catch (err) {
              logger.error('Failed to send closure message to group %d: %s', job.telegramGroupId, err.message);
            }
            continue;
          }

          // Determine active reminder window
          const hoursRemaining = timeRemainingMs / (1000 * 60 * 60);
          const deadlineReminderThresholdHours = parseInt(process.env.REMINDER_DEADLINE_HOURS || '3', 10);

          if (hoursRemaining <= deadlineReminderThresholdHours) {
            const reminderType = `${deadlineReminderThresholdHours}h`;
            for (const target of targetUsers) {
              const alreadySent = await Reminder.findOne({
                jobId: job._id,
                userId: target.userId,
                reminderType: reminderType
              });

              if (!alreadySent) {
                await sendDMReminder(target.userId, target.username, job, reminderType);
                const reminderRecord = new Reminder({
                  jobId: job._id,
                  userId: target.userId,
                  reminderType: reminderType,
                  sentAt: new Date()
                });
                await reminderRecord.save();
              }
            }
          }
        } else {
          // Auto-close after 7 days (168 hours) if no deadline
          const hoursSinceCreated = timeSinceCreatedMs / (1000 * 60 * 60);
          if (hoursSinceCreated >= 168) {
            logger.info('Job %s (%s - %s) has no deadline and reached 7 days. Marking as closed.', job._id, job.company, job.role);
            job.status = 'closed';
            await job.save();

            // Notify group
            try {
              await bot.sendMessage(job.telegramGroupId, `📁 <b>Opportunity Closed:</b> <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b> has been archived after 7 days. Reminders locked.`, { parse_mode: 'HTML' });
            } catch (err) {
              logger.error('Failed to send closure message to group %d: %s', job.telegramGroupId, err.message);
            }
            continue;
          }
        }
      } else {
        logger.warn('No group record found in DB for group ID: %d', job.telegramGroupId);
      }
    }

    // 2. Process closed jobs and archive them after a delay (e.g. closed for more than 24 hours)
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const closedJobsToArchive = await Job.find({
      status: 'closed',
      updatedAt: { $lt: oneDayAgo }
    });

    for (const job of closedJobsToArchive) {
      logger.info('Archiving job %s (%s - %s) after 24h grace period.', job._id, job.company, job.role);
      job.status = 'archived';
      await job.save();
    }

  } catch (err) {
    logger.error('Error running scheduler job check: %s', err.stack);
  }
}

/**
 * Initializes the scheduler cron jobs
 */
function initScheduler() {
  // Run check every 5 minutes in production, but let's make it run every minute for responsiveness
  const schedulePattern = process.env.NODE_ENV === 'production' ? '*/5 * * * *' : '* * * * *';
  
  cron.schedule(schedulePattern, async () => {
    await checkJobs();
  });
  
  logger.info('Scheduler initialized with pattern: %s', schedulePattern);
  
  // Run an immediate check on startup
  checkJobs();
}

module.exports = {
  initScheduler,
  checkJobs
};
