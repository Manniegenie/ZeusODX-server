const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');



// Reserved usernames that cannot be used
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'api', 'www', 'mail', 'ftp', 'support',
  'help', 'info', 'contact', 'sales', 'marketing', 'dev', 'test', 'demo',
  'guest', 'anonymous', 'user', 'users', 'account', 'accounts', 'profile',
  'profiles', 'settings', 'config', 'system', 'null', 'undefined', 'true',
  'false', 'login', 'logout', 'register', 'signup', 'signin', 'auth',
  'oauth', 'moderator', 'mod', 'staff', 'team', 'official', 'verified', 'Bramp'
]);

// Username validation configuration
const USERNAME_CONFIG = {
  MIN_LENGTH: 3,
  MAX_LENGTH: 30,
  PATTERN: /^[a-zA-Z0-9_-]+$/, // Only alphanumeric, underscore, and hyphen
  RESERVED_PATTERN: /^(admin|mod|staff|support)[\d_-]*$/i // Pattern for admin-like usernames
};

/**
 * Validates username format and rules
 * @param {string} username - Username to validate
 * @returns {Object} Validation result
 */
function validateUsername(username) {
  const errors = [];
  const cleanUsername = username.trim();

  // Basic presence check
  if (!cleanUsername) {
    return {
      isValid: false,
      errors: ['Username is required'],
      cleanUsername: null
    };
  }

  // Length validation
  if (cleanUsername.length < USERNAME_CONFIG.MIN_LENGTH) {
    errors.push(`Username must be at least ${USERNAME_CONFIG.MIN_LENGTH} characters long`);
  }

  if (cleanUsername.length > USERNAME_CONFIG.MAX_LENGTH) {
    errors.push(`Username must be no more than ${USERNAME_CONFIG.MAX_LENGTH} characters long`);
  }

  // Character validation
  if (!USERNAME_CONFIG.PATTERN.test(cleanUsername)) {
    errors.push('Username can only contain letters, numbers, underscores, and hyphens');
  }

  // Reserved username check (case-insensitive)
  const lowerUsername = cleanUsername.toLowerCase();
  if (RESERVED_USERNAMES.has(lowerUsername)) {
    errors.push('This username is reserved and cannot be used');
  }

  // Pattern-based reserved check (e.g., admin123, mod_user)
  if (USERNAME_CONFIG.RESERVED_PATTERN.test(cleanUsername)) {
    errors.push('This username pattern is reserved and cannot be used');
  }

  // Cannot start or end with special characters
  if (cleanUsername.startsWith('_') || cleanUsername.startsWith('-') || 
      cleanUsername.endsWith('_') || cleanUsername.endsWith('-')) {
    errors.push('Username cannot start or end with underscore or hyphen');
  }

  // Cannot have consecutive special characters
  if (/__+|--+|_-|-_/.test(cleanUsername)) {
    errors.push('Username cannot contain consecutive special characters');
  }

  return {
    isValid: errors.length === 0,
    errors,
    cleanUsername: errors.length === 0 ? cleanUsername : null
  };
}

/**
 * Generates username suggestions based on the requested username
 * @param {string} baseUsername - Base username to generate suggestions from
 * @returns {Array} Array of suggested usernames
 */
function generateUsernameSuggestions(baseUsername) {
  const suggestions = [];
  const base = baseUsername.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
  
  if (base.length >= USERNAME_CONFIG.MIN_LENGTH) {
    // Add numbers
    for (let i = 1; i <= 5; i++) {
      suggestions.push(`${base}${i}`);
      suggestions.push(`${base}${Math.floor(Math.random() * 1000)}`);
    }
    
    // Add year
    const currentYear = new Date().getFullYear();
    suggestions.push(`${base}${currentYear}`);
    
    // Add underscores
    if (base.length <= USERNAME_CONFIG.MAX_LENGTH - 2) {
      suggestions.push(`${base}_1`);
      suggestions.push(`the_${base}`);
    }
  }
  
  // Remove duplicates and limit to 5 suggestions
  return [...new Set(suggestions)].slice(0, 5);
}

/**
 * Checks if suggested usernames are available
 * @param {Array} suggestions - Array of username suggestions
 * @returns {Promise<Array>} Array of available suggestions
 */
async function checkSuggestionsAvailability(suggestions) {
  try {
    const availableSuggestions = [];
    
    for (const suggestion of suggestions) {
      const exists = await User.exists({ 
        username: { $regex: new RegExp(`^${suggestion}$`, 'i') }
      });
      
      if (!exists) {
        availableSuggestions.push(suggestion);
      }
      
      // Limit to 3 available suggestions for performance
      if (availableSuggestions.length >= 3) {
        break;
      }
    }
    
    return availableSuggestions;
  } catch (error) {
    logger.error('Error checking username suggestions availability:', error);
    return [];
  }
}

/**
 * POST /check-username
 * Checks if a username is available and provides suggestions if taken
 */
router.post('/check-username', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { username } = req.body;
    
    // Validate input format
    const validation = validateUsername(username);
    
    if (!validation.isValid) {
      logger.info('Username validation failed', {
        username: username?.substring(0, 10) + '...', // Log partial for privacy
        errors: validation.errors,
        ip: req.ip
      });
      
      return res.status(400).json({
        success: false,
        available: false,
        message: 'Username validation failed',
        errors: validation.errors
      });
    }
    
    const { cleanUsername } = validation;
    
    // Check if username exists (case-insensitive)
    const existingUser = await User.exists({ 
      username: { $regex: new RegExp(`^${cleanUsername}$`, 'i') }
    });
    
    const processingTime = Date.now() - startTime;
    
    if (existingUser) {
      // Username is taken, generate suggestions
      const suggestions = generateUsernameSuggestions(cleanUsername);
      const availableSuggestions = await checkSuggestionsAvailability(suggestions);
      
      logger.info('Username check - taken', {
        username: cleanUsername.substring(0, 10) + '...', // Log partial for privacy
        suggestionsProvided: availableSuggestions.length,
        processingTime,
        ip: req.ip
      });
      
      return res.status(200).json({
        success: true,
        available: false,
        message: 'Username is already taken',
        suggestions: availableSuggestions,
        meta: {
          checkedUsername: cleanUsername,
          processingTime: `${processingTime}ms`
        }
      });
    } else {
      // Username is available
      logger.info('Username check - available', {
        username: cleanUsername.substring(0, 10) + '...', // Log partial for privacy
        processingTime,
        ip: req.ip
      });
      
      return res.status(200).json({
        success: true,
        available: true,
        message: 'Username is available',
        meta: {
          checkedUsername: cleanUsername,
          processingTime: `${processingTime}ms`
        }
      });
    }
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    logger.error('Username check failed', {
      error: error.message,
      stack: error.stack,
      processingTime,
      ip: req.ip
    });
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error during username validation',
      meta: {
        processingTime: `${processingTime}ms`
      }
    });
  }
});

/**
 * GET /username-rules
 * Returns username validation rules for frontend
 */
router.get('/username-rules', (req, res) => {
  res.status(200).json({
    success: true,
    rules: {
      minLength: USERNAME_CONFIG.MIN_LENGTH,
      maxLength: USERNAME_CONFIG.MAX_LENGTH,
      allowedCharacters: 'Letters, numbers, underscores, and hyphens',
      pattern: USERNAME_CONFIG.PATTERN.source,
      restrictions: [
        'Cannot start or end with underscore or hyphen',
        'Cannot contain consecutive special characters',
        'Cannot use reserved usernames',
        'Case-insensitive (john and JOHN are treated as the same)'
      ],
      examples: {
        valid: ['john_doe', 'user123', 'my-username', 'alice2024'],
        invalid: ['_user', 'user_', 'admin', 'user__name', 'user@domain']
      }
    }
  });
});

module.exports = router;