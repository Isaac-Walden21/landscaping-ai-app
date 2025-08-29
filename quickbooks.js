const express = require('express');
const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    connected: false,
    message: 'QuickBooks routes working',
    timestamp: new Date().toISOString()
  });
});

router.get('/test', (req, res) => {
  res.json({ message: 'Test route works' });
});

module.exports = router;
