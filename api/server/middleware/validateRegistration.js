const { isEnabled } = require('@librechat/api');

function validateRegistration(req, res, next) {
  if (req.headers['x-librechat-port'] === 'public') {
    return res.status(403).json({
      message: 'Registration is not allowed on this port.',
    });
  }

  if (req.invite) {
    return next();
  }

  if (isEnabled(process.env.ALLOW_REGISTRATION)) {
    next();
  } else {
    return res.status(403).json({
      message: 'Registration is not allowed.',
    });
  }
}

module.exports = validateRegistration;
