const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

/**
 * Middleware that validates authentication via cookies.
 * Used for routes serving static files (e.g., images) where the browser
 * sends cookies but not Authorization headers.
 */
function requireAuthCookie(req, res, next) {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      return res.status(401).send('Unauthorized');
    }

    const parsedCookies = cookies.parse(cookieHeader);
    const refreshToken = parsedCookies.refreshToken;

    if (!refreshToken) {
      return res.status(401).send('Unauthorized');
    }

    const tokenProvider = parsedCookies.token_provider;

    if (tokenProvider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
      const openidUserId = parsedCookies.openid_user_id;
      if (!openidUserId) {
        return res.status(403).send('Access Denied');
      }
      try {
        jwt.verify(openidUserId, process.env.JWT_REFRESH_SECRET);
      } catch {
        logger.warn('[requireAuthCookie] Invalid OpenID token');
        return res.status(403).send('Access Denied');
      }
    } else {
      try {
        jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      } catch {
        logger.warn('[requireAuthCookie] Invalid refresh token');
        return res.status(403).send('Access Denied');
      }
    }

    next();
  } catch (error) {
    logger.error('[requireAuthCookie] Error:', error);
    res.status(500).send('Internal Server Error');
  }
}

module.exports = requireAuthCookie;
