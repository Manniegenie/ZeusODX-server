// middlewares/check2FA.js

module.exports = function check2FA(req, res, next) {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ success: false, error: "Unauthorized: No user found." });
  }

  if (user.is2FAEnabled && !user.is2FAVerified) {
    return res.status(403).json({
      success: false,
      error: "2FA required: Please verify your 2FA token before proceeding.",
    });
  }

  next();
};
