const mongoose = require('mongoose');

const nairaMarksSchema = new mongoose.Schema({
  markup: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  }
}, {
  timestamps: true,
  collection: 'nairamarks'
});

module.exports = mongoose.model('NairaMark', nairaMarksSchema);