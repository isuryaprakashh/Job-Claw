const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  userId: {
    type: Number,
    required: true
  },
  reminderType: {
    type: String,
    trim: true,
    required: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Composite unique index to avoid duplicate reminders of the same type for a user for a job
reminderSchema.index({ jobId: 1, userId: 1, reminderType: 1 }, { unique: true });

module.exports = mongoose.model('Reminder', reminderSchema);
