# JobPulse: AI-Powered Telegram Job Tracking Bot

JobPulse is an AI-powered Telegram bot built with Node.js, Express, MongoDB (Mongoose), and the Gemini API. It is designed to help student placement groups, coding communities, and internship channels automate the detection, parsing, and tracking of job opportunities.

---

## 🌟 Key Features

1. **Automatic Job Detection**: Listens to messages in registered Telegram groups and channels. When a message contains a URL, the bot triggers parsing.
2. **AI-Powered Metadata Extraction**: Leverages **Gemini 2.5 Flash** with strict JSON schemas to extract structured metadata (Company, Role, Application Link, Deadline, Location, Salary, Batch/Eligibility).
3. **Multi-Job Postings Support**: Capable of detecting and extracting multiple job opportunities from a single message or digest post, launching individual polls for each opportunity.
4. **Interactive Tracking Polls**: Generates non-anonymous Telegram polls (Yes/No) automatically under the job card.
5. **Short & Professional Card Templates**: Displays clean opportunity cards with the **Company Name** clearly bolded in the header.
6. **Smart & Configurable Reminders**:
   - **Post-Creation Reminder**: Fired after 3 hours (default) since sharing. Shows remaining time (e.g. `closes in 2h 45m`) if a deadline is present, or a `(submit asap)` tag if no deadline is specified. Includes a randomized motivational quote.
   - **Deadline Reminder**: Fired 3 hours (default) before the deadline. Displays dynamic remaining time (`closes in 3h 0m`).
7. **Direct Inline Button Navigation**: Reminders are equipped with interactive buttons:
   - **🔗 Apply Now**: Quick link to the external application page.
   - **💬 View Poll**: Navigates the user directly to the original poll message in the Telegram group chat.
8. **Auto-Closure Workflows**:
   - **With Deadline**: Closed and locked immediately after the deadline passes.
   - **Without Deadline**: Automatically closed and archived after **7 days** (168 hours) to prevent list clutter.

---

## 🛠️ Tech Stack

* **Backend**: Node.js, Express.js
* **Telegram Wrapper**: `node-telegram-bot-api`
* **AI Integration**: `@google/generative-ai` (Gemini 2.5 Flash)
* **Database**: MongoDB Atlas + Mongoose
* **Scheduling**: `node-cron`
* **Logging**: Winston + Morgan

---

## 📂 Project Directory Structure

```text
d:\open-claw/
├── package.json          # Dependency configurations & start scripts
├── .env                  # Environment configuration keys
├── src/
│   ├── index.js          # App orchestration & entrypoint
│   ├── config/
│   │   └── db.js         # Mongoose DB connection handler
│   ├── models/
│   │   ├── Job.js        # Job opportunity model
│   │   ├── PollResponse.js# User application status votes
│   │   ├── Reminder.js   # Sent DM alerts tracking model
│   │   └── Group.js      # Registered groups & members model
│   ├── services/
│   │   ├── ai.js         # Gemini AI structured extraction service
│   │   ├── bot.js        # Telegram commands, message & poll handlers
│   │   └── scheduler.js  # Reminder engines & deadline archivers
│   └── utils/
│       └── logger.js     # Winston structured logging
└── scratch/
    └── test-ai.js        # Offline Gemini array extraction test
```

---

## 🚀 Getting Started

### 1. Prerequisite Configuration
Ensure your `d:\open-claw\.env` file has the following keys populated:
```env
GEMINI_API_KEY=your_gemini_api_key_here
TELEGRAM_BOT_API=your_telegram_bot_token_here
MONGO_DB_URI=your_mongodb_connection_string_here
PORT=3000
NODE_ENV=development

# Optional Timing Configs (Defaults to 180 min and 3 hours if omitted)
REMINDER_POST_CREATION_MINUTES=180
REMINDER_DEADLINE_HOURS=3
```

### 2. Installation
Install project dependencies:
```bash
npm install
```

### 3. Run the Bot
* **Production/Local Start**:
  ```bash
  npm start
  ```
* **Development/Live Start**:
  ```bash
  npm run dev
  ```

---

## 👥 Telegram Interaction & Commands

### Setup in Group Chats
1. Add the bot to your Telegram Group chat.
2. Promote the bot to **Administrator** and verify it has **Manage Polls** and **Delete Messages** permissions.
3. Every group member who wishes to receive private follow-up alerts must open a DM with the bot and send `/start`.

### Public Group Commands
* `/jobs` - Display active opportunities.
* `/jobstats <number>` - View detailed stats (Applied, Not Applied, No Response counts) for a job.
* `/pending <number>` - List members who haven't applied or voted "No".
* `/closed` - Show recently closed/archived opportunities.
* `/help` - Show usage guidelines.

### Group Administrator Commands
* `/deletejob <number>` - Close and remove a job tracking record.
* `/editdeadline <number> <YYYY-MM-DD HH:MM>` - Adjust the application deadline.
* `/forcepoll <text>` - Force-parse raw text and manually spawn a job details card + poll.
* `/broadcast <message>` - Broadcast an announcement to all registered groups.

---

## 🧪 Testing Reminders
To verify the reminder engine quickly without waiting hours:
1. Set the following variables in your `.env`:
   ```env
   REMINDER_POST_CREATION_MINUTES=5
   ```
2. Restart the bot (`npm start`).
3. Post a job opportunity containing a link to your Telegram group.
4. Vote **No** (or do not respond) to the poll.
5. Wait 5 minutes. The scheduler will check the job and send a private DM with the new template layout and inline action buttons!
