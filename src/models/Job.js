const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  company: {
    type: String,
    required: true,
    trim: true
  },
  role: {
    type: String,
    required: true,
    trim: true
  },
  applyLink: {
    type: String,
    required: true,
    trim: true
  },
  deadline: {
    type: Date,
    default: null
  },
  location: {
    type: String,
    trim: true,
    default: ''
  },
  salary: {
    type: String,
    trim: true,
    default: ''
  },
  batchEligibility: {
    type: String,
    trim: true,
    default: ''
  },
  telegramMessageId: {
    type: Number,
    required: true
  },
  telegramGroupId: {
    type: Number,
    required: true
  },
  telegramPollId: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['active', 'closed', 'archived'],
    default: 'active'
  }
}, {
  timestamps: true
});

// Index to support fast searches and unique constraint for duplicates
// Duplicate check rules:
// - Same URL = Duplicate
// - Same URL + Same Company = Duplicate
jobSchema.index({ applyLink: 1 });

module.exports = mongoose.model('Job', jobSchema);
