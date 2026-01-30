const express = require("express");
const router = express.Router();
const PendingUser = require("../models/pendinguser");
const logger = require("../utils/logger");

// Normalize Nigerian phone - SAME logic as signup.js
function normalizeNigerianPhone(phone) {
  let cleaned = phone.replace(/[^\d+]/g, '');

  // +234070xxxxxxxx -> +23470xxxxxxxx
  if (cleaned.startsWith('+2340')) {
    cleaned = '+234' + cleaned.slice(5);
  }

  // 234070xxxxxxxx -> +23470xxxxxxxx
  if (cleaned.startsWith('2340') && !cleaned.startsWith('+')) {
    cleaned = '234' + cleaned.slice(4);
  }

  // 0xxxxxxxxxx -> +234xxxxxxxxx
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = '+234' + cleaned.slice(1);
  }

  // Force +234 prefix
  if (cleaned.startsWith('234') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  return cleaned;
}

router.post("/verify-otp", async (req, res) => {
  let { phonenumber, code } = req.body;

  if (!phonenumber || !code) {
    logger.warn("Missing phone number or code in verify-otp request");
    return res.status(400).json({ message: "Phone number and code are required." });
  }

  // Normalize phone number to match stored format
  phonenumber = normalizeNigerianPhone(phonenumber);

  try {
    const pendingUser = await PendingUser.findOne({ phonenumber });

    if (!pendingUser) {
      logger.warn(`Pending user not found for phone number: ${phonenumber}`);
      return res.status(404).json({ message: "User or OTP request not found." });
    }

    // Validate OTP match
    if (pendingUser.verificationCode !== code) {
      logger.warn(`Invalid OTP for phone number: ${phonenumber}`);
      return res.status(401).json({ message: "Invalid verification code." });
    }

    // Check if OTP is expired
    const now = new Date();
    if (pendingUser.verificationCodeExpiresAt < now) {
      logger.warn(`Expired OTP for phone number: ${phonenumber}`);
      return res.status(401).json({ message: "Verification code has expired." });
    }

    // Mark pending user as OTP verified
    pendingUser.otpVerified = true;
    pendingUser.otpVerifiedAt = now;
    await pendingUser.save();

    logger.info(`OTP verified successfully for phone number: ${phonenumber}`);

    res.status(200).json({
      message: "Phone number verified successfully. Please set your password PIN to complete registration.",
      pendingUserId: pendingUser._id,
      email: pendingUser.email,
      firstname: pendingUser.firstname,
      middlename: pendingUser.middlename,
      lastname: pendingUser.lastname,
      phonenumber: pendingUser.phonenumber
    });

  } catch (error) {
    const errorMessage = error.message || "Unknown error";
    logger.error("Error during OTP verification", {
      error: errorMessage,
      stack: error.stack,
      phonenumber: phonenumber ? phonenumber.slice(0, 5) + "****" : "N/A",
    });
    res.status(500).json({ message: `Server error: ${errorMessage}` });
  }
});

module.exports = router;