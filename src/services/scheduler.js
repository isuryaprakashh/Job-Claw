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

function getOpportunityType(job) {
  return job && ['job', 'hackathon', 'competition'].includes(job.opportunityType)
    ? job.opportunityType
    : 'job';
}

function getOpportunityMeta(job) {
  const type = getOpportunityType(job);
  const meta = {
    job: {
      singular: 'Job',
      linkText: 'Apply Now',
      deadlineLabel: 'Deadline',
      pendingTitle: 'Pending Application',
      reminderAction: 'Apply',
      closedPrefix: 'Applications'
    },
    hackathon: {
      singular: 'Hackathon',
      linkText: 'Register Now',
      deadlineLabel: 'Registration Deadline',
      pendingTitle: 'Pending Registration',
      reminderAction: 'Register',
      closedPrefix: 'Registrations'
    },
    competition: {
      singular: 'Competition',
      linkText: 'Register Now',
      deadlineLabel: 'Registration Deadline',
      pendingTitle: 'Pending Registration',
      reminderAction: 'Register',
      closedPrefix: 'Registrations'
    }
  };

  return meta[type];
}


/**
 * Sends a dynamically formatted direct message reminder to a user.
 */
async function sendAppReminder(userId, username, job, reminderType) {
  try {
    const meta = getOpportunityMeta(job);
    const now = new Date();
    const timeRemainingMs = job.deadline ? (job.deadline.getTime() - now.getTime()) : null;

    let closesInStr = '';
    if (timeRemainingMs !== null) {
      if (timeRemainingMs > 0) {
        const hoursRemaining = Math.floor(timeRemainingMs / (1000 * 60 * 60));
        const minutesRemaining = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));
        closesInStr = hoursRemaining > 0 ? `closes in ${hoursRemaining}h ${minutesRemaining}m` : `closes in ${minutesRemaining}m`;
      } else {
        closesInStr = 'closed';
      }
    } else {
      closesInStr = 'submit asap';
    }

    const deadlineFormatted = job.deadline ? new Date(job.deadline).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) : 'No Deadline specified';
    // Tailor reminder header message based on type and opportunity metadata
    let header = `🚨 <b>${escapeHTML(meta.singular)} Reminder</b>`;
    if (reminderType.includes('deadline')) {
      const label = reminderType.replace('_deadline', '');
      header = `⏰ <b>${escapeHTML(meta.singular)} Deadline Alert (${label} remaining)</b>`;
    } else if (reminderType.includes('post_vote')) {
      const label = reminderType.replace('_post_vote', '');
      header = `⏰ <b>${escapeHTML(meta.pendingTitle)} (${label} since your vote)</b>`;
    } else if (reminderType.includes('post_creation')) {
      header = `⏰ <b>New Opportunity Alert (6h since post)</b>`;
    } else if (reminderType.includes('recur')) {
      header = `⏰ <b>${escapeHTML(meta.singular)} Reminder (Recurring Alert)</b>`;
    }

    const motivation = getRandomMotivation();
    const deadlineSection = job.deadline
      ? `📅 <b>${escapeHTML(meta.deadlineLabel)}:</b> ${escapeHTML(deadlineFormatted)} (<b>${escapeHTML(closesInStr)}</b>)`
      : `📅 <b>${escapeHTML(meta.deadlineLabel)}:</b> <b>${escapeHTML(closesInStr)}</b>`;

    const text = `${header}

⏰ Keep tracking your ${escapeHTML(meta.singular.toLowerCase())} for <b>${escapeHTML(job.company)}</b> - <b>${escapeHTML(job.role)}</b>!

${deadlineSection}

💡 <i>"${motivation}"</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: `🔗 ${meta.linkText}`, url: job.applyLink }
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
    logger.info('Successfully sent %s reminder to user %d (%s) for job %s', reminderType, userId, username, job._id);
    return true;
  } catch (err) {
    logger.warn('Failed to send %s reminder to user %d (%s): %s', reminderType, userId, username, err.message);
    return false;
  }
}

const MOTIVATIONAL_LINES = [
  "Every opportunity you act on is a step forward. Don't wait!",
  "The best time to register was yesterday; the second best time is now!",
  "Opportunities don't wait, and neither should you. Take action today!",
  "You miss 100% of the shots you don't take. Go for it!",
  "Small steps everyday lead to big results. Finish that registration!",
  "Believe you can and you're halfway there. Submit it!",
  "Your future self will thank you for acting today. Don't procrastinate!",
  "Success is the sum of small efforts repeated day in and day out. Take action!"
];

function getRandomMotivation() {
  const index = Math.floor(Math.random() * MOTIVATIONAL_LINES.length);
  return MOTIVATIONAL_LINES[index];
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
      const meta = getOpportunityMeta(job);
      const timeSinceCreatedMs = now.getTime() - job.createdAt.getTime();
      const hoursSinceCreated = timeSinceCreatedMs / (1000 * 60 * 60);

      // Find time remaining if deadline exists
      let hoursRemaining = null;
      let timeRemainingMs = null;
      if (job.deadline) {
        timeRemainingMs = job.deadline.getTime() - now.getTime();
        hoursRemaining = timeRemainingMs / (1000 * 60 * 60);

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
      } else {
        // Auto-close after 7 days (168 hours) if no deadline
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

      // Find group record and target users (fetch once per job)
      const group = await Group.findOne({ telegramGroupId: job.telegramGroupId });
      if (!group) {
        logger.warn('No group record found in DB for group ID: %d', job.telegramGroupId);
        continue;
      }

      const dmRemindersEnabled = !group.settings || group.settings.dmRemindersEnabled !== false;
      if (!dmRemindersEnabled) {
        continue;
      }

      const responses = await PollResponse.find({ jobId: job._id });
      const yesVotedUserIds = new Set(responses.filter(r => r.response === 'yes').map(r => r.userId));
      const noVotedResponses = responses.filter(r => r.response === 'no');
      const noVotedUsersMap = new Map(noVotedResponses.map(r => [r.userId, r]));

      // Target users: voted "no" or never responded
      const targetUsers = group.members.filter(member => !yesVotedUserIds.has(member.userId));

      for (const target of targetUsers) {
        // Find existing reminders to avoid double sending
        const sentReminders = await Reminder.find({ jobId: job._id, userId: target.userId });
        const sentTypes = new Set(sentReminders.map(r => r.reminderType));

        // 1. Deadline-based Reminders
        if (hoursRemaining !== null) {
          // A. 6 hours before deadline
          if (hoursRemaining <= 6 && hoursRemaining > 3) {
            if (!sentTypes.has('6h_deadline')) {
              const success = await sendAppReminder(target.userId, target.username, job, '6h_deadline');
              if (success) {
                await new Reminder({ jobId: job._id, userId: target.userId, reminderType: '6h_deadline' }).save();
              }
            }
          }
          // B. 3 hours before deadline
          if (hoursRemaining <= 3 && hoursRemaining > 1) {
            if (!sentTypes.has('3h_deadline')) {
              const success = await sendAppReminder(target.userId, target.username, job, '3h_deadline');
              if (success) {
                await new Reminder({ jobId: job._id, userId: target.userId, reminderType: '3h_deadline' }).save();
              }
            }
          }
          // C. 1 hour before deadline
          if (hoursRemaining <= 1 && hoursRemaining > 0) {
            if (!sentTypes.has('1h_deadline')) {
              const success = await sendAppReminder(target.userId, target.username, job, '1h_deadline');
              if (success) {
                await new Reminder({ jobId: job._id, userId: target.userId, reminderType: '1h_deadline' }).save();
              }
            }
          }
        }

        // 2. Vote-based Reminders (only if user explicitly voted "No")
        const noVoteRecord = noVotedUsersMap.get(target.userId);
        if (noVoteRecord) {
          const timeSinceVoteMs = now.getTime() - noVoteRecord.respondedAt.getTime();
          const hoursSinceVote = timeSinceVoteMs / (1000 * 60 * 60);

          // A. 3 hours after voting "No"
          if (hoursSinceVote >= 3 && hoursSinceVote < 6) {
            if (!sentTypes.has('3h_post_vote')) {
              const success = await sendAppReminder(target.userId, target.username, job, '3h_post_vote');
              if (success) {
                await new Reminder({ jobId: job._id, userId: target.userId, reminderType: '3h_post_vote' }).save();
              }
            }
          }
          // B. 6 hours after voting "No"
          if (hoursSinceVote >= 6) {
            if (!sentTypes.has('6h_post_vote')) {
              const success = await sendAppReminder(target.userId, target.username, job, '6h_post_vote');
              if (success) {
                await new Reminder({ jobId: job._id, userId: target.userId, reminderType: '6h_post_vote' }).save();
              }
            }
          }
        }

        // 3. Post-Creation Reminder (6h after poll creation)
        if (hoursSinceCreated >= 6) {
          if (!sentTypes.has('6h_post_creation')) {
            const success = await sendAppReminder(target.userId, target.username, job, '6h_post_creation');
            if (success) {
              await new Reminder({ jobId: job._id, userId: target.userId, reminderType: '6h_post_creation' }).save();
            }
          }
        }

        // 4. Recurring Reminders (every 12h since creation)
        const recurInterval = Math.floor(hoursSinceCreated / 12);
        if (recurInterval >= 1) {
          const recurType = `12h_recur_${recurInterval * 12}`;
          // Don't send recurring reminders if the deadline is less than 12 hours away, to avoid overlapping with deadline reminders
          const shouldSkipRecur = hoursRemaining !== null && hoursRemaining < 12;

          if (!shouldSkipRecur && !sentTypes.has(recurType)) {
            const success = await sendAppReminder(target.userId, target.username, job, recurType);
            if (success) {
              await new Reminder({ jobId: job._id, userId: target.userId, reminderType: recurType }).save();
            }
          }
        }
      }
    }

    // 2. Process closed jobs and archive them after a delay (e.g. closed for more than 24 hours)
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const closedJobsToArchive = await Job.find({
      status: 'closed',
      updatedAt: { $lt: oneDayAgo }
    });

    for (const job of closedJobsToArchive) {
      logger.info('Archiving opportunity %s (%s - %s) after 24h grace period.', job._id, job.company, job.role);
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
