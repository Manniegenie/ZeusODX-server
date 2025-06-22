const express = require('express');
const GlobalSwapMarkdown = require('../models/swapmarkdown'); // Adjust path as needed

const router = express.Router();

// GET global swap markdown configuration
router.get('/', async (req, res) => {
  try {
    const config = await GlobalSwapMarkdown.getGlobalMarkdown();
    
    res.json({
      success: true,
      message: "Global swap markdown retrieved successfully",
      data: config
    });

  } catch (error) {
    console.error('Error fetching global swap markdown:', error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

// PUT update global swap markdown
router.put('/', async (req, res) => {
  try {
    const { markdownPercentage, isActive } = req.body;

    // Validation
    if (markdownPercentage === undefined || markdownPercentage === null) {
      return res.status(400).json({
        success: false,
        message: "markdownPercentage is required"
      });
    }

    if (markdownPercentage < 0 || markdownPercentage > 100) {
      return res.status(400).json({
        success: false,
        message: "markdownPercentage must be between 0 and 100"
      });
    }

    const updatedConfig = await GlobalSwapMarkdown.updateGlobalMarkdown(markdownPercentage, isActive);

    res.json({
      success: true,
      message: "Global swap markdown updated successfully",
      data: updatedConfig
    });

  } catch (error) {
    console.error('Error updating global swap markdown:', error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

// PATCH toggle active status
router.patch('/toggle', async (req, res) => {
  try {
    const config = await GlobalSwapMarkdown.getGlobalMarkdown();
    config.isActive = !config.isActive;
    await config.save();

    res.json({
      success: true,
      message: `Global swap markdown ${config.isActive ? 'activated' : 'deactivated'} successfully`,
      data: config
    });

  } catch (error) {
    console.error('Error toggling global swap markdown:', error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

// POST apply markdown to amount (utility endpoint for testing)
router.post('/apply', async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid amount is required"
      });
    }

    const markedDownAmount = await GlobalSwapMarkdown.applyGlobalMarkdown(amount);

    res.json({
      success: true,
      message: "Markdown applied successfully",
      data: {
        originalAmount: amount,
        markedDownAmount: markedDownAmount,
        reductionAmount: amount - markedDownAmount
      }
    });

  } catch (error) {
    console.error('Error applying markdown:', error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

module.exports = router;