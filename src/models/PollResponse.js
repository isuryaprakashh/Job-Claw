const mongoose = require('mongoose');

const pollResponseSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  userId: {
    type: Number,
    required: true
  },
  username: {
    type: String,
    default: ''
  },
  response: {
    type: String,
    enum: ['yes', 'no'],
    required: true
  },
  respondedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Composite unique index to ensure one vote per user per job
pollResponseSchema.index({ jobId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('PollResponse', pollResponseSchema);
