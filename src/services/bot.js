const TelegramBot = require('node-telegram-bot-api');
const Job = require('../models/Job');
const PollResponse = require('../models/PollResponse');
const Group = require('../models/Group');
const { extractJobDetails } = require('./ai');
const logger = require('../utils/logger');

const https = require('https');

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function expandUrl(shortUrl) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(shortUrl);
      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' }
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve(expandUrl(res.headers.location));
          } else {
            resolve(shortUrl);
          }
        }
      );
      req.on('error', () => resolve(shortUrl));
      req.end();
    } catch (err) {
      resolve(shortUrl);
    }
  });
}


const token = process.env.TELEGRAM_BOT_API || process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.error('TELEGRAM_BOT_API / TELEGRAM_BOT_TOKEN is not defined in the environment.');
}

const bot = new TelegramBot(token || 'dummy-token', { polling: true });

// Store active command contexts or tracking flags if needed
logger.info('Telegram Bot initialized and polling started.');

// Redirect channel posts to the message event so commands and auto-poll detection work in Channels too
bot.on('channel_post', (msg) => {
  bot.emit('message', msg);
});

/**
 * Helper to check if a user is admin of the group
 */
async function checkAdmin(chatId, userId) {
  if (chatId > 0) return true; // Private chats have no group admins
  try {
    const admins = await bot.getChatAdministrators(chatId);
    return admins.some(member => member.user.id === userId);
  } catch (err) {
    logger.warn('Error checking Telegram admins for chat %d: %s. Fallback to DB check.', chatId, err.message);
    const group = await Group.findOne({ telegramGroupId: chatId });
    if (group && group.admins.includes(userId)) {
      return true;
    }
    return false;
  }
}

/**
 * Register/update group and message sender in database
 */
async function registerUserAndGroup(msg) {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel';

  try {
    let group = await Group.findOne({ telegramGroupId: chatId });
    if (!group) {
      group = new Group({
        telegramGroupId: chatId,
        groupName: isGroup ? (msg.chat.title || '') : `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
        admins: isGroup ? [] : [msg.from.id]
      });
      if (isGroup) {
        // Load initial administrators asynchronously
        bot.getChatAdministrators(chatId).then(admins => {
          group.admins = admins.map(a => a.user.id);
          group.save().catch(e => logger.error('Error saving group admins: %s', e.message));
        }).catch(e => logger.warn('Could not load administrators initially: %s', e.message));
      }
    }

    const sender = msg.from;
    if (sender && !sender.is_bot) {
      const exists = group.members.some(m => m.userId === sender.id);
      if (!exists) {
        group.members.push({
          userId: sender.id,
          username: sender.username || '',
          firstName: sender.first_name || '',
          lastName: sender.last_name || ''
        });
      } else {
        const member = group.members.find(m => m.userId === sender.id);
        if (member.username !== (sender.username || '')) {
          member.username = sender.username || '';
        }
      }
      await group.save();
    }
    return group;
  } catch (err) {
    logger.error('Error registering user and group: %s', err.stack);
    return null;
  }
}

/**
 * Normalizes URL for duplicate checks
 */
function normalizeUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    url.hash = ''; // Remove fragments
    // Remove UTM and tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 's'];
    trackingParams.forEach(p => url.searchParams.delete(p));
    let cleaned = url.toString();
    if (cleaned.endsWith('/')) {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned;
  } catch (err) {
    return urlStr;
  }
}

/**
 * Finds a job using reference string (index in list or mongo ID)
 */
async function findJobByRef(chatId, jobRef, statusFilter = {}) {
  const cleanRef = jobRef.trim();

  // If it's a valid MongoDB ObjectId
  if (/^[0-9a-fA-F]{24}$/.test(cleanRef)) {
    return await Job.findOne({ _id: cleanRef, telegramGroupId: chatId });
  }

  // If it's a number (index)
  const index = parseInt(cleanRef, 10);
  if (!isNaN(index) && index > 0) {
    const query = { telegramGroupId: chatId, ...statusFilter };
    const jobs = await Job.find(query).sort({ createdAt: 1 });
    if (index <= jobs.length) {
      return jobs[index - 1];
    }
  }

  return null;
}

// ----------------------------------------------------
// COMMAND HANDLERS
// ----------------------------------------------------

// /help
bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;
  const botUser = await bot.getMe();
  const helpText = `<b>JobPulse Bot Commands:</b>

👥 <b>Public Commands:</b>
• /jobs - Display active opportunities
• /jobstats &lt;index/ID&gt; - Show application stats for a job
• /pending &lt;index/ID&gt; - Show users who haven't applied
• /closed - Show archived/closed opportunities
• /help - Display this help message

🔑 <b>Admin Commands:</b>
• /deletejob &lt;index/ID&gt; - Delete an opportunity
• /editdeadline &lt;index/ID&gt; &lt;YYYY-MM-DD HH:MM&gt; - Edit job deadline
• /forcepoll &lt;text&gt; - Manually create a poll from text
• /broadcast &lt;message&gt; - Broadcast message to all groups

💡 <i>Note: To receive Direct Message reminders, please start the bot in private chat by clicking <a href="t.me/${botUser.username}">here</a> and sending /start.</i>`;

  await bot.sendMessage(chatId, helpText, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// /start
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type === 'private') {
    const welcome = `👋 Hello ${escapeHTML(msg.from.first_name || 'there')}!
I am <b>JobPulse</b>, the AI job tracking bot. 

By starting me here, you have enabled <b>Direct Message Reminders</b> for jobs posted in your placement groups. I will send you reminders before deadlines if you haven't applied!

To list jobs in your groups, use the bot commands in your group chats. Type /help to see all commands.`;
    await bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
  } else {
    await bot.sendMessage(chatId, 'Bot is active! Send /help to see available commands.');
  }
});

// /jobs
bot.onText(/^\/jobs$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const activeJobs = await Job.find({ telegramGroupId: chatId, status: 'active' }).sort({ createdAt: 1 });

    if (activeJobs.length === 0) {
      return await bot.sendMessage(chatId, '📝 No active job opportunities being tracked right now.');
    }

    let response = `💼 <b>Active Opportunities:</b>\n\n`;
    activeJobs.forEach((job, index) => {
      const deadlineStr = job.deadline ? new Date(job.deadline).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      }) : 'No Deadline';
      response += `${index + 1}. <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)}\n`;
      response += `   📅 Deadline: <i>${escapeHTML(deadlineStr)}</i>\n`;
      response += `   🔗 <a href="${escapeHTML(job.applyLink)}">Apply Here</a>\n\n`;
    });
    response += `💡 Use <code>/jobstats &lt;number&gt;</code> or <code>/pending &lt;number&gt;</code> for details.`;

    await bot.sendMessage(chatId, response, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    logger.error('Error in /jobs command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active opportunities.');
  }
});

// /closed
bot.onText(/^\/closed$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const closedJobs = await Job.find({
      telegramGroupId: chatId,
      status: { $in: ['closed', 'archived'] }
    }).sort({ createdAt: -1 }).limit(10);

    if (closedJobs.length === 0) {
      return await bot.sendMessage(chatId, '📁 No closed or archived opportunities found.');
    }

    let response = `📁 <b>Recently Closed/Archived Jobs:</b>\n\n`;
    closedJobs.forEach((job, index) => {
      response += `${index + 1}. <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)} (${escapeHTML(job.status.toUpperCase())})\n`;
      response += `   🔗 <a href="${escapeHTML(job.applyLink)}">Link</a>\n\n`;
    });

    await bot.sendMessage(chatId, response, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    logger.error('Error in /closed command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve closed opportunities.');
  }
});

// /jobstats
bot.onText(/^\/jobstats(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const jobRef = match[1];

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID. Example: <code>/jobstats 1</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Job opportunity not found. Try running /jobs to see numbers.');
    }

    const responses = await PollResponse.find({ jobId: job._id });
    const appliedCount = responses.filter(r => r.response === 'yes').length;
    const notAppliedCount = responses.filter(r => r.response === 'no').length;

    // Estimate no response
    const group = await Group.findOne({ telegramGroupId: chatId });
    const totalMembers = group ? group.members.length : 0;
    const respondedUserIds = new Set(responses.map(r => r.userId));
    
    // Group members who have not responded
    const noResponseCount = Math.max(0, totalMembers - respondedUserIds.size);

    const deadlineStr = job.deadline ? new Date(job.deadline).toLocaleString('en-IN') : 'N/A';

    const responseMsg = `📊 <b>Job Application Stats:</b>
    
<b>Company:</b> ${escapeHTML(job.company)}
<b>Role:</b> ${escapeHTML(job.role)}
<b>Deadline:</b> ${escapeHTML(deadlineStr)}
<b>Status:</b> ${escapeHTML(job.status.toUpperCase())}

✅ <b>Applied:</b> ${appliedCount}
❌ <b>Not Applied:</b> ${notAppliedCount}
❔ <b>No Response (Est.):</b> ${noResponseCount}
👥 <b>Total Group Members tracked:</b> ${totalMembers}

<a href="${escapeHTML(job.applyLink)}">Link to Posting</a>`;

    await bot.sendMessage(chatId, responseMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    logger.error('Error in /jobstats command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to fetch stats for this job.');
  }
});

// /pending
bot.onText(/^\/pending(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const jobRef = match[1];

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID. Example: <code>/pending 1</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Job opportunity not found.');
    }

    const responses = await PollResponse.find({ jobId: job._id });
    const votedNoUsernames = responses.filter(r => r.response === 'no').map(r => r.username ? `@${r.username}` : `User(${r.userId})`);
    
    // Get no-response users
    const group = await Group.findOne({ telegramGroupId: chatId });
    const respondedUserIds = new Set(responses.map(r => r.userId));
    const noResponseUsernames = [];

    if (group) {
      group.members.forEach(member => {
        if (!respondedUserIds.has(member.userId)) {
          noResponseUsernames.push(member.username ? `@${member.username}` : `${member.firstName || ''} (${member.userId})`);
        }
      });
    }

    let responseMsg = `🚨 <b>Pending Applicants</b>
    
<b>Company:</b> ${escapeHTML(job.company)}
<b>Role:</b> ${escapeHTML(job.role)}

❌ <b>Voted "No" (${votedNoUsernames.length}):</b>
${votedNoUsernames.length > 0 ? escapeHTML(votedNoUsernames.join('\n')) : '<i>None</i>' }

❔ <b>No Response (${noResponseUsernames.length}):</b>
${noResponseUsernames.length > 0 ? escapeHTML(noResponseUsernames.join('\n')) : '<i>None</i>' }`;

    await bot.sendMessage(chatId, responseMsg, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /pending command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to fetch pending applicants.');
  }
});

// ----------------------------------------------------
// ADMIN COMMAND HANDLERS
// ----------------------------------------------------

// /deletejob
bot.onText(/^\/deletejob(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const jobRef = match[1];

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID to delete.');
  }

  try {
    const job = await findJobByRef(chatId, jobRef);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Job opportunity not found.');
    }

    // Delete job, poll responses and reminders
    await Job.deleteOne({ _id: job._id });
    await PollResponse.deleteMany({ jobId: job._id });
    
    await bot.sendMessage(chatId, `✅ Successfully deleted job opportunity: <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b>`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /deletejob: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to delete job opportunity.');
  }
});

// /editdeadline
bot.onText(/^\/editdeadline(?:\s+(\S+)\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const jobRef = match[1];
  const dateStr = match[2];

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (!jobRef || !dateStr) {
    return await bot.sendMessage(chatId, '⚠️ Usage: <code>/editdeadline &lt;number/ID&gt; &lt;YYYY-MM-DD HH:MM&gt;</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Job opportunity not found.');
    }

    const newDate = new Date(dateStr);
    if (isNaN(newDate.getTime())) {
      return await bot.sendMessage(chatId, '❌ Invalid date format. Please use `YYYY-MM-DD HH:MM` (e.g. `2026-06-20 23:59`).');
    }

    job.deadline = newDate;
    // Reset status if it was closed/archived and is now in the future
    if (newDate > new Date() && job.status !== 'active') {
      job.status = 'active';
    }
    await job.save();

    await bot.sendMessage(chatId, `✅ Updated deadline for <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b> to: <i>${escapeHTML(newDate.toLocaleString('en-IN'))}</i>`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /editdeadline: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to update job deadline.');
  }
});

// /forcepoll
bot.onText(/^\/forcepoll(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const jobText = match[1];

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (!jobText) {
    return await bot.sendMessage(chatId, '⚠️ Please provide the text to parse. Example: `/forcepoll Google hiring SWE Intern apply at url`');
  }

  const processingMsg = await bot.sendMessage(chatId, '🤖 Processing text with Gemini AI...');
  
  try {
    const jobList = await extractJobDetails(jobText);
    
    if (!jobList || jobList.length === 0) {
      return await bot.editMessageText('❌ Failed to extract any valid job details or find application links in the provided text.', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
    }

    await bot.deleteMessage(chatId, processingMsg.message_id);
    
    for (const jobDetails of jobList) {
      await createJobAndPoll(chatId, jobDetails, msg.message_id);
    }
  } catch (err) {
    logger.error('Error in /forcepoll: %s', err.stack);
    await bot.sendMessage(chatId, '❌ An error occurred while force-creating the poll.');
  }
});

// /broadcast
bot.onText(/^\/broadcast(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const broadcastMsg = match[1];

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (!broadcastMsg) {
    return await bot.sendMessage(chatId, '⚠️ Please provide a message to broadcast.');
  }

  try {
    const groups = await Group.find({});
    let successCount = 0;
    
    for (const group of groups) {
      try {
        await bot.sendMessage(group.telegramGroupId, `📢 <b>Broadcast Message:</b>\n\n${escapeHTML(broadcastMsg)}`, { parse_mode: 'HTML' });
        successCount++;
      } catch (err) {
        logger.warn('Failed to send broadcast to group %d: %s', group.telegramGroupId, err.message);
      }
    }
    
    await bot.sendMessage(chatId, `✅ Broadcast sent successfully to ${successCount}/${groups.length} groups.`);
  } catch (err) {
    logger.error('Error in /broadcast: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to broadcast message.');
  }
});

// ----------------------------------------------------
// AUTO JOB DETECTION AND POLL CREATION WORKFLOW
// ----------------------------------------------------

/**
 * Creates job in DB, posts details and starts application tracking poll
 */
async function createJobAndPoll(chatId, jobDetails, originalMessageId) {
  try {
    // Normal duplicate check by normalized URL and Company
    const normalizedUrl = normalizeUrl(jobDetails.applyLink);
    
    const existingJob = await Job.findOne({
      telegramGroupId: chatId,
      applyLink: normalizedUrl,
      status: { $ne: 'archived' }
    });

    if (existingJob) {
      logger.info('Duplicate job detected by URL match: %s', normalizedUrl);
      return await bot.sendMessage(chatId, '⚠️ Opportunity already being tracked. Do not create a new poll.', {
        reply_to_message_id: originalMessageId
      });
    }

    const deadlineFormatted = jobDetails.deadline ? new Date(jobDetails.deadline).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) : 'No Deadline specified';

    const chat = await bot.getChat(chatId);
    const isChannel = chat.type === 'channel';
    const botUser = await bot.getMe();

    const footerText = isChannel 
      ? `⚡ <i>Note: Channel polls are anonymous. Start this bot in <a href="t.me/${botUser.username}">DMs</a> to track and receive personal application alerts!</i>`
      : `⚡ <i>Please vote on the poll below to track your application status. Start this bot in <a href="t.me/${botUser.username}">DMs</a> to receive alerts!</i>`;

    // 1. Send details card
    const jobCardText = `📢 <b>${escapeHTML(jobDetails.company)}</b> - ${escapeHTML(jobDetails.role)}
${jobDetails.location ? `📍 <b>Location:</b> ${escapeHTML(jobDetails.location)}\n` : ''}${jobDetails.salary ? `💰 <b>Salary:</b> ${escapeHTML(jobDetails.salary)}\n` : ''}${jobDetails.batchEligibility ? `🎓 <b>Eligibility:</b> ${escapeHTML(jobDetails.batchEligibility)}\n` : ''}📅 <b>Deadline:</b> <i>${escapeHTML(deadlineFormatted)}</i>
🔗 <a href="${escapeHTML(jobDetails.applyLink)}">Apply Here</a>

${footerText}`;

    const descriptionMsg = await bot.sendMessage(chatId, jobCardText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_to_message_id: originalMessageId
    });

    // 2. Send Poll
    const pollMsg = await bot.sendPoll(chatId, `Have you applied for ${jobDetails.company} - ${jobDetails.role}?`, ['Yes', 'No'], {
      is_anonymous: isChannel,
      reply_to_message_id: descriptionMsg.message_id
    });

    // 3. Save to DB
    const newJob = new Job({
      company: jobDetails.company,
      role: jobDetails.role,
      applyLink: normalizedUrl,
      deadline: jobDetails.deadline,
      location: jobDetails.location,
      salary: jobDetails.salary,
      batchEligibility: jobDetails.batchEligibility,
      telegramMessageId: descriptionMsg.message_id,
      telegramGroupId: chatId,
      telegramPollId: pollMsg.poll.id,
      status: 'active'
    });

    await newJob.save();
    logger.info('Job successfully created and poll launched: %s - %s', newJob.company, newJob.role);

  } catch (err) {
    logger.error('Error creating job and poll: %s', err.stack);
    await bot.sendMessage(chatId, '❌ An error occurred while launching application tracking for this job.');
  }
}

// Group chat message listener for auto job detection
bot.on('message', async (msg) => {
  // Ignore bots or private commands (commands are handled by command handlers)
  if (msg.from && msg.from.is_bot) return;
  
  const text = msg.text || msg.caption;
  if (!text) return;

  const chatId = msg.chat.id;

  // Register group/user (works for both groups and private chats now)
  const groupObj = await registerUserAndGroup(msg);

  // If auto poll is disabled in settings, ignore
  if (groupObj && groupObj.settings && groupObj.settings.autoPollEnabled === false) {
    return;
  }

  // If the message starts with command, ignore this listener
  if (text.startsWith('/')) return;

  // Simple heuristic: trigger if message has a link (e.g. http:// or https://)
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex);

  if (urls && urls.length > 0) {
    logger.info('Detected potential job post in group %d...', chatId);
    
    // Resolve short URLs first to expand bit.ly, tinyurl, etc.
    const resolvedUrls = [];
    for (const url of urls) {
      const expanded = await expandUrl(url);
      resolvedUrls.push(expanded);
    }

    // In-place replace short URLs with expanded ones so Gemini sees the real domain
    let processedText = text;
    urls.forEach((url, i) => {
      processedText = processedText.replace(url, resolvedUrls[i]);
    });

    // Check duplicates using the expanded links
    let duplicateFound = false;
    for (const rawUrl of resolvedUrls) {
      const norm = normalizeUrl(rawUrl);
      const exists = await Job.findOne({
        telegramGroupId: chatId,
        applyLink: norm,
        status: { $ne: 'archived' }
      });
      if (exists) {
        duplicateFound = true;
        break;
      }
    }

    if (duplicateFound) {
      logger.info('URL in message already exists in database, skipping AI parse.');
      return;
    }

    // Process with AI
    const jobList = await extractJobDetails(processedText);
    if (jobList && jobList.length > 0) {
      for (const jobDetails of jobList) {
        await createJobAndPoll(chatId, jobDetails, msg.message_id);
      }
    }
  }
});

// ----------------------------------------------------
// POLL ANSWER TRACKER
// ----------------------------------------------------
bot.on('poll_answer', async (answer) => {
  try {
    const job = await Job.findOne({ telegramPollId: answer.poll_id });
    if (!job) {
      logger.debug('Received poll answer for unknown/untracked poll ID: %s', answer.poll_id);
      return;
    }

    const userId = answer.user.id;
    const username = answer.user.username || '';
    const firstName = answer.user.first_name || '';
    const lastName = answer.user.last_name || '';

    // Register this user as member of the group
    const group = await Group.findOne({ telegramGroupId: job.telegramGroupId });
    if (group) {
      const exists = group.members.some(m => m.userId === userId);
      if (!exists) {
        group.members.push({ userId, username, firstName, lastName });
        await group.save();
      } else {
        const member = group.members.find(m => m.userId === userId);
        if (member.username !== username) {
          member.username = username;
          await group.save();
        }
      }
    }

    if (answer.option_ids.length === 0) {
      // User retracted their vote
      logger.info('User %d (%s) retracted vote for job %s', userId, username, job._id);
      await PollResponse.deleteOne({ jobId: job._id, userId: userId });
    } else {
      // User voted (0 is Yes, 1 is No)
      const vote = answer.option_ids[0] === 0 ? 'yes' : 'no';
      logger.info('User %d (%s) voted "%s" for job %s', userId, username, vote, job._id);
      
      await PollResponse.findOneAndUpdate(
        { jobId: job._id, userId: userId },
        {
          username: username,
          response: vote,
          respondedAt: new Date()
        },
        { upsert: true, new: true }
      );

      // Send instant DM confirmation
      try {
        const dmText = vote === 'yes'
          ? `✅ <b>Applied:</b> <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)}\nReminders disabled. Good luck! 🚀`
          : `⏰ <b>Not Applied:</b> <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)}\nI'll remind you before the deadline. ⏰`;
        
        await bot.sendMessage(userId, dmText, { parse_mode: 'HTML' });
      } catch (dmErr) {
        logger.warn('Could not send instant DM vote confirmation to user %d: %s', userId, dmErr.message);
      }
    }
  } catch (err) {
    logger.error('Error tracking poll answer: %s', err.stack);
  }
});

module.exports = bot;
