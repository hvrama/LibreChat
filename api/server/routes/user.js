const express = require('express');
const {
  updateUserPluginsController,
  resendVerificationController,
  getTermsStatusController,
  acceptTermsController,
  verifyEmailController,
  deleteUserController,
  getUserController,
} = require('~/server/controllers/UserController');
const { updateUser } = require('~/models');
const { requireJwtAuth, canDeleteAccount, verifyEmailLimiter } = require('~/server/middleware');

const router = express.Router();

router.patch('/persona', requireJwtAuth, async (req, res) => {
  const { persona, personaDescription } = req.body;

  const updateData = {};
  if (typeof persona === 'string') {
    updateData.persona = persona;
  }
  if (typeof personaDescription === 'string') {
    updateData.personaDescription = personaDescription;
  }

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ error: 'At least one of persona or personaDescription must be provided as a string.' });
  }

  try {
    const updatedUser = await updateUser(req.user.id, updateData);
    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({
      updated: true,
      persona: updatedUser.persona,
      personaDescription: updatedUser.personaDescription,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', requireJwtAuth, getUserController);
router.get('/terms', requireJwtAuth, getTermsStatusController);
router.post('/terms/accept', requireJwtAuth, acceptTermsController);
router.post('/plugins', requireJwtAuth, updateUserPluginsController);
router.delete('/delete', requireJwtAuth, canDeleteAccount, deleteUserController);
router.post('/verify', verifyEmailController);
router.post('/verify/resend', verifyEmailLimiter, resendVerificationController);

module.exports = router;
