// routes/bankAccount.js
const express = require("express");
const router = express.Router();
const BankAccount = require("../models/BankAccount");

// DELETE: /bank/delete-bank
// Expects: { accountNumber: "1234567890" } in the request body
router.delete("/delete-bank", async (req, res) => {
  try {
    const { accountNumber } = req.body;

    if (!accountNumber) {
      return res.status(400).json({
        success: false,
        error: "Account number is required",
      });
    }

    const deleted = await BankAccount.findOneAndDelete({ accountNumber });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: "Bank account not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Bank account deleted successfully",
      deleted,
    });
  } catch (err) {
    console.error("❌ Error deleting bank account:", err.message);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

module.exports = router;
