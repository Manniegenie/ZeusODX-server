const express = require('express');
const router = express.Router();
const NairaPriceMarkup = require('../models/markup');

// POST /naira-price/markup
router.post('/markup', async (req, res) => {
  const { markupPercentage } = req.body;

  if (typeof markupPercentage !== 'number' || markupPercentage < 0) {
    return res.status(400).json({ message: 'Invalid markupPercentage. Must be a non-negative number.' });
  }

  try {
    let markupDoc = await NairaPriceMarkup.findOne();
    if (!markupDoc) {
      markupDoc = new NairaPriceMarkup({ markupPercentage });
    } else {
      markupDoc.markupPercentage = markupPercentage;
    }

    await markupDoc.save();
    res.status(200).json({ message: 'Markup updated successfully', markupPercentage });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update markup', error: err.message });
  }
});

module.exports = router;
