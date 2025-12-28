// models/Idempotency.js
const mongoose = require('mongoose');

const idempotencySchema = new mongoose.Schema({
  key: { 
    type: String, 
    required: true, 
    unique: true // Crucial to prevent duplicates
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  response: { 
    type: Object, 
    required: true 
  },
  status: { 
    type: Number, 
    required: true 
  },
  method: { type: String },
  path: { type: String },
  // MongoDB will automatically delete the document at this time
  expiresAt: { 
    type: Date, 
    required: true, 
    index: { expires: 0 } 
  }
}, { timestamps: true });

// Index for faster lookups by key and user
idempotencySchema.index({ key: 1, userId: 1 });

module.exports = mongoose.model('Idempotency', idempotencySchema);