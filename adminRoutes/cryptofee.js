const express = require('express');
const router = express.Router();
const CryptoFeeMarkup = require('../models/cryptofee'); // Adjust path as needed

// POST /crypto-fee - Create new crypto fee
router.post('/crypto-fee', async (req, res) => {
  try {
    const { currency, network, networkName, networkFee } = req.body;

    if (!currency || !network || networkFee === undefined) {
      return res.status(400).json({ message: 'currency, network, and networkFee are required.' });
    }

    if (typeof networkFee !== 'number' || networkFee < 0) {
      return res.status(400).json({ message: 'networkFee must be a non-negative number.' });
    }

    // Check if the currency and network combination already exists
    const existingFee = await CryptoFeeMarkup.findOne({
      currency: currency.toUpperCase(),
      network: network.toUpperCase()
    });

    if (existingFee) {
      return res.status(409).json({ 
        message: 'Crypto fee already exists for this currency and network combination.' 
      });
    }

    // Create new crypto fee
    const newFee = new CryptoFeeMarkup({
      currency: currency.toUpperCase(),
      network: network.toUpperCase(),
      networkName: networkName ? networkName.trim() : '',
      networkFee: networkFee
    });

    await newFee.save();

    res.status(201).json({
      message: 'Crypto fee created successfully.',
      data: newFee,
    });
  } catch (error) {
    console.error('Error creating crypto fee:', error);
    res.status(500).json({ message: 'Server error creating crypto fee.' });
  }
});

// PUT /crypto-fee - Update networkFee for a currency and network combination
router.put('/crypto-fee', async (req, res) => {
  try {
    const { currency, network, networkName, networkFee } = req.body;

    if (!currency || !network || networkFee === undefined) {
      return res.status(400).json({ message: 'currency, network, and networkFee are required.' });
    }

    if (typeof networkFee !== 'number' || networkFee < 0) {
      return res.status(400).json({ message: 'networkFee must be a non-negative number.' });
    }

    // Prepare update object
    const updateData = { networkFee };
    if (networkName !== undefined) {
      updateData.networkName = networkName.trim();
    }

    // Find by currency and network combination, update fields, or create new if not found
    const updatedFee = await CryptoFeeMarkup.findOneAndUpdate(
      { 
        currency: currency.toUpperCase(),
        network: network.toUpperCase()
      },
      updateData,
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

// PATCH /crypto-fee-name - Update networkName for a currency and network combination
router.patch('/crypto-fee-name', async (req, res) => {
  try {
    const { currency, network, networkName } = req.body;

    if (!currency || !network || !networkName) {
      return res.status(400).json({ message: 'currency, network, and networkName are required.' });
    }

    // Prepare update object
    const updateData = { networkName: networkName.trim() };

    // Find by currency and network combination, update networkName, or create new if not found
    const updatedFee = await CryptoFeeMarkup.findOneAndUpdate(
      { 
        currency: currency.toUpperCase(),
        network: network.toUpperCase()
      },
      updateData,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({
      message: 'Network name updated successfully.',
      data: updatedFee,
    });
  } catch (error) {
    console.error('Error updating network name:', error);
    res.status(500).json({ message: 'Server error updating network name.' });
  }
});

// GET /crypto-fees - Fetch all available crypto fees
router.get('/crypto-fees', async (req, res) => {
  try {
    const cryptoFees = await CryptoFeeMarkup.find({}).sort({ currency: 1, network: 1 });

    res.status(200).json({
      message: 'Crypto fees retrieved successfully.',
      data: cryptoFees,
      count: cryptoFees.length,
    });
  } catch (error) {
    console.error('Error fetching crypto fees:', error);
    res.status(500).json({ message: 'Server error fetching crypto fees.' });
  }
});

// GET /crypto-fee/:currency/:network - Fetch specific crypto fee by currency and network
router.get('/crypto-fee/:currency/:network', async (req, res) => {
  try {
    const { currency, network } = req.params;

    const cryptoFee = await CryptoFeeMarkup.findOne({
      currency: currency.toUpperCase(),
      network: network.toUpperCase()
    });

    if (!cryptoFee) {
      return res.status(404).json({ 
        message: 'Crypto fee not found for the specified currency and network.' 
      });
    }

    res.status(200).json({
      message: 'Crypto fee retrieved successfully.',
      data: cryptoFee,
    });
  } catch (error) {
    console.error('Error fetching crypto fee:', error);
    res.status(500).json({ message: 'Server error fetching crypto fee.' });
  }
});

// DELETE /crypto-fee/:currency/:network - Delete specific crypto fee by currency and network
router.delete('/crypto-fee/:currency/:network', async (req, res) => {
  try {
    const { currency, network } = req.params;

    const deletedFee = await CryptoFeeMarkup.findOneAndDelete({
      currency: currency.toUpperCase(),
      network: network.toUpperCase()
    });

    if (!deletedFee) {
      return res.status(404).json({ 
        message: 'Crypto fee not found for the specified currency and network.' 
      });
    }

    res.status(200).json({
      message: 'Crypto fee deleted successfully.',
      data: deletedFee,
    });
  } catch (error) {
    console.error('Error deleting crypto fee:', error);
    res.status(500).json({ message: 'Server error deleting crypto fee.' });
  }
});

module.exports = router;