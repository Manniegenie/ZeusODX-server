const express = require('express');
const router = express.Router();
const CryptoFeeMarkup = require('../models/cryptofee'); // Adjust path as needed

// PUT /crypto-fee - Update feeUsd for a currency
router.put('/crypto-fee', async (req, res) => {
  try {
    const { currency, feeUsd } = req.body;

    if (!currency || feeUsd === undefined) {
      return res.status(400).json({ message: 'currency and feeUsd are required.' });
    }

    if (typeof feeUsd !== 'number' || feeUsd < 0) {
      return res.status(400).json({ message: 'feeUsd must be a non-negative number.' });
    }

    // Find by currency and update feeUsd, or create new if not found
    const updatedFee = await CryptoFeeMarkup.findOneAndUpdate(
      { currency: currency.toUpperCase() },
      { feeUsd },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({
      message: 'Crypto fee updated successfully.',
      data: updatedFee,
    });
  } catch (error) {
    console.error('Error updating crypto fee:', error);
    res.status(500).json({ message: 'Server error updating crypto fee.' });
  }
});

module.exports = router;
