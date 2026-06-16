const TelegramBot = require('node-telegram-bot-api');
const Job = require('../models/Job');
const PollResponse = require('../models/PollResponse');
const Group = require('../models/Group');
const Reminder = require('../models/Reminder');
const { extractJobDetails } = require('./ai');
const logger = require('../utils/logger');
const { fetchPageContent, isBareLink, parseMetadataDirectly } = require('../utils/scraper');

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

// Register slash commands menu globally and for all group chats with Telegram
const globalCommands = [
  { command: 'menu', description: 'Open the main interactive menu' },
  { command: 'jobs', description: 'Display active opportunities' },
  { command: 'jobstats', description: 'Show application stats for a job' },
  { command: 'pending', description: 'Show users who haven\'t applied' },
  { command: 'closed', description: 'Show archived/closed opportunities' },
  { command: 'help', description: 'Display help message' }
];

Promise.all([
  bot.setMyCommands(globalCommands, { scope: { type: 'default' } }),
  bot.setMyCommands(globalCommands, { scope: { type: 'all_group_chats' } })
]).then(() => {
  logger.info('Telegram Bot commands menu registered successfully for default and group scopes.');
}).catch(err => {
  logger.error('Failed to register Telegram Bot commands menu: %s', err.message);
});

// Run migration to assign jobIndex to existing jobs
migrateJobIndices().catch(err => {
  logger.error('Failed to run job index migration: %s', err.stack);
});

// Store active command contexts or tracking flags if needed
logger.info('Telegram Bot initialized and polling started.');

// Redirect channel posts to the message event so commands and auto-poll detection work in Channels too
bot.on('channel_post', (msg) => {
  bot.emit('message', msg);
});

/**
 * Helper to check if a user is admin of the group (or a target group if called from DM)
 */
async function checkAdmin(chatId, userId, targetGroupId = null) {
  const effectiveGroupId = (chatId > 0 && targetGroupId) ? targetGroupId : chatId;
  if (effectiveGroupId > 0) return true; // Private chats have no group admins
  try {
    const admins = await bot.getChatAdministrators(effectiveGroupId);
    return admins.some(member => member.user.id === userId);
  } catch (err) {
    logger.warn('Error checking Telegram admins for chat %d: %s. Fallback to DB check.', effectiveGroupId, err.message);
    const group = await Group.findOne({ telegramGroupId: effectiveGroupId });
    if (group && group.admins.includes(userId)) {
      return true;
    }
    return false;
  }
}

/**
 * Synchronizes the user's membership across all known groups
 */
async function syncUserGroups(userId) {
  try {
    const groups = await Group.find({});
    for (const group of groups) {
      // Check if user is already in group.members
      const isRegistered = group.members.some(m => m.userId === userId);
      if (isRegistered) continue;

      // If not registered, check Telegram API
      try {
        const member = await bot.getChatMember(group.telegramGroupId, userId);
        const activeStatuses = ['creator', 'administrator', 'member', 'restricted'];
        if (member && activeStatuses.includes(member.status)) {
          // Add them atomically
          await Group.findOneAndUpdate(
            { 
              telegramGroupId: group.telegramGroupId,
              'members.userId': { $ne: userId }
            },
            {
              $push: {
                members: {
                  userId: userId,
                  username: member.user.username || '',
                  firstName: member.user.first_name || '',
                  lastName: member.user.last_name || ''
                }
              }
            }
          );
          logger.info('Dynamically registered user %d in group %d via sync', userId, group.telegramGroupId);
        }
      } catch (err) {
        // Ignore errors (e.g., bot kicked or user not found)
      }
    }
  } catch (err) {
    logger.error('Error in syncUserGroups: %s', err.stack);
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
      let groupAdmins = [];
      if (isGroup) {
        try {
          const admins = await bot.getChatAdministrators(chatId);
          groupAdmins = admins.map(a => a.user.id);
        } catch (e) {
          logger.warn('Could not load administrators initially: %s', e.message);
        }
      } else {
        groupAdmins = [msg.from.id];
      }

      group = await Group.findOneAndUpdate(
        { telegramGroupId: chatId },
        {
          $setOnInsert: {
            telegramGroupId: chatId,
            groupName: isGroup ? (msg.chat.title || '') : `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
            admins: groupAdmins,
            members: []
          }
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );
    }

    const sender = msg.from;
    if (sender && !sender.is_bot) {
      // 1. Try to update name/username if the member already exists
      const updated = await Group.findOneAndUpdate(
        { 
          telegramGroupId: chatId, 
          'members.userId': sender.id 
        },
        { 
          $set: { 
            'members.$.username': sender.username || '',
            'members.$.firstName': sender.first_name || '',
            'members.$.lastName': sender.last_name || ''
          } 
        },
        { returnDocument: 'after' }
      );

      // 2. If member did not exist, push atomically
      if (!updated) {
        group = await Group.findOneAndUpdate(
          { 
            telegramGroupId: chatId,
            'members.userId': { $ne: sender.id } 
          },
          {
            $push: {
              members: {
                userId: sender.id,
                username: sender.username || '',
                firstName: sender.first_name || '',
                lastName: sender.last_name || ''
              }
            }
          },
          { returnDocument: 'after' }
        );
      } else {
        group = updated;
      }
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
 * Backfills sequential jobIndex values for existing jobs in each Telegram group
 */
async function migrateJobIndices() {
  logger.info('Starting Telegram job index migration...');
  const groups = await Job.distinct('telegramGroupId');
  let migratedCount = 0;
  for (const groupId of groups) {
    const jobs = await Job.find({ telegramGroupId: groupId }).sort({ createdAt: 1 });
    for (let i = 0; i < jobs.length; i++) {
      if (jobs[i].jobIndex === undefined || jobs[i].jobIndex === null) {
        jobs[i].jobIndex = i + 1;
        await jobs[i].save();
        migratedCount++;
      }
    }
  }
  if (migratedCount > 0) {
    logger.info('Job index migration completed. Migrated %d jobs.', migratedCount);
  } else {
    logger.info('Job index migration completed. No jobs needed migration.');
  }
}

/**
 * Finds a job using reference string (index in list or mongo ID)
 */
async function findJobByRef(chatId, jobRef, statusFilter = {}, userId = null) {
  const cleanRef = jobRef.trim();
  let groupQuery = { telegramGroupId: chatId };

  // If called in DMs, find jobs across all groups the user belongs to
  if (chatId > 0 && userId) {
    const userGroups = await Group.find({ 'members.userId': userId });
    const groupIds = userGroups.map(g => g.telegramGroupId);
    groupQuery = { telegramGroupId: { $in: groupIds } };
  }

  // If it's a valid MongoDB ObjectId
  if (/^[0-9a-fA-F]{24}$/.test(cleanRef)) {
    return await Job.findOne({ _id: cleanRef, ...groupQuery, ...statusFilter });
  }

  // If it's a number (index)
  const index = parseInt(cleanRef, 10);
  if (!isNaN(index) && index > 0) {
    if (chatId > 0 && userId) {
      // Sync membership in background
      syncUserGroups(userId).catch(err => logger.error('Error in background syncUserGroups: %s', err.stack));

      const userGroups = await Group.find({ 'members.userId': userId });
      const groupIds = userGroups.map(g => g.telegramGroupId);

      // Check if closed status filter is requested
      const isClosedRequest = statusFilter.status && (
        statusFilter.status === 'closed' ||
        statusFilter.status === 'archived' ||
        (statusFilter.status.$in && (statusFilter.status.$in.includes('closed') || statusFilter.status.$in.includes('archived')))
      );

      const query = {
        telegramGroupId: { $in: groupIds },
        status: isClosedRequest ? { $in: ['closed', 'archived'] } : 'active'
      };

      const jobs = await Job.find(query).sort({ createdAt: isClosedRequest ? -1 : 1 });
      if (index <= jobs.length) {
        return jobs[index - 1];
      }

      // If no status filter was explicitly requested and active lookup failed, fallback to closed jobs
      if (!statusFilter.status) {
        const closedQuery = {
          telegramGroupId: { $in: groupIds },
          status: { $in: ['closed', 'archived'] }
        };
        const closedJobs = await Job.find(closedQuery).sort({ createdAt: -1 });
        if (index <= closedJobs.length) {
          return closedJobs[index - 1];
        }
      }
      return null;
    } else {
      return await Job.findOne({ ...groupQuery, jobIndex: index, ...statusFilter });
    }
  }

  return null;
}

function formatSettingState(enabled) {
  return enabled ? 'ON' : 'OFF';
}

async function sendSettingsSummary(chatId, group, messageId = null) {
  const settings = group.settings || {};
  const autoPollActive = settings.autoPollEnabled !== false;
  const dmRemindersActive = settings.dmRemindersEnabled !== false;

  const response = `⚙️ <b>Group Control Panel</b>

Configure the bot's automation and notification options for this group:

🤖 <b>Auto Opportunity Detection:</b> <b>${formatSettingState(autoPollActive)}</b>
<i>Scrapes and creates application polls from group messages automatically.</i>

🔔 <b>Direct Message Reminders:</b> <b>${formatSettingState(dmRemindersActive)}</b>
<i>Sends personalized DM alerts to users before application deadlines.</i>`;

  const inlineKeyboard = [
    [
      {
        text: `🤖 Auto Poll: ${autoPollActive ? '🟢 ON' : '🔴 OFF'}`,
        callback_data: 'toggle_autopoll'
      }
    ],
    [
      {
        text: `🔔 DM Reminders: ${dmRemindersActive ? '🟢 ON' : '🔴 OFF'}`,
        callback_data: 'toggle_dmreminders'
      }
    ],
    [
      {
        text: '⬅️ Back to Menu',
        callback_data: 'back_to_menu'
      }
    ]
  ];

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };

  if (messageId) {
    await bot.editMessageText(response, { chat_id: chatId, message_id: messageId, ...options });
  } else {
    await bot.sendMessage(chatId, response, options);
  }
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

async function sendOpportunityList(chatId, opportunityType = null, messageId = null, isClosed = false, userId = null) {
  let groupQuery = { telegramGroupId: chatId };
  const isDM = chatId > 0;

  // If called in DMs, query jobs from all groups this user belongs to
  if (isDM && userId) {
    // Sync membership in background
    syncUserGroups(userId).catch(err => logger.error('Error in background syncUserGroups: %s', err.stack));

    const userGroups = await Group.find({ 'members.userId': userId });
    const groupIds = userGroups.map(g => g.telegramGroupId);
    groupQuery = { telegramGroupId: { $in: groupIds } };
  }

  const query = { 
    ...groupQuery,
    status: isClosed ? { $in: ['closed', 'archived'] } : 'active' 
  };

  const allItems = await Job.find(query).sort({ createdAt: isClosed ? -1 : 1 });
  
  // Apply limit for closed opportunities to avoid massive messages
  const itemsToProcess = isClosed ? allItems.slice(0, 15) : allItems;

  const activeItems = opportunityType
    ? itemsToProcess.filter((item) => getOpportunityType(item) === opportunityType)
    : itemsToProcess;

  if (activeItems.length === 0) {
    const emptyLabel = opportunityType ? getOpportunityMeta({ opportunityType }).plural.toLowerCase() : 'opportunities';
    const statusText = isClosed ? 'closed/archived' : 'active';
    const emptyText = `📝 No ${statusText} ${emptyLabel} being tracked right now.`;
    
    const options = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Menu', callback_data: 'back_to_menu' }]
        ]
      }
    };

    if (messageId) {
      return await bot.editMessageText(emptyText, { chat_id: chatId, message_id: messageId, ...options });
    } else {
      return await bot.sendMessage(chatId, emptyText, options);
    }
  }

  const title = isClosed
    ? (opportunityType ? `Recently Closed ${getOpportunityMeta({ opportunityType }).plural}` : 'Recently Closed Opportunities')
    : (opportunityType ? getOpportunityMeta({ opportunityType }).listTitle : 'Active Opportunities');

  let response = `💼 <b>${escapeHTML(title)}:</b>\n\n`;
  activeItems.forEach((item, index) => {
    const meta = getOpportunityMeta(item);
    const deadlineStr = item.deadline ? new Date(item.deadline).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) : 'No Deadline';
    const displayNum = isDM ? (index + 1) : item.jobIndex;
    response += `#${displayNum}. <b>${escapeHTML(item.company)}</b> - ${escapeHTML(item.role)} <i>(${escapeHTML(meta.singular)})</i>\n`;
    response += `   📅 ${escapeHTML(meta.deadlineLabel)}: <i>${escapeHTML(deadlineStr)}</i>\n`;
    if (item.eventDate) {
      response += `   🗓️ Event Date: <i>${escapeHTML(new Date(item.eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))}</i>\n`;
    }
    response += `   🔗 <a href="${escapeHTML(item.applyLink)}">${escapeHTML(meta.linkText)}</a>\n\n`;
  });

  // Build inline keyboard for active/closed items
  const inlineKeyboard = [];
  const buttons = activeItems.map((item, index) => {
    const displayNum = isDM ? (index + 1) : item.jobIndex;
    return {
      text: `#${displayNum}. ${item.company}`,
      callback_data: `view_job:${item._id}:${opportunityType || ''}:${isClosed ? '1' : ''}`
    };
  });

  // Group buttons in rows of 2
  for (let i = 0; i < buttons.length; i += 2) {
    inlineKeyboard.push(buttons.slice(i, i + 2));
  }

  // Always append a Back to Menu button
  inlineKeyboard.push([{ text: '⬅️ Back to Menu', callback_data: 'back_to_menu' }]);

  const options = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };

  if (messageId) {
    await bot.editMessageText(response, { chat_id: chatId, message_id: messageId, ...options });
  } else {
    await bot.sendMessage(chatId, response, options);
  }
}

async function sendMainMenu(chatId, messageId = null, userId = null) {
  const text = `🤖 <b>JobClaw Main Menu</b>\n\nSelect an option below to manage and track opportunities:`;
  const inlineKeyboard = [
    [
      { text: '💼 Active Jobs', callback_data: 'menu_jobs' },
      { text: '🛠️ Hackathons', callback_data: 'menu_hackathons' }
    ],
    [
      { text: '🏆 Competitions', callback_data: 'menu_competitions' },
      { text: '📁 Closed Ops', callback_data: 'menu_closed' }
    ],
    [
      { text: '⚙️ Settings', callback_data: 'menu_settings' },
      { text: '❓ Help', callback_data: 'menu_help' }
    ]
  ];

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };

  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
  } else {
    await bot.sendMessage(chatId, text, options);
  }
}

// ----------------------------------------------------
// COMMAND HANDLERS
// ----------------------------------------------------

// /menu
bot.onText(/^\/menu(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendMainMenu(chatId, null, msg.from.id);
  } catch (err) {
    logger.error('Error in /menu command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to open main menu.');
  }
});

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

💡 <i>Note: To receive Direct Message reminders, please start the bot in private chat by clicking <a href="t.me/${botUser.username}">here</a> and sending /start.</i>`;

  await bot.sendMessage(chatId, helpText, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// /start
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    keyboard: [
      [{ text: '💼 Active Jobs' }, { text: '📁 Closed Jobs' }],
      [{ text: '❓ Get Help' }]
    ],
    resize_keyboard: true,
    persistent: true
  };

  if (msg.chat.type === 'private') {
    const userId = msg.from.id;
    await syncUserGroups(userId);

    const welcome = `👋 Hello ${escapeHTML(msg.from.first_name || 'there')}!
I am <b>JobClaw</b>, the AI job tracking bot. 

By starting me here, you have enabled <b>Direct Message Reminders</b> for jobs, hackathons, and competitions posted in your placement groups. I will send you reminders before deadlines if you haven't applied or registered!

To list opportunities in your groups, use the bot commands in your group chats. Type /help to see all commands.`;

    await bot.sendMessage(chatId, welcome, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } else {
    await registerUserAndGroup(msg);
    const welcomeGroup = `👋 Hello! I am <b>JobClaw</b>, the AI job tracking bot. 

I will track opportunities posted in this group and send deadline alerts! Admin settings can be configured using /settings. Check out available commands and options using the interactive menu below:`;

    const inlineKeyboard = [
      [
        { text: '💼 Active Jobs', callback_data: 'menu_jobs' },
        { text: '🛠️ Hackathons', callback_data: 'menu_hackathons' }
      ],
      [
        { text: '🏆 Competitions', callback_data: 'menu_competitions' },
        { text: '📁 Closed Opportunities', callback_data: 'menu_closed' }
      ],
      [
        { text: '⚙️ Settings', callback_data: 'menu_settings' },
        { text: '❓ Help', callback_data: 'menu_help' }
      ]
    ];

    await bot.sendMessage(chatId, welcomeGroup, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  }
});

// /opportunities
bot.onText(/^\/opportunities(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, null, null, false, msg.from.id);
  } catch (err) {
    logger.error('Error in /opportunities command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active opportunities.');
  }
});

// /jobs
bot.onText(/^\/jobs(?:@\w+)?$|^💼 Active Jobs$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, 'job', null, false, msg.from.id);
  } catch (err) {
    logger.error('Error in /jobs command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active jobs.');
  }
});

// /hackathons
bot.onText(/^\/hackathons(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, 'hackathon', null, false, msg.from.id);
  } catch (err) {
    logger.error('Error in /hackathons command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active hackathons.');
  }
});

// /competitions
bot.onText(/^\/competitions(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, 'competition', null, false, msg.from.id);
  } catch (err) {
    logger.error('Error in /competitions command: %s', err.stack);
    await bot.sendMessage(chatId, '❌ Failed to retrieve active competitions.');
  }
});

// /closed
bot.onText(/^\/closed(?:@\w+)?$|^📁 Closed Jobs$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendOpportunityList(chatId, null, null, true, msg.from.id);
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
    const job = await findJobByRef(chatId, jobRef, {}, msg.from.id);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Opportunity not found. Try running /opportunities to see numbers.');
    }

    const meta = getOpportunityMeta(job);
    const responses = await PollResponse.find({ jobId: job._id });
    const yesCount = responses.filter(r => r.response === 'yes').length;
    const noCount = responses.filter(r => r.response === 'no').length;

    // Estimate no response
    const group = await Group.findOne({ telegramGroupId: job.telegramGroupId });
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
    const job = await findJobByRef(chatId, jobRef, {}, msg.from.id);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Opportunity not found.');
    }

    const meta = getOpportunityMeta(job);
    const responses = await PollResponse.find({ jobId: job._id });
    const votedNoUsernames = responses.filter(r => r.response === 'no').map(r => r.username ? `@${r.username}` : `User(${r.userId})`);

    // Get no-response users
    const group = await Group.findOne({ telegramGroupId: job.telegramGroupId });
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

  if (chatId > 0) {
    return await bot.sendMessage(chatId, '⚠️ Group control settings can only be configured inside your group chats.');
  }

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
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
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

  if (chatId > 0) {
    return await bot.sendMessage(chatId, '⚠️ Group control settings can only be configured inside your group chats.');
  }

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
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
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

  if (chatId > 0) {
    return await bot.sendMessage(chatId, '⚠️ Group control settings can only be configured inside your group chats.');
  }

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
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
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

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID. Example: <code>/remindnow 1</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef, { status: 'active' }, userId);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Active opportunity not found. Try running /opportunities to see numbers.');
    }

    if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
      return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
    }

    const meta = getOpportunityMeta(job);
    const { group, targetUsers } = await getPendingReminderTargets(job.telegramGroupId, job);
    if (!group) {
      return await bot.sendMessage(chatId, '❌ This group is not registered yet.');
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

  if (!jobRef) {
    return await bot.sendMessage(chatId, '⚠️ Please specify a job number or ID to delete.');
  }

  try {
    const job = await findJobByRef(chatId, jobRef, {}, userId);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Opportunity not found.');
    }

    if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
      return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
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

  if (!jobRef || !dateStr) {
    return await bot.sendMessage(chatId, '⚠️ Usage: <code>/editdeadline &lt;number/ID&gt; &lt;YYYY-MM-DD HH:MM&gt;</code>', { parse_mode: 'HTML' });
  }

  try {
    const job = await findJobByRef(chatId, jobRef, {}, userId);
    if (!job) {
      return await bot.sendMessage(chatId, '❌ Opportunity not found.');
    }

    if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
      return await bot.sendMessage(chatId, '⛔ Only group administrators can use this command.');
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

  if (chatId > 0) {
    return await bot.sendMessage(chatId, '⚠️ Opportunities can only be tracked/polled inside group chats.');
  }

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
    let directDetails = null;

    if (isBareLink(processedText, resolvedUrls)) {
      if (resolvedUrls.length === 1) {
        logger.info('Forcepoll text is identified as a single bare link. Attempting direct metadata parse...');
        directDetails = await parseMetadataDirectly(resolvedUrls[0]);
      }

      if (directDetails) {
        logger.info('Direct metadata parse succeeded! Skipping Gemini AI.');
      } else {
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
    }

    let jobList = [];
    if (directDetails) {
      jobList = [directDetails];
    } else {
      jobList = await extractJobDetails(processedText, webpageContexts);
    }

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

    const lastJob = await Job.findOne({ telegramGroupId: chatId }).sort({ jobIndex: -1 });
    const nextIndex = lastJob && lastJob.jobIndex ? lastJob.jobIndex + 1 : 1;

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
      status: 'active',
      jobIndex: nextIndex
    });

    await newJob.save();
    logger.info('Opportunity successfully created and poll launched: %s - %s (Index: %d)', newJob.company, newJob.role, nextIndex);

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
  const isGroupOrChannel = msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel';

  // Register group/user (works for both groups and private chats now)
  const groupObj = await registerUserAndGroup(msg);

  if (!isGroupOrChannel) {
    return; // Skip auto opportunity parsing inside private DMs
  }

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

    // Attempt direct metadata parsing first to avoid calling Gemini
    let webpageContexts = [];
    let directDetails = null;

    if (isBareLink(processedText, resolvedUrls)) {
      if (resolvedUrls.length === 1) {
        logger.info('Message identified as a single bare link. Attempting direct metadata parse...');
        directDetails = await parseMetadataDirectly(resolvedUrls[0]);
      }

      if (directDetails) {
        logger.info('Direct metadata parsing succeeded! Skipping Gemini AI: %o', directDetails);
      } else {
        logger.info('Direct metadata parsing failed or not confident. Scraping webpage contents...');
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
    } else {
      logger.info('Message has sufficient context. Skipping webpage scraping.');
    }

    let jobList = [];
    if (directDetails) {
      jobList = [directDetails];
    } else {
      jobList = await extractJobDetails(processedText, webpageContexts);
    }

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

    // Register this user as member of the group atomically
    const updated = await Group.findOneAndUpdate(
      { 
        telegramGroupId: job.telegramGroupId, 
        'members.userId': userId 
      },
      { 
        $set: { 
          'members.$.username': username,
          'members.$.firstName': firstName,
          'members.$.lastName': lastName
        } 
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      await Group.findOneAndUpdate(
        { 
          telegramGroupId: job.telegramGroupId,
          'members.userId': { $ne: userId } 
        },
        {
          $push: {
            members: {
              userId: userId,
              username: username,
              firstName: firstName,
              lastName: lastName
            }
          }
        }
      );
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
        { upsert: true, returnDocument: 'after' }
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

// ----------------------------------------------------
// INTERACTIVE CALLBACK QUERY ACCESSIBILITY & SECURITY VERIFIER
// ----------------------------------------------------
async function getJobAndVerifyAccess(chatId, jobId, userId) {
  const job = await Job.findById(jobId);
  if (!job) return null;

  if (chatId > 0) {
    // DM chat: verify the user is a member of the group where the job belongs
    const group = await Group.findOne({ telegramGroupId: job.telegramGroupId, 'members.userId': userId });
    if (!group) return null;
  } else {
    // Group chat: verify the job belongs to the current group
    if (job.telegramGroupId !== chatId) return null;
  }
  return job;
}

// ----------------------------------------------------
// INTERACTIVE CALLBACK QUERY DETAILS RENDERER
// ----------------------------------------------------
async function renderJobDetails(chatId, jobId, optType, isClosed, messageId, callbackQueryId, userId) {
  const job = await getJobAndVerifyAccess(chatId, jobId, userId);
  if (!job) {
    return await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Opportunity not found or access denied.', show_alert: true });
  }

  const meta = getOpportunityMeta(job);
  const deadlineStr = job.deadline ? new Date(job.deadline).toLocaleString('en-IN') : 'N/A';

  // Compute responses summary
  const responses = await PollResponse.find({ jobId: job._id });
  const yesCount = responses.filter(r => r.response === 'yes').length;
  const noCount = responses.filter(r => r.response === 'no').length;

  let detailMsg = `${meta.cardIcon} <b>${escapeHTML(meta.singular)} Details:</b> (Permanent ID: #${job.jobIndex})

<b>${escapeHTML(meta.companyLabel)}:</b> ${escapeHTML(job.company)}
<b>${escapeHTML(meta.roleLabel)}:</b> ${escapeHTML(job.role)}
`;

  if (job.location) detailMsg += `📍 <b>Location:</b> ${escapeHTML(job.location)}\n`;
  if (job.salary) detailMsg += `💵 <b>Compensation:</b> ${escapeHTML(job.salary)}\n`;
  if (job.batchEligibility) detailMsg += `🎓 <b>Eligibility:</b> ${escapeHTML(job.batchEligibility)}\n`;
  if (job.prize) detailMsg += `🎁 <b>Prize Pool:</b> ${escapeHTML(job.prize)}\n`;
  if (job.format) detailMsg += `🖥️ <b>Format:</b> ${escapeHTML(job.format)}\n`;
  if (job.eventDate) {
    detailMsg += `🗓️ <b>Event Date:</b> ${escapeHTML(new Date(job.eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))}\n`;
  }

  detailMsg += `📅 <b>${escapeHTML(meta.deadlineLabel)}:</b> ${escapeHTML(deadlineStr)}
<b>Status:</b> ${escapeHTML(job.status.toUpperCase())}

📊 <b>Responses:</b> ✅ ${yesCount} | ❌ ${noCount}

🔗 <a href="${escapeHTML(job.applyLink)}">${escapeHTML(meta.linkText)}</a>`;

  const isJobActive = job.status === 'active';

  const inlineKeyboard = [
    [
      { text: '📊 Stats', callback_data: `stats:${jobId}:${optType}:${isClosed}` },
      { text: '🚨 Pending', callback_data: `pending:${jobId}:${optType}:${isClosed}` }
    ],
    [
      { text: '⏰ Remind Now', callback_data: `remind:${jobId}:${optType}:${isClosed}` },
      { text: '📅 Edit Deadline', callback_data: `edit_deadline_prompt:${jobId}:${optType}:${isClosed}` }
    ],
    [
      isJobActive
        ? { text: '📁 Archive', callback_data: `archive_job:${jobId}:${optType}:${isClosed}` }
        : { text: '🔓 Reopen', callback_data: `reopen_job:${jobId}:${optType}:${isClosed}` },
      { text: '🗑️ Delete', callback_data: `delete_prompt:${jobId}:${optType}:${isClosed}` }
    ],
    [
      { text: '⬅️ Back to List', callback_data: `back_to_list:${optType}:${isClosed}` }
    ]
  ];

  await bot.editMessageText(detailMsg, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
  await bot.answerCallbackQuery(callbackQueryId);
}

// ----------------------------------------------------
// INTERACTIVE CALLBACK QUERY HANDLER (INLINE BUTTON MENUS)
// ----------------------------------------------------
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const chatId = msg.chat.id;

  try {
    if (data === 'back_to_menu') {
      await sendMainMenu(chatId, msg.message_id, userId);
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'menu_jobs') {
      await sendOpportunityList(chatId, 'job', msg.message_id, false, userId);
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'menu_hackathons') {
      await sendOpportunityList(chatId, 'hackathon', msg.message_id, false, userId);
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'menu_competitions') {
      await sendOpportunityList(chatId, 'competition', msg.message_id, false, userId);
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'menu_closed') {
      await sendOpportunityList(chatId, null, msg.message_id, true, userId);
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'menu_help') {
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

💡 <i>Note: To receive Direct Message reminders, please start the bot in private chat by clicking <a href="t.me/${botUser.username}">here</a> and sending /start.</i>`;

      const inlineKeyboard = [
        [{ text: '⬅️ Back to Menu', callback_data: 'back_to_menu' }]
      ];
      await bot.editMessageText(helpText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'menu_settings') {
      if (chatId > 0) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⚠️ Group control settings can only be configured inside group chats.',
          show_alert: true
        });
      }
      if (!(await checkAdmin(chatId, userId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can configure settings.',
          show_alert: true
        });
      }
      const groupObj = await Group.findOne({ telegramGroupId: chatId });
      if (!groupObj) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '❌ Group settings not found.',
          show_alert: true
        });
      }
      await sendSettingsSummary(chatId, groupObj, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data.startsWith('view_job:')) {
      const parts = data.split(':');
      const jobId = parts[1];
      const optType = parts[2] || '';
      const isClosed = parts[3] || '';

      await renderJobDetails(chatId, jobId, optType, isClosed, msg.message_id, callbackQuery.id, userId);

    } else if (data.startsWith('stats:')) {
      const parts = data.split(':');
      const jobId = parts[1];
      const optType = parts[2] || '';
      const isClosed = parts[3] || '';

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Opportunity not found or access denied.', show_alert: true });
      }

      const meta = getOpportunityMeta(job);
      const responses = await PollResponse.find({ jobId: job._id });
      const yesCount = responses.filter(r => r.response === 'yes').length;
      const noCount = responses.filter(r => r.response === 'no').length;

      const group = await Group.findOne({ telegramGroupId: job.telegramGroupId });
      const totalMembers = group ? group.members.length : 0;
      const respondedUserIds = new Set(responses.map(r => r.userId));
      const noResponseCount = Math.max(0, totalMembers - respondedUserIds.size);

      const deadlineStr = job.deadline ? new Date(job.deadline).toLocaleString('en-IN') : 'N/A';

      const statsMsg = `📊 <b>${escapeHTML(meta.singular)} Response Stats:</b>

<b>${escapeHTML(meta.companyLabel)}:</b> ${escapeHTML(job.company)}
<b>${escapeHTML(meta.roleLabel)}:</b> ${escapeHTML(job.role)}
<b>${escapeHTML(meta.deadlineLabel)}:</b> ${escapeHTML(deadlineStr)}
<b>Status:</b> ${escapeHTML(job.status.toUpperCase())}

✅ <b>${escapeHTML(meta.yesLabel)}:</b> ${yesCount}
❌ <b>${escapeHTML(meta.noLabel)}:</b> ${noCount}
❔ <b>No Response (Est.):</b> ${noResponseCount}
👥 <b>Total Group Members tracked:</b> ${totalMembers}

🔗 <a href="${escapeHTML(job.applyLink)}">${escapeHTML(meta.linkText)}</a>`;

      const inlineKeyboard = [
        [{ text: '⬅️ Back to Details', callback_data: `view_job:${jobId}:${optType}:${isClosed}` }]
      ];

      await bot.editMessageText(statsMsg, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data.startsWith('pending:')) {
      const parts = data.split(':');
      const jobId = parts[1];
      const optType = parts[2] || '';
      const isClosed = parts[3] || '';

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Opportunity not found or access denied.', show_alert: true });
      }

      const meta = getOpportunityMeta(job);
      const responses = await PollResponse.find({ jobId: job._id });
      const votedNoUsernames = responses.filter(r => r.response === 'no').map(r => r.username ? `@${r.username}` : `User(${r.userId})`);

      const group = await Group.findOne({ telegramGroupId: job.telegramGroupId });
      const respondedUserIds = new Set(responses.map(r => r.userId));
      const noResponseUsernames = [];

      if (group) {
        group.members.forEach(member => {
          if (!respondedUserIds.has(member.userId)) {
            noResponseUsernames.push(member.username ? `@${member.username}` : `${member.firstName || ''} (${member.userId})`);
          }
        });
      }

      const pendingMsg = `🚨 <b>${escapeHTML(meta.pendingTitle)}</b>

<b>${escapeHTML(meta.companyLabel)}:</b> ${escapeHTML(job.company)}
<b>${escapeHTML(meta.roleLabel)}:</b> ${escapeHTML(job.role)}

❌ <b>${escapeHTML(meta.noLabel)} (${votedNoUsernames.length}):</b>
${votedNoUsernames.length > 0 ? escapeHTML(votedNoUsernames.join('\n')) : '<i>None</i>'}

❔ <b>No Response (${noResponseUsernames.length}):</b>
${noResponseUsernames.length > 0 ? escapeHTML(noResponseUsernames.join('\n')) : '<i>None</i>'}`;

      const inlineKeyboard = [
        [{ text: '⬅️ Back to Details', callback_data: `view_job:${jobId}:${optType}:${isClosed}` }]
      ];

      await bot.editMessageText(pendingMsg, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data.startsWith('remind:')) {
      const parts = data.split(':');
      const jobId = parts[1];

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job || job.status !== 'active') {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Active opportunity not found or access denied.', show_alert: true });
      }

      // Admin verification
      if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can perform this action.',
          show_alert: true
        });
      }

      const meta = getOpportunityMeta(job);
      const { group, targetUsers } = await getPendingReminderTargets(job.telegramGroupId, job);
      if (!group) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Group is not registered.', show_alert: true });
      }

      if (group.settings && group.settings.dmRemindersEnabled === false) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⚠️ DM reminders are disabled for this group.',
          show_alert: true
        });
      }

      if (targetUsers.length === 0) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: `✅ Everyone has already marked this as ${meta.yesLabel}.`,
          show_alert: true
        });
      }

      // Send reminders in the background
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

      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ Reminders sent to ${sentCount}/${targetUsers.length} pending users!`,
        show_alert: true
      });

    } else if (data.startsWith('delete_prompt:')) {
      const parts = data.split(':');
      const jobId = parts[1];
      const optType = parts[2] || '';
      const isClosed = parts[3] || '';

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Opportunity not found or access denied.', show_alert: true });
      }

      // Admin verification
      if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can perform this action.',
          show_alert: true
        });
      }

      const confirmMsg = `⚠️ <b>Confirm Deletion</b>

Are you sure you want to delete the opportunity:
<b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b>?

This will permanently delete the opportunity, its response stats, and all pending reminders.`;

      const inlineKeyboard = [
        [
          { text: '🗑️ Confirm Delete', callback_data: `delete_confirm:${jobId}:${optType}` },
          { text: '❌ Cancel', callback_data: `view_job:${jobId}:${optType}:${isClosed}` }
        ]
      ];

      await bot.editMessageText(confirmMsg, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data.startsWith('delete_confirm:')) {
      const parts = data.split(':');
      const jobId = parts[1];

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Opportunity not found or access denied.', show_alert: true });
      }

      // Admin verification
      if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can perform this action.',
          show_alert: true
        });
      }

      await Job.deleteOne({ _id: job._id });
      await PollResponse.deleteMany({ jobId: job._id });
      await Reminder.deleteMany({ jobId: job._id });

      await bot.editMessageText(`✅ Successfully deleted opportunity: <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b>`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML'
      });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Opportunity deleted.' });

    } else if (data.startsWith('edit_deadline_prompt:')) {
      const parts = data.split(':');
      const jobId = parts[1];
      const optType = parts[2] || '';
      const isClosed = parts[3] || '';

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Opportunity not found or access denied.', show_alert: true });
      }

      // Admin verification
      if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can perform this action.',
          show_alert: true
        });
      }

      const editMsg = `📅 <b>Edit Deadline:</b>

To edit the deadline for <b>${escapeHTML(job.company)} - ${escapeHTML(job.role)}</b>, copy the command below (tap to copy), adjust the date and time, and send it to the chat:

<code>/editdeadline ${jobId} YYYY-MM-DD HH:MM</code>

<i>Example:</i> <code>/editdeadline ${jobId} 2026-06-20 23:59</code>`;

      const inlineKeyboard = [
        [{ text: '⬅️ Back to Details', callback_data: `view_job:${jobId}:${optType}:${isClosed}` }]
      ];

      await bot.editMessageText(editMsg, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data.startsWith('back_to_list:')) {
      const parts = data.split(':');
      const optType = parts[1] || null;
      const isClosedFlag = parts[2] === '1';

      await sendOpportunityList(chatId, optType, msg.message_id, isClosedFlag, userId);
      await bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'toggle_autopoll' || data === 'toggle_dmreminders') {
      // Admin verification
      if (!(await checkAdmin(chatId, userId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can perform this action.',
          show_alert: true
        });
      }

      const field = data === 'toggle_autopoll' ? 'settings.autoPollEnabled' : 'settings.dmRemindersEnabled';
      const group = await Group.findOne({ telegramGroupId: chatId });
      if (!group) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Group settings not found.', show_alert: true });
      }

      const currentVal = data === 'toggle_autopoll'
        ? (group.settings && group.settings.autoPollEnabled !== false)
        : (group.settings && group.settings.dmRemindersEnabled !== false);

      const updateQuery = {
        $set: { [field]: !currentVal }
      };

      const updatedGroup = await Group.findOneAndUpdate(
        { telegramGroupId: chatId },
        updateQuery,
        { returnDocument: 'after' }
      );

      await bot.answerCallbackQuery(callbackQuery.id, { text: '⚙️ Setting updated successfully!' });
      await sendSettingsSummary(chatId, updatedGroup, msg.message_id);

    } else if (data.startsWith('archive_job:')) {
      const parts = data.split(':');
      const jobId = parts[1];
      const optType = parts[2] || '';
      const isClosed = parts[3] || '';

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Opportunity not found or access denied.', show_alert: true });
      }

      // Admin verification
      if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can perform this action.',
          show_alert: true
        });
      }

      job.status = 'archived';
      await job.save();

      await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Opportunity archived successfully.' });
      await renderJobDetails(chatId, jobId, optType, isClosed, msg.message_id, callbackQuery.id, userId);

    } else if (data.startsWith('reopen_job:')) {
      const parts = data.split(':');
      const jobId = parts[1];
      const optType = parts[2] || '';
      const isClosed = parts[3] || '';

      const job = await getJobAndVerifyAccess(chatId, jobId, userId);
      if (!job) {
        return await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Opportunity not found or access denied.', show_alert: true });
      }

      // Admin verification
      if (!(await checkAdmin(chatId, userId, job.telegramGroupId))) {
        return await bot.answerCallbackQuery(callbackQuery.id, {
          text: '⛔ Only group administrators can perform this action.',
          show_alert: true
        });
      }

      job.status = 'active';
      await job.save();

      await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Opportunity reopened.' });
      await renderJobDetails(chatId, jobId, optType, isClosed, msg.message_id, callbackQuery.id, userId);
    }
  } catch (err) {
    logger.error('Error in callback query handler: %s', err.stack);
    try {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ An error occurred processing this request.', show_alert: true });
    } catch (_) {}
  }
});

module.exports = bot;
