# PRD: JobPulse - AI-Powered Telegram Job Tracking Bot

## Product Overview

JobPulse is an AI-powered Telegram bot that helps placement groups track job applications.

Whenever a job opportunity is posted in a Telegram group, the bot automatically:

1. Detects the opportunity.
2. Extracts job details using Gemini AI.
3. Creates an application tracking poll.
4. Tracks member responses.
5. Sends reminders to users who haven't applied.
6. Closes the opportunity after the deadline.

The goal is to reduce missed opportunities and increase application rates within student communities.

---

# Problem Statement

Placement groups often face the following issues:

* Students miss deadlines.
* Opportunities get buried in chat messages.
* No visibility into who applied.
* Placement coordinators manually follow up.
* Students forget to apply despite seeing opportunities.

JobPulse automates the entire process.

---

# Target Users

## Primary Users

* College students
* Internship groups
* Placement groups
* Coding communities

## Secondary Users

* Placement coordinators
* Community admins
* Club leads

---

# User Flow

### Scenario 1

A user posts:

Google SWE Intern

Apply:
https://careers.google.com/xyz

Deadline: June 20

---

### Bot Flow

1. Detect message
2. Send content to Gemini
3. Extract job details
4. Save job in MongoDB
5. Create poll
6. Track responses
7. Send reminders before deadline
8. Archive after deadline

---

# Core Features

## Feature 1: Automatic Job Detection

### Trigger

Every new message posted in the Telegram group.

### Supported Formats

#### Text + Link

Google SWE Intern

Apply:
https://example.com

Deadline: June 20

#### Link Only

https://careers.microsoft.com/job123

#### Forwarded Message

Forwarded placement messages.

#### Multiple Links

Bot should detect all valid job opportunities.

---

## Feature 2: AI Job Extraction

Use Gemini 2.5 Flash.

Extract:

```json
{
  "company": "",
  "role": "",
  "applyLink": "",
  "deadline": "",
  "location": "",
  "salary": "",
  "batchEligibility": ""
}
```

If information is missing:

```json
{
  "deadline": null
}
```

Bot should still continue.

---

## Feature 3: Poll Creation

After extraction:

Bot sends:

📢 New Opportunity

Company: Google

Role: Software Engineer Intern

Deadline: June 20

Have you applied?

🔘 Yes
🔘 No

Store poll metadata.

---

## Feature 4: Application Tracking

Track:

### Applied

Users who select:

Yes

### Not Applied

Users who select:

No

### No Response

Users who do not vote.

Store response timestamps.

---

## Feature 5: Reminder Engine

Send reminders:

### 48 Hours Before Deadline

Reminder 1

### 24 Hours Before Deadline

Reminder 2

### 6 Hours Before Deadline

Reminder 3

### 1 Hour Before Deadline

Final Reminder

---

## Reminder Targets

Only:

* Users who selected No
* Users who never voted

Do not remind users who selected Yes.

---

## Feature 6: Direct Message Reminders

Example:

🚨 Application Reminder

Google SWE Intern

Deadline:
Today 11:59 PM

You have not marked this opportunity as applied.

Apply Here:
https://example.com

---

## Feature 7: Duplicate Detection

Prevent duplicate opportunities.

Rules:

* Same URL = Duplicate
* Same URL + Same Company = Duplicate

If duplicate:

⚠ Opportunity already being tracked.

Do not create a new poll.

---

## Feature 8: Auto Archive

After deadline:

* Mark job as closed
* Lock reminders
* Archive job

Status changes:

```text
active → closed → archived
```

---

# Commands

## /jobs

Display active opportunities.

Example:

1. Google SWE Intern
   Deadline: June 20

2. Microsoft Internship
   Deadline: June 25

---

## /jobstats

Example:

Google SWE Intern

Applied: 34

Not Applied: 12

No Response: 21

---

## /pending

Show:

* No voters
* Non-voters

Example:

Pending:

@user1
@user2
@user3

---

## /closed

Show archived opportunities.

---

## /help

Show available commands.

---

# Admin Commands

## /deletejob

Delete opportunity.

---

## /editdeadline

Update deadline.

---

## /forcepoll

Manually create a poll.

---

## /broadcast

Send announcement.

---

# Database Design (MongoDB)

## jobs Collection

```javascript
{
  _id: ObjectId,

  company: String,

  role: String,

  applyLink: String,

  deadline: Date,

  location: String,

  salary: String,

  batchEligibility: String,

  telegramMessageId: Number,

  telegramGroupId: Number,

  status: String,

  createdAt: Date,

  updatedAt: Date
}
```

---

## pollResponses Collection

```javascript
{
  _id: ObjectId,

  jobId: ObjectId,

  userId: Number,

  username: String,

  response: "yes" | "no",

  respondedAt: Date
}
```

---

## reminders Collection

```javascript
{
  _id: ObjectId,

  jobId: ObjectId,

  userId: Number,

  reminderType: String,

  sentAt: Date
}
```

---

## groups Collection

```javascript
{
  _id: ObjectId,

  telegramGroupId: Number,

  groupName: String,

  admins: [],

  settings: {
    autoPollEnabled: true,
    dmRemindersEnabled: true
  }
}
```

---

# AI Prompt

System Prompt:

You are a job opportunity extraction engine.

Extract:

* company
* role
* applyLink
* deadline
* salary
* location
* batchEligibility

Return valid JSON only.

Never return explanations.

---

# Non Functional Requirements

## Performance

Job detection:

< 3 seconds

Poll creation:

< 5 seconds

Reminder execution:

< 30 seconds

---

## Scalability

Support:

* 10,000+ users
* 500+ active jobs
* Multiple groups

---

## Reliability

* Retry Gemini failures
* Retry Telegram API failures
* Centralized logging
* Error tracking

---

# Tech Stack

## Backend

Node.js

Express.js

---

## Bot

Telegram Bot API

node-telegram-bot-api

---

## AI

Gemini 2.5 Flash

---

## Database

MongoDB Atlas

Mongoose

---

## Scheduling

node-cron

---

## Deployment

Render

---

## Logging

Morgan

Winston

---

# Environment Variables

```env
PORT=

MONGODB_URI=

TELEGRAM_BOT_TOKEN=

GEMINI_API_KEY=

NODE_ENV=
```

---

# MVP Scope

Included:

✅ Job detection

✅ Gemini extraction

✅ Poll creation

✅ Response tracking

✅ Reminder system

✅ Direct messages

✅ Duplicate detection

✅ Admin commands

✅ MongoDB storage

✅ Render deployment

Excluded:

❌ Web dashboard

❌ Resume matching

❌ Referral tracking

❌ Analytics

❌ Multi-language support

---

