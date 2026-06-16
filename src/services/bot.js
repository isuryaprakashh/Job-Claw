const TelegramBot = require('node-telegram-bot-api');
const Job = require('../models/Job');
const PollResponse = require('../models/PollResponse');
const Group = require('../models/Group');
const Reminder = require('../models/Reminder');
const { extractJobDetails } = require('./ai');
const logger = require('../utils/logger');
const { fetchPageContent, isBareLink } = require('../utils/scraper');

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

// Register slash commands menu globally with Telegram
bot.setMyCommands([
  { command: 'jobs', description: 'Display active opportunities' },
  { command: 'jobstats', description: 'Show application stats for a job' },
  { command: 'pending', description: 'Show users who haven\'t applied' },
  { command: 'closed', description: 'Show archived/closed opportunities' },
  { command: 'help', description: 'Display help message' }
]).then(() => {
  logger.info('Telegram Bot commands menu registered successfully.');
}).catch(err => {
  logger.error('Failed to register Telegram Bot commands menu: %s', err.message);
});

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

function formatSettingState(enabled) {
  return enabled ? 'ON' : 'OFF';
}

async function sendSettingsSummary(chatId, group) {
  const settings = group.settings || {};
  const response = `<b>Group Settings</b>

Auto job detection: <b>${formatSettingState(settings.autoPollEnabled !== false)}</b>
DM reminders: <b>${formatSettingState(settings.dmRemindersEnabled !== false)}</b>

Use <code>/autopoll on</code> or <code>/autopoll off</code>
Use <code>/dmreminders on</code> or <code>/dmreminders off</code>`;

  await bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
}

function parseToggleValue(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['on', 'enable', 'enabled', 'true', 'yes'].includes(normalized)) return true;
  if (['off', 'disable', 'disabled', 'false', 'no'].includes(normalized)) return false;
  return null;
}

async function getPendingReminderTargets(chatId, job) {
  const group = await Group.findOne({ telegramGroupId: chatId });
  if (!group) {
    return { group: null, targetUsers: [] };
  }

  const responses = await PollResponse.find({ jobId: job._id });
  const yesVotedUserIds = new Set(responses.filter(r => r.response === 'yes').map(r => r.userId));
  const targetUsers = group.members.filter(member => !yesVotedUserIds.has(member.userId));

  return { group, targetUsers };
}

function buildManualReminderMessage(job) {
  const meta = getOpportunityMeta(job);
  const deadlineFormatted = job.deadline ? new Date(job.deadline).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }) : 'No deadline specified';

  return `🔔 <b>Manual ${escapeHTML(meta.singular)} Reminder</b>

<b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)}
📅 <b>${escapeHTML(meta.deadlineLabel)}:</b> ${escapeHTML(deadlineFormatted)}

Please update the poll after ${escapeHTML(meta.reminderAction)}ing.`;
}

function buildJobActionKeyboard(job) {
  const meta = getOpportunityMeta(job);
  const keyboard = {
    inline_keyboard: [
      [
        { text: `🔗 ${meta.linkText.replace(' Here', ' Now')}`, url: job.applyLink }
      ]
    ]
  };

  if (String(job.telegramGroupId).startsWith('-100')) {
    const cleanGroupId = String(job.telegramGroupId).replace('-100', '');
    const pollLink = `https://t.me/c/${cleanGroupId}/${job.telegramMessageId}`;
    keyboard.inline_keyboard[0].push({ text: '💬 View Poll', url: pollLink });
  }

  return keyboard;
}

function getOpportunityType(item) {
  return item && ['job', 'hackathon', 'competition'].includes(item.opportunityType)
    ? item.opportunityType
    : 'job';
}

function getOpportunityMeta(item) {
  const type = getOpportunityType(item);
  const meta = {
    job: {
      singular: 'Job',
      plural: 'Jobs',
      listTitle: 'Active Job Opportunities',
      companyLabel: 'Company',
      roleLabel: 'Role',
      linkText: 'Apply Here',
      deadlineLabel: 'Deadline',
      pollQuestion: 'Have you applied for',
      yesLabel: 'Applied',
      noLabel: 'Not Applied',
      pendingTitle: 'Pending Applicants',
      reminderAction: 'apply',
      cardIcon: '📢'
    },
    hackathon: {
      singular: 'Hackathon',
      plural: 'Hackathons',
      listTitle: 'Active Hackathons',
      companyLabel: 'Organizer',
      roleLabel: 'Event',
      linkText: 'Register Here',
      deadlineLabel: 'Registration Deadline',
      pollQuestion: 'Have you registered for',
      yesLabel: 'Registered',
      noLabel: 'Not Registered',
      pendingTitle: 'Pending Registrations',
      reminderAction: 'register',
      cardIcon: '🛠️'
    },
    competition: {
      singular: 'Competition',
      plural: 'Competitions',
      listTitle: 'Active Competitions',
      companyLabel: 'Organizer',
      roleLabel: 'Event',
      linkText: 'Register Here',
      deadlineLabel: 'Registration Deadline',
      pollQuestion: 'Have you registered for',
      yesLabel: 'Registered',
      noLabel: 'Not Registered',
      pendingTitle: 'Pending Registrations',
      reminderAction: 'register',
      cardIcon: '🏆'
    }
  };

  return meta[type];
}

async function sendOpportunityList(chatId, opportunityType = null) {
  const allActiveItems = await Job.find({ telegramGroupId: chatId, status: 'active' }).sort({ createdAt: 1 });
  const activeItems = opportunityType
    ? allActiveItems
      .map((item, allIndex) => ({ item, allIndex }))
      .filter(({ item }) => getOpportunityType(item) === opportunityType)
    : allActiveItems.map((item, allIndex) => ({ item, allIndex }));

  if (activeItems.length === 0) {
    const emptyLabel = opportunityType ? getOpportunityMeta({ opportunityType }).plural.toLowerCase() : 'opportunities';
    return await bot.sendMessage(chatId, `📝 No active ${emptyLabel} being tracked right now.`);
  }

  const title = opportunityType ? getOpportunityMeta({ opportunityType }).listTitle : 'Active Opportunities';
  let response = `💼 <b>${escapeHTML(title)}:</b>\n\n`;
  activeItems.forEach(({ item, allIndex }) => {
    const meta = getOpportunityMeta(item);
    const deadlineStr = item.deadline ? new Date(item.deadline).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) : 'No Deadline';
    response += `${allIndex + 1}. <b>${escapeHTML(item.company)}</b> - ${escapeHTML(item.role)} <i>(${escapeHTML(meta.singular)})</i>\n`;
    response += `   📅 ${escapeHTML(meta.deadlineLabel)}: <i>${escapeHTML(deadlineStr)}</i>\n`;
    if (item.eventDate) {
      response += `   🗓️ Event Date: <i>${escapeHTML(new Date(item.eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))}</i>\n`;
    }
    response += `   🔗 <a href="${escapeHTML(item.applyLink)}">${escapeHTML(meta.linkText)}</a>\n\n`;
  });
  response += `💡 Use <code>/jobstats &lt;number&gt;</code>, <code>/pending &lt;number&gt;</code>, or <code>/remindnow &lt;number&gt;</code> for details.`;

  await bot.sendMessage(chatId, response, { parse_mode: 'HTML', disable_web_page_preview: true });
}

// ----------------------------------------------------
// COMMAND HANDLERS
// ----------------------------------------------------

// /help
bot.onText(/^\/help(?:@\w+)?$|^❓ Get Help$/, async (msg) => {
  const chatId = msg.chat.id;
  const botUser = await bot.getMe();
  const helpText = `<b>JobClaw Bot Commands:</b>

👥 <b>Public Commands:</b>
• /opportunities - Display all active opportunities
• /jobs - Display active jobs and internships
• /hackathons - Display active hackathons
• /competitions - Display active competitions
• /jobstats &lt;index/ID&gt; - Show response stats for an opportunity
• /pending &lt;index/ID&gt; - Show users who haven't applied/registered
• /closed - Show archived/closed opportunities
• /help - Display this help message

🔑 <b>Admin Commands:</b>
• /deletejob &lt;index/ID&gt; - Delete an opportunity
• /editdeadline &lt;index/ID&gt; &lt;YYYY-MM-DD HH:MM&gt; - Edit opportunity deadline
• /forcepoll &lt;text&gt; - Manually create a poll from text
• /settings - View group automation settings
• /autopoll on|off - Toggle automatic opportunity detection
• /dmreminders on|off - Toggle deadline/reminder DMs
• /remindnow &lt;index/ID&gt; - DM pending applicants now
• /broadcast &lt;message&gt; - Broadcast message to all groups

💡 <i>Note: To receive Direct Message reminders, please start the bot in private chat by clicking <a href="t.me/${botUser.username}">here</a> and sending /start.</i>`;

  await bot.sendMessage(chatId, helpText, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// /start
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type === 'private') {
    const welcome = `👋 Hello ${escapeHTML(msg.from.first_name || 'there')}!
I am <b>JobClaw</b>, the AI job tracking bot. 

By starting me here, you have enabled <b>Direct Message Reminders</b> for jobs, hackathons, and competitions posted in your placement groups. I will send you reminders before deadlines if you haven't applied or registered!

To list opportunities in your groups, use the bot commands in your group chats. Type /help to see all commands.`;
    
    // Add persistent Reply Keyboard for DMs
    const keyboard = {
      keyboard: [
        [{ text: '💼 Active Jobs' }, { text: '📁 Closed Jobs' }],
        [{ text: '❓ Get Help' }]
      ],
      resize_keyboard: true,
      persistent: true
    };

    await bot.sendMessage(chatId, welcome, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } else {
    await bot.sendMessage(chatId, 'Bot is active! Send /help to see available commands.');
  }
});

// /opportunities
bot.onText(/^\/opportunities(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId);
  } catch (err) {
    logger.error('Error in /opportunities command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active opportunities.');
  }
});

// /jobs
bot.onText(/^\/jobs(?:@\w+)?$|^💼 Active Jobs$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, 'job');
  } catch (err) {
    logger.error('Error in /jobs command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active jobs.');
  }
});

// /hackathons
bot.onText(/^\/hackathons(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, 'hackathon');
  } catch (err) {
    logger.error('Error in /hackathons command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active hackathons.');
  }
});

// /competitions
bot.onText(/^\/competitions(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, 'competition');
  } catch (err) {
    logger.error('Error in /competitions command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active competitions.');
  }
});

// /closed
bot.onText(/^\/closed(?:@\w+)?$|^📁 Closed Jobs$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const closedJobs = await Job.find({
      telegramGroupId: chatId,
      status: { $in: ['closed', 'archived'] }
    }).sort({ createdAt: -1 }).limit(10);

    if (closedJobs.length === 0) {
      return await bot.sendMessage(chatId, '📁 No closed or archived opportunities found.');
    }

    let response = `📁 <b>Recently Closed/Archived Opportunities:</b>\n\n`;
    closedJobs.forEach((job, index) => {
      const meta = getOpportunityMeta(job);
      response += `${index + 1}. <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)} <i>(${escapeHTML(meta.singular)}, ${escapeHTML(job.status.toUpperCase())})</i>\n`;
      response += `   🔗 <a href="${escapeHTML(job.applyLink)}">Link</a>\n\n`;
    });

    await bot.sendMessage(chatId, response, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    logger.error('Error in /closed command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve closed opportunities.');
  }
});

// /jobstats
bot.onText(/^\/jobstats(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const jobRef = match[1];

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID. Example: <code>/jobstats 1</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Opportunity not found. Try running /opportunities to see numbers.');
    }

    const meta = getOpportunityMeta(job);
    const responses = await PollResponse.find({ jobId: job._id });
    const yesCount = responses.filter(r => r.response === 'yes').length;
    const noCount = responses.filter(r => r.response === 'no').length;

    // Estimate no response
    const group = await Group.findOne({ telegramGroupId: chatId });
    const totalMembers = group ? group.members.length : 0;
    const respondedUserIds = new Set(responses.map(r => r.userId));

    // Group members who have not responded
    const noResponseCount = Math.max(0, totalMembers - respondedUserIds.size);

    const deadlineStr = job.deadline ? new Date(job.deadline).toLocaleString('en-IN') : 'N/A';

    const responseMsg = `📊 <b>${escapeHTML(meta.singular)} Response Stats:</b>
    
<b>${escapeHTML(meta.companyLabel)}:</b> ${escapeHTML(job.company)}
<b>${escapeHTML(meta.roleLabel)}:</b> ${escapeHTML(job.role)}
<b>${escapeHTML(meta.deadlineLabel)}:</b> ${escapeHTML(deadlineStr)}
<b>Status:</b> ${escapeHTML(job.status.toUpperCase())}

✅ <b>${escapeHTML(meta.yesLabel)}:</b> ${yesCount}
❌ <b>${escapeHTML(meta.noLabel)}:</b> ${noCount}
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
bot.onText(/^\/pending(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const jobRef = match[1];

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID. Example: <code>/pending 1</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Opportunity not found.');
    }

    const meta = getOpportunityMeta(job);
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

    let responseMsg = `🚨 <b>${escapeHTML(meta.pendingTitle)}</b>
    
<b>${escapeHTML(meta.companyLabel)}:</b> ${escapeHTML(job.company)}
<b>${escapeHTML(meta.roleLabel)}:</b> ${escapeHTML(job.role)}

❌ <b>${escapeHTML(meta.noLabel)} (${votedNoUsernames.length}):</b>
${votedNoUsernames.length > 0 ? escapeHTML(votedNoUsernames.join('\n')) : '<i>None</i>' }

❔ <b>No Response (${noResponseUsernames.length}):</b>
${noResponseUsernames.length > 0 ? escapeHTML(noResponseUsernames.join('\n')) : '<i>None</i>'}`;

    await bot.sendMessage(chatId, responseMsg, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /pending command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to fetch pending applicants.');
  }
});

// ----------------------------------------------------
// ADMIN COMMAND HANDLERS
// ----------------------------------------------------

// /settings
bot.onText(/^\/settings(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  try {
    const group = await Group.findOneAndUpdate(
      { telegramGroupId: chatId },
      {
        $setOnInsert: {
          telegramGroupId: chatId,
          groupName: msg.chat.title || '',
          admins: [userId]
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendSettingsSummary(chatId, group);
  } catch (err) {
    logger.error('Error in /settings: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve group settings.');
  }
});

// /autopoll
bot.onText(/^\/autopoll(?:@\w+)?(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const enabled = parseToggleValue(match[1]);

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (enabled === null) {
    return await bot.sendMessage(chatId, '⚠️ Usage: <code>/autopoll on</code> or <code>/autopoll off</code>', { parse_mode: 'HTML' });
  }

  try {
    const group = await Group.findOneAndUpdate(
      { telegramGroupId: chatId },
      {
        $set: { 'settings.autoPollEnabled': enabled },
        $setOnInsert: {
          telegramGroupId: chatId,
          groupName: msg.chat.title || '',
          admins: [userId]
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await bot.sendMessage(chatId, `✅ Auto job detection is now <b>${formatSettingState(group.settings.autoPollEnabled)}</b>.`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /autopoll: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to update auto job detection setting.');
  }
});

// /dmreminders
bot.onText(/^\/dmreminders(?:@\w+)?(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const enabled = parseToggleValue(match[1]);

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (enabled === null) {
    return await bot.sendMessage(chatId, '⚠️ Usage: <code>/dmreminders on</code> or <code>/dmreminders off</code>', { parse_mode: 'HTML' });
  }

  try {
    const group = await Group.findOneAndUpdate(
      { telegramGroupId: chatId },
      {
        $set: { 'settings.dmRemindersEnabled': enabled },
        $setOnInsert: {
          telegramGroupId: chatId,
          groupName: msg.chat.title || '',
          admins: [userId]
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await bot.sendMessage(chatId, `✅ DM reminders are now <b>${formatSettingState(group.settings.dmRemindersEnabled)}</b>.`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /dmreminders: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to update DM reminder setting.');
  }
});

// /remindnow
bot.onText(/^\/remindnow(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const jobRef = match[1];

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID. Example: <code>/remindnow 1</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef, { status: 'active' });
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Active opportunity not found. Try running /opportunities to see numbers.');
    }

    const meta = getOpportunityMeta(job);
    const { group, targetUsers } = await getPendingReminderTargets(chatId, job);
    if (!group) {
      return await bot.sendMessage(chatId, '❌ This group is not registered yet. Send a regular message first, then try again.');
    }

    if (group.settings && group.settings.dmRemindersEnabled === false) {
      return await bot.sendMessage(chatId, '⚠️ DM reminders are disabled for this group. Use <code>/dmreminders on</code> first.', { parse_mode: 'HTML' });
    }

    if (targetUsers.length === 0) {
      return await bot.sendMessage(chatId, `✅ Everyone tracked has already marked this ${escapeHTML(meta.singular.toLowerCase())} as ${escapeHTML(meta.yesLabel.toLowerCase())}.`);
    }

    let sentCount = 0;
    for (const target of targetUsers) {
      try {
        await bot.sendMessage(target.userId, buildManualReminderMessage(job), {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: buildJobActionKeyboard(job)
        });
        sentCount++;
      } catch (err) {
        logger.warn('Failed to send manual reminder to user %d: %s', target.userId, err.message);
      }
    }

    await bot.sendMessage(chatId, `✅ Manual reminder sent to ${sentCount}/${targetUsers.length} pending users for <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b>.`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /remindnow: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to send manual reminders.');
  }
});

// /deletejob
bot.onText(/^\/deletejob(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
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
      return await bot.sendMessage(chatId, '❌ Opportunity not found.');
    }

    // Delete job, poll responses and reminders
    await Job.deleteOne({ _id: job._id });
    await PollResponse.deleteMany({ jobId: job._id });
    await Reminder.deleteMany({ jobId: job._id });
    
    await bot.sendMessage(chatId, `✅ Successfully deleted opportunity: <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b>`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Error in /deletejob: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to delete job opportunity.');
  }
});

// /editdeadline
bot.onText(/^\/editdeadline(?:@\w+)?(?:\s+(\S+)\s+(.+))?$/, async (msg, match) => {
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
      return await bot.sendMessage(chatId, '❌ Opportunity not found.');
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
bot.onText(/^\/forcepoll(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const jobText = match[1];

  if (!(await checkAdmin(chatId, userId))) {
    return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
  }

  if (!jobText) {
    return await bot.sendMessage(chatId, '⚠️ Please provide the text to parse. Example: `/forcepoll Google hiring SWE Intern apply at url` or `/forcepoll Hackathon registration link...`');
  }

  const processingMsg = await bot.sendMessage(chatId, '🤖 Processing text with Gemini AI...');

  try {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = jobText.match(urlRegex) || [];
    const resolvedUrls = [];
    for (const url of urls) {
      const expanded = await expandUrl(url);
      resolvedUrls.push(expanded);
    }

    let processedText = jobText;
    urls.forEach((url, i) => {
      processedText = processedText.replace(url, resolvedUrls[i]);
    });

    let webpageContexts = [];
    if (isBareLink(processedText, resolvedUrls)) {
      logger.info('Forcepoll text is identified as a bare link. Scraping webpage contents...');
      const fetchPromises = resolvedUrls.map(async (url) => {
        const content = await fetchPageContent(url);
        if (content) {
          return { url, content };
        }
        return null;
      });
      const results = await Promise.all(fetchPromises);
      webpageContexts = results.filter(r => r !== null);
    }

    const jobList = await extractJobDetails(processedText, webpageContexts);

    if (!jobList || jobList.length === 0) {
      return await bot.editMessageText('❌ Failed to extract any valid opportunity details or find application links in the provided text.', {
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
bot.onText(/^\/broadcast(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
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
// AUTO OPPORTUNITY DETECTION AND POLL CREATION WORKFLOW
// ----------------------------------------------------

/**
 * Creates opportunity in DB, posts details and starts tracking poll
 */
async function createJobAndPoll(chatId, jobDetails, originalMessageId) {
  try {
    const meta = getOpportunityMeta(jobDetails);
    // Normal duplicate check by normalized URL and Company
    const normalizedUrl = normalizeUrl(jobDetails.applyLink);

    const existingJob = await Job.findOne({
      telegramGroupId: chatId,
      applyLink: normalizedUrl,
      status: { $ne: 'archived' }
    });

    if (existingJob) {
      logger.info('Duplicate opportunity detected by URL match: %s', normalizedUrl);
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
      ? `⚡ <i>Note: Channel polls are anonymous. Start this bot in <a href="t.me/${botUser.username}">DMs</a> to track and receive personal alerts!</i>`
      : `⚡ <i>Please vote on the poll below to track your status. Start this bot in <a href="t.me/${botUser.username}">DMs</a> to receive alerts!</i>`;

    // 1. Send details card
    const jobCardText = `${meta.cardIcon} <b>${escapeHTML(jobDetails.company)}</b> - ${escapeHTML(jobDetails.role)}
<b>Type:</b> ${escapeHTML(meta.singular)}
${jobDetails.location ? `📍 <b>Location:</b> ${escapeHTML(jobDetails.location)}\n` : ''}${jobDetails.format ? `🧭 <b>Format:</b> ${escapeHTML(jobDetails.format)}\n` : ''}${jobDetails.salary ? `💰 <b>Compensation:</b> ${escapeHTML(jobDetails.salary)}\n` : ''}${jobDetails.prize ? `🏆 <b>Prize/Rewards:</b> ${escapeHTML(jobDetails.prize)}\n` : ''}${jobDetails.batchEligibility ? `🎓 <b>Eligibility:</b> ${escapeHTML(jobDetails.batchEligibility)}\n` : ''}${jobDetails.eventDate ? `🗓️ <b>Event Date:</b> <i>${escapeHTML(new Date(jobDetails.eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))}</i>\n` : ''}📅 <b>${escapeHTML(meta.deadlineLabel)}:</b> <i>${escapeHTML(deadlineFormatted)}</i>
🔗 <a href="${escapeHTML(jobDetails.applyLink)}">${escapeHTML(meta.linkText)}</a>

${footerText}`;

    const descriptionMsg = await bot.sendMessage(chatId, jobCardText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_to_message_id: originalMessageId
    });

    // 2. Send Poll
    const pollMsg = await bot.sendPoll(chatId, `${meta.pollQuestion} ${jobDetails.company} - ${jobDetails.role}?`, ['Yes', 'No'], {
      is_anonymous: isChannel,
      reply_to_message_id: descriptionMsg.message_id
    });

    // 3. Save to DB
    const newJob = new Job({
      opportunityType: getOpportunityType(jobDetails),
      company: jobDetails.company,
      role: jobDetails.role,
      applyLink: normalizedUrl,
      deadline: jobDetails.deadline,
      location: jobDetails.location,
      salary: jobDetails.salary,
      batchEligibility: jobDetails.batchEligibility,
      prize: jobDetails.prize,
      eventDate: jobDetails.eventDate,
      format: jobDetails.format,
      telegramMessageId: descriptionMsg.message_id,
      telegramGroupId: chatId,
      telegramPollId: pollMsg.poll.id,
      status: 'active'
    });

    await newJob.save();
    logger.info('Opportunity successfully created and poll launched: %s - %s', newJob.company, newJob.role);

  } catch (err) {
    logger.error('Error creating opportunity and poll: %s', err.stack);
    await bot.sendMessage(chatId, '❌ An error occurred while launching tracking for this opportunity.');
  }
}

// Group chat message listener for auto opportunity detection
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
    logger.info('Detected potential opportunity post in group %d...', chatId);
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

    // Process with AI (conditionally scraping webpage contents)
    let webpageContexts = [];
    if (isBareLink(processedText, resolvedUrls)) {
      logger.info('Message is identified as a bare link. Scraping webpage contents...');
      const fetchPromises = resolvedUrls.map(async (url) => {
        const content = await fetchPageContent(url);
        if (content) {
          return { url, content };
        }
        return null;
      });
      const results = await Promise.all(fetchPromises);
      webpageContexts = results.filter(r => r !== null);
    } else {
      logger.info('Message has sufficient context. Skipping webpage scraping.');
    }

    const jobList = await extractJobDetails(processedText, webpageContexts);
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
        const meta = getOpportunityMeta(job);
        const dmText = vote === 'yes'
          ? `✅ <b>${escapeHTML(meta.yesLabel)}:</b> <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)}\nReminders disabled. Good luck! 🚀`
          : `⏰ <b>${escapeHTML(meta.noLabel)}:</b> <b>${escapeHTML(job.company)}</b> - ${escapeHTML(job.role)}\nI'll remind you before the deadline. ⏰`;
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
