const axios = require('axios');
const logger = require('../utils/logger');

/**
 * VTU Authentication Class for eBills API
 * Based on official eBills documentation
 * Handles JWT token management, refresh, and validation
 * 
 * IMPROVEMENTS APPLIED:
 * - Better race condition handling with promise caching
 * - Enhanced error handling for IP whitelisting
 * - Improved token validation
 * - Better network error handling
 * - More robust authentication flow
 */
class VTUAuth {
  constructor() {
    this.baseURL = process.env.EBILLS_API_URL || 'https://ebills.africa/wp-json';
    this.username = process.env.EBILLS_USERNAME?.trim(); // IMPROVED: Trim whitespace
    this.password = process.env.EBILLS_PASSWORD?.trim(); // IMPROVED: Trim whitespace
    this.token = null;
    this.tokenExpiry = null;
    this.isAuthenticating = false;
    this.authPromise = null; // IMPROVED: Add promise caching for race conditions
  }

  /**
   * Authenticate with eBills API and get JWT token
   * IMPROVED: Better race condition handling with promise caching
   * @returns {Promise<string>} JWT token
   */
  async authenticate() {
    // IMPROVED: Use promise caching to prevent race conditions
    if (this.isAuthenticating && this.authPromise) {
      logger.info('Authentication already in progress, waiting for existing promise...');
      return this.authPromise;
    }

    // Create and cache the authentication promise
    this.authPromise = this._performAuthentication();
    return this.authPromise;
  }

  /**
   * Internal authentication method
   * IMPROVED: Separated from public method for better promise handling
   * @returns {Promise<string>} JWT token
   */
  async _performAuthentication() {
    try {
      this.isAuthenticating = true;

      // IMPROVED: Better credential validation
      const username = this.username;
      const password = this.password;

      if (!username || !password) {
        throw new Error('eBills credentials not configured. Please set EBILLS_USERNAME and EBILLS_PASSWORD');
      }

      logger.info('Authenticating with eBills API...');

      // Use exact endpoint and format from documentation
      const response = await axios.post(
        `${this.baseURL}/jwt-auth/v1/token`,
        {
          username: username, // Can be email or username per docs
          password: password
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 15000 // 15 second timeout
        }
      );

      // IMPROVED: More thorough response validation
      if (!response.data || !response.data.token) {
        logger.error('Authentication response missing token:', response.data);
        throw new Error('No token received from eBills API - check credentials and API status');
      }

      // IMPROVED: Validate token format
      if (typeof response.data.token !== 'string' || response.data.token.length < 10) {
        logger.error('Invalid token format received:', typeof response.data.token);
        throw new Error('Invalid token format received from eBills API');
      }

      this.token = response.data.token;
      
      // Per documentation: "The token expires after 7 days"
      // Set expiry to 6.5 days for safety margin
      this.tokenExpiry = new Date(Date.now() + (6.5 * 24 * 60 * 60 * 1000));

      logger.info(`eBills authentication successful. Token expires at: ${this.tokenExpiry}`);
      
      // Log user info from response
      const userDisplay = response.data.user_display_name || 'Unknown';
      const userEmail = response.data.user_email || 'Unknown';
      const userNice = response.data.user_nicename || '';
      
      logger.info(`Authenticated user: ${userDisplay} (${userEmail})`);
      if (userNice) {
        logger.info(`User nicename: ${userNice}`);
      }

      return this.token;

    } catch (error) {
      this.token = null;
      this.tokenExpiry = null;

      if (error.response) {
        const errorData = error.response.data || {};
        const status = error.response.status;
        
        logger.error('eBills authentication failed:', {
          status,
          code: errorData.code,
          message: errorData.message,
          data: errorData.data
        });

        // Handle specific error cases from documentation
        if (errorData.code === '[jwt_auth] incorrect_password' || 
            errorData.message?.includes('incorrect_password') ||
            status === 403) {
          throw new Error(`Invalid eBills credentials: ${errorData.message || 'Incorrect username or password'}. Please verify EBILLS_USERNAME and EBILLS_PASSWORD`);
        }
        
        if (status === 401) {
          throw new Error('eBills authentication failed: Unauthorized. Check your credentials.');
        }

        if (status === 429) {
          throw new Error('eBills rate limit exceeded. Please wait before retrying.');
        }

        // IMPROVED: Handle 400 errors (bad request)
        if (status === 400) {
          throw new Error(`eBills bad request (${status}): ${errorData.message || 'Invalid request format'}`);
        }
        
        throw new Error(`eBills authentication failed (${status}): ${errorData.message || 'Unknown error'}`);
      }

      // IMPROVED: Better network error handling
      if (error.code === 'ECONNREFUSED') {
        logger.error('eBills API connection refused:', error.message);
        throw new Error('Cannot connect to eBills API - connection refused. Check if the service is running.');
      }

      if (error.code === 'ENOTFOUND') {
        logger.error('eBills API DNS resolution failed:', error.message);
        throw new Error('Cannot resolve eBills API hostname. Check your internet connection and DNS settings.');
      }

      if (error.code === 'ETIMEDOUT') {
        throw new Error('eBills API timeout. The service may be slow or unavailable.');
      }

      // IMPROVED: Handle SSL/TLS errors
      if (error.code === 'EPROTO' || error.code === 'CERT_HAS_EXPIRED') {
        throw new Error('SSL/TLS error connecting to eBills API. Check your system time and certificates.');
      }

      logger.error('eBills authentication network error:', error.message);
      throw new Error(`Failed to connect to eBills API: ${error.message}`);

    } finally {
      this.isAuthenticating = false;
      this.authPromise = null; // IMPROVED: Clear cached promise
    }
  }

  /**
   * Wait for ongoing authentication to complete
   * KEPT: For backward compatibility, but now uses promise caching
   * @returns {Promise<string>} JWT token
   */
  async waitForAuthentication() {
    const maxWaitTime = 20000; // 20 seconds
    const checkInterval = 100; // 100ms
    const startTime = Date.now();

    while (this.isAuthenticating && (Date.now() - startTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    if (this.isAuthenticating) {
      throw new Error('Authentication timeout - taking too long');
    }

    if (!this.token) {
      throw new Error('Authentication failed while waiting');
    }

    return this.token;
  }

  /**
   * Check if current token is valid and not expired
   * IMPROVED: More robust validation
   * @returns {boolean} True if token is valid
   */
  isTokenValid() {
    // IMPROVED: Better token validation
    if (!this.token || 
        typeof this.token !== 'string' || 
        this.token.length < 10 ||
        !this.tokenExpiry ||
        !(this.tokenExpiry instanceof Date)) {
      return false;
    }

    // IMPROVED: Handle invalid dates
    if (isNaN(this.tokenExpiry.getTime())) {
      logger.warn('Token expiry is invalid date, treating as expired');
      return false;
    }

    // Refresh token if it expires in the next 12 hours for safety
    // Documentation recommends regular refresh (once or twice a week)
    const twelveHoursFromNow = new Date(Date.now() + (12 * 60 * 60 * 1000));
    return this.tokenExpiry > twelveHoursFromNow;
  }

  /**
   * Get valid JWT token (authenticate if needed)
   * @returns {Promise<string>} Valid JWT token
   */
  async getValidToken() {
    if (this.isTokenValid()) {
      logger.debug('Using existing valid token');
      return this.token;
    }

    logger.info('Token invalid or expired, refreshing...');
    return await this.authenticate();
  }

  /**
   * Get authorization header with valid token
   * IMPROVED: Validate token before returning header
   * @returns {Promise<Object>} Authorization header object
   */
  async getAuthHeader() {
    const token = await this.getValidToken();
    
    // IMPROVED: Validate token format before use
    if (!token || typeof token !== 'string') {
      throw new Error('Invalid token received, cannot create auth header');
    }

    return {
      'Authorization': `Bearer ${token}`
    };
  }

  /**
   * Make authenticated request to eBills API
   * IMPROVED: Better retry logic and error handling
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {string} endpoint - API endpoint (e.g., '/api/v2/airtime')
   * @param {Object} data - Request data for POST/PUT requests
   * @param {Object} options - Additional axios options
   * @returns {Promise<Object>} API response
   */
  async makeRequest(method, endpoint, data = null, options = {}) {
    const maxRetries = 1; // Only retry once to avoid infinite loops
    let attempt = 0;

    // IMPROVED: Validate inputs
    if (!method || typeof method !== 'string') {
      throw new Error('Invalid HTTP method provided');
    }

    if (!endpoint || typeof endpoint !== 'string') {
      throw new Error('Invalid endpoint provided');
    }

    while (attempt <= maxRetries) {
      try {
        const authHeader = await this.getAuthHeader();
        
        const requestConfig = {
          method: method.toUpperCase(),
          url: `${this.baseURL}${endpoint}`,
          headers: {
            'Content-Type': 'application/json',
            ...authHeader,
            ...options.headers
          },
          timeout: options.timeout || 30000,
          ...options
        };

        if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
          requestConfig.data = data;
        }

        logger.debug(`Making ${method.toUpperCase()} request to: ${endpoint}`, {
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          hasToken: !!this.token,
          tokenExpiry: this.tokenExpiry
        });
        
        const response = await axios(requestConfig);
        
        // IMPROVED: Validate response
        if (!response || response.status < 200 || response.status >= 300) {
          throw new Error(`Unexpected response status: ${response?.status}`);
        }

        return response.data;

      } catch (error) {
        attempt++;
        
        // IMPROVED: Only retry on specific auth errors, not IP whitelist errors
        const shouldRetry = error.response && 
                           [401, 403].includes(error.response.status) && 
                           attempt <= maxRetries &&
                           !error.response.data?.message?.includes('IP Address');

        if (shouldRetry) {
          logger.warn(`Got ${error.response.status}, attempting token refresh... (attempt ${attempt}/${maxRetries + 1})`);
          
          // Clear current token and try again
          this.token = null;
          this.tokenExpiry = null;
          continue; // Retry with new token
        }

        // If we've exhausted retries or it's a different error, throw it
        logger.error(`eBills API request failed after ${attempt} attempts:`, {
          method: method.toUpperCase(),
          endpoint,
          status: error.response?.status,
          statusText: error.response?.statusText,
          code: error.response?.data?.code,
          message: error.response?.data?.message || error.message,
          data: error.response?.data,
          hasToken: !!this.token,
          timeout: error.code === 'ETIMEDOUT'
        });
        
        // IMPROVED: More specific error messages
        if (error.response?.status === 403) {
          const errorMsg = error.response.data?.message || 'Access denied';
          
          // IMPROVED: Specific IP whitelist error detection
          if (errorMsg.includes('IP Address')) {
            throw new Error(`IP Address not whitelisted: ${errorMsg}`);
          }
          
          throw new Error(`eBills API access denied: ${errorMsg}. Check if your account has reseller access and is KYC verified.`);
        }
        
        if (error.response?.status === 401) {
          throw new Error('eBills authentication failed. Your token may be invalid or your account access may be restricted.');
        }

        if (error.response?.status === 404) {
          throw new Error(`eBills API endpoint not found: ${endpoint}. Check if the endpoint exists in the current API version.`);
        }
        
        if (error.code === 'ETIMEDOUT') {
          throw new Error('eBills API request timed out. The service may be slow or unavailable.');
        }
        
        throw error;
      }
    }
  }

  /**
   * Test eBills API connection and account status
   * IMPROVED: Better endpoint testing and error handling
   * @returns {Promise<Object>} Test results
   */
  async testConnection() {
    try {
      logger.info('Testing eBills API connection and authentication...');
      
      // First, try to get a valid token
      const token = await this.getValidToken();
      logger.info('✅ Authentication successful');
      
      // IMPROVED: Test with known working endpoints first
      const testEndpoints = [
        '/api/v2/balance',
        '/api/v2/variations/data',
        '/api/v2/variations/tv',
        '/api/v2/user/profile',
        '/api/v2/user',
        '/api/user/profile'
      ];

      let testSuccess = false;
      let testResponse = null;

      for (const testEndpoint of testEndpoints) {
        try {
          logger.info(`Testing endpoint: ${testEndpoint}`);
          const response = await this.makeRequest('GET', testEndpoint);
          logger.info(`✅ Test endpoint ${testEndpoint} successful`);
          testSuccess = true;
          testResponse = response;
          break;
        } catch (testError) {
          logger.debug(`❌ Test endpoint ${testEndpoint} failed: ${testError.message}`);
        }
      }
      
      return {
        success: true,
        authenticated: true,
        token: `${token.substring(0, 20)}...`,
        tokenExpiry: this.tokenExpiry,
        endpointTest: testSuccess,
        testResponse: testSuccess ? testResponse : null,
        message: testSuccess ? 'Full API access confirmed' : 'Authentication successful but test endpoints failed'
      };
      
    } catch (error) {
      logger.error('eBills API test failed:', error.message);
      return {
        success: false,
        authenticated: false,
        error: error.message,
        suggestion: this.getSuggestionForError(error.message)
      };
    }
  }

  /**
   * Get suggestions for common errors
   * IMPROVED: More comprehensive error suggestions
   * @param {string} errorMessage - Error message
   * @returns {string} Suggestion
   */
  getSuggestionForError(errorMessage) {
    if (errorMessage.includes('incorrect_password') || errorMessage.includes('credentials')) {
      return 'Check your EBILLS_USERNAME and EBILLS_PASSWORD environment variables. Ensure your eBills account credentials are correct.';
    }

    // IMPROVED: Specific IP whitelist suggestion
    if (errorMessage.includes('IP Address') || errorMessage.includes('whitelist')) {
      return 'Your IP address needs to be whitelisted. Go to eBills dashboard → Account Settings → Developer tab → IP Whitelist and add your current IP address.';
    }
    
    if (errorMessage.includes('reseller') || errorMessage.includes('403')) {
      return 'Ensure your eBills account has reseller role and is KYC verified. Check your account status on the eBills dashboard. KYC Tiers: Tier 1 (Email verified - ₦500K daily), Tier 2 (BVN verified - ₦2M daily), Tier 3 (Full verification - unlimited).';
    }
    
    if (errorMessage.includes('timeout') || errorMessage.includes('connect')) {
      return 'Check your internet connection and eBills service status. Consider increasing timeout values.';
    }
    
    if (errorMessage.includes('rate limit')) {
      return 'You are making too many requests. Wait a few minutes before retrying.';
    }

    // IMPROVED: SSL/TLS error suggestion
    if (errorMessage.includes('SSL') || errorMessage.includes('certificate')) {
      return 'SSL/TLS error. Check your system time and date, and ensure certificates are up to date.';
    }
    
    return 'Check eBills service status and your account configuration.';
  }

  /**
   * Validate current authentication status
   * @returns {Promise<Object>} Authentication status info
   */
  async validateAuth() {
    try {
      await this.getValidToken();
      
      const timeUntilExpiry = this.tokenExpiry ? this.tokenExpiry - new Date() : null;
      const daysUntilExpiry = timeUntilExpiry ? Math.floor(timeUntilExpiry / (1000 * 60 * 60 * 24)) : null;
      
      return {
        isAuthenticated: true,
        token: `${this.token.substring(0, 20)}...`,
        tokenExpiry: this.tokenExpiry,
        timeUntilExpiry,
        daysUntilExpiry,
        username: this.username,
        shouldRefresh: daysUntilExpiry && daysUntilExpiry < 2 // Suggest refresh if less than 2 days
      };
    } catch (error) {
      return {
        isAuthenticated: false,
        error: error.message,
        suggestion: this.getSuggestionForError(error.message)
      };
    }
  }

  /**
   * Force token refresh
   * @returns {Promise<string>} New JWT token
   */
  async refreshToken() {
    logger.info('Force refreshing eBills token...');
    this.token = null;
    this.tokenExpiry = null;
    return await this.authenticate();
  }

  /**
   * Clear authentication data
   * IMPROVED: Clear cached promise
   */
  logout() {
    logger.info('Clearing eBills authentication data');
    this.token = null;
    this.tokenExpiry = null;
    this.isAuthenticating = false;
    this.authPromise = null; // IMPROVED: Clear cached promise
  }
}

// Create singleton instance
const vtuAuth = new VTUAuth();

// PRESERVED: All your essential exports, especially token-related ones
module.exports = {
  VTUAuth,
  vtuAuth,
  
  // PRESERVED: Convenience methods for direct use (essential for other functions)
  getValidToken: () => vtuAuth.getValidToken(),
  getAuthHeader: () => vtuAuth.getAuthHeader(),
  makeRequest: (method, endpoint, data, options) => vtuAuth.makeRequest(method, endpoint, data, options),
  validateAuth: () => vtuAuth.validateAuth(),
  refreshToken: () => vtuAuth.refreshToken(),
  testConnection: () => vtuAuth.testConnection(),
  logout: () => vtuAuth.logout()
};