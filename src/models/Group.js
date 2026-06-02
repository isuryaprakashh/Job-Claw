const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  telegramGroupId: {
    type: Number,
    required: true,
    unique: true
  },
  groupName: {
    type: String,
    default: ''
  },
  admins: {
    type: [Number], // Store user IDs of group admins who can manage settings/jobs
    default: []
  },
  settings: {
    autoPollEnabled: {
      type: Boolean,
      default: true
    },
    dmRemindersEnabled: {
      type: Boolean,
      default: true
    }
  },
  members: [{
    userId: { type: Number, required: true },
    username: { type: String, default: '' },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' }
  }]
}, {
  timestamps: true
});

module.exports = mongoose.model('Group', groupSchema);
