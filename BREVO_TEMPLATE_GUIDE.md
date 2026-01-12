# Brevo Email Template Configuration Guide

## Overview
This guide explains how to update your Brevo email templates for giftcard approval and rejection emails to match the simplified generic structure.

## Environment Variables Required
Ensure these are set in your `.env` file:
```bash
BREVO_TEMPLATE_GIFTCARD_APPROVED=<template_id>
BREVO_TEMPLATE_GIFTCARD_REJECTED=<template_id>
```

## Available Template Variables

The code now sends all these variables to Brevo for both approval and rejection emails:

### User Information
- `{{params.username}}` - User's name or "User"
- `{{params.supportEmail}}` - Support email address
- `{{params.companyName}}` - Company name (ZeusODX)

### Submission Details
- `{{params.submissionId}}` - Unique submission ID
- `{{params.giftcardType}}` - Type of giftcard (e.g., "Amazon", "iTunes")
- `{{params.cardFormat}}` - Format: "PHYSICAL" or "ECODE"
- `{{params.country}}` - Country (e.g., "USA", "UK")
- `{{params.cardValue}}` - Original card value (e.g., "100")
- `{{params.date}}` - Review date (formatted)
- `{{params.status}}` - Status: "APPROVED" or "REJECTED"

### Navigation Links
- `{{params.submissionUrl}}` - Web URL to view submission
- `{{params.appDeepLink}}` - Deep link to open in mobile app

### Approval-Specific Fields
- `{{params.approvedValue}}` - Approved value (may differ from cardValue)
- `{{params.paymentAmount}}` - Amount paid to user
- `{{params.paymentCurrency}}` - Currency code (e.g., "NGN")
- `{{params.paymentRate}}` - Exchange rate used
- `{{params.transactionId}}` - Transaction reference ID

### Rejection-Specific Fields
- `{{params.rejectionReason}}` - Human-readable rejection reason
- `{{params.additionalNotes}}` - Additional notes from admin (optional, may be empty)

## Rejection Email Template Structure

Use this structure in your Brevo Template ID for rejections:

### Subject Line
```
Gift Card Submission Update - {{params.submissionId}}
```

### Email Body (HTML)
```html
<h2>Hello {{params.username}},</h2>

<p>Thank you for submitting your {{params.giftcardType}} gift card. After reviewing your submission, we need to inform you that it has been <strong>rejected</strong>.</p>

<h3>📋 Submission Details</h3>
<table style="width: 100%; border-collapse: collapse;">
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Submission ID:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.submissionId}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Gift Card Type:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.giftcardType}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Card Format:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.cardFormat}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Country:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.country}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Card Value:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${{params.cardValue}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Submission Date:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.date}}</td>
  </tr>
</table>

<h3>❌ Reason for Rejection</h3>
<p style="background-color: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0;">
  <strong>{{params.rejectionReason}}</strong>
</p>

{{ #if params.additionalNotes }}
<div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
  <p><strong>Additional Notes from Our Team:</strong></p>
  <p>{{params.additionalNotes}}</p>
</div>
{{ /if }}

<h3>🔄 What You Can Do Next</h3>
<ol>
  <li><strong>Review the rejection reason</strong> and ensure you understand what went wrong</li>
  <li><strong>Prepare a new submission</strong> that addresses the issues mentioned</li>
  <li><strong>Ensure all images are clear</strong> and show the complete card details</li>
  <li><strong>Verify the card information</strong> is accurate and matches the card type</li>
</ol>

<h3>💡 Tips for Successful Submissions</h3>
<ul>
  <li>✓ Take high-quality, well-lit photos of your physical cards</li>
  <li>✓ Ensure all codes and numbers are clearly visible</li>
  <li>✓ Double-check that the card has not been used or scratched off</li>
  <li>✓ Select the correct card type and country when submitting</li>
</ul>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{params.submissionUrl}}" style="display: inline-block; padding: 12px 30px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">View Submission Details</a>
  <br><br>
  <a href="{{params.appDeepLink}}" style="display: inline-block; padding: 12px 30px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Open in App</a>
</div>

<hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">

<p style="color: #666; font-size: 14px;">
  If you have any questions or need clarification, please don't hesitate to contact our support team at
  <a href="mailto:{{params.supportEmail}}">{{params.supportEmail}}</a>
</p>

<p style="color: #666; font-size: 14px;">
  Best regards,<br>
  The {{params.companyName}} Team
</p>
```

## Approval Email Template Structure

Use this structure in your Brevo Template ID for approvals:

### Subject Line
```
Gift Card Approved - Payment Processed
```

### Email Body (HTML)
```html
<h2>Hello {{params.username}},</h2>

<p>Great news! Your {{params.giftcardType}} gift card submission has been <strong style="color: #28a745;">approved</strong> and payment has been processed to your account.</p>

<h3>📋 Submission Details</h3>
<table style="width: 100%; border-collapse: collapse;">
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Submission ID:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.submissionId}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Gift Card Type:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.giftcardType}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Card Format:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.cardFormat}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Country:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">{{params.country}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Card Value:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${{params.cardValue}}</td>
  </tr>
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Approved Value:</strong></td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${{params.approvedValue}}</td>
  </tr>
</table>

<h3>💰 Payment Information</h3>
<div style="background-color: #d4edda; padding: 20px; border-radius: 5px; border-left: 4px solid #28a745; margin: 20px 0;">
  <p style="margin: 0; font-size: 16px;"><strong>Payment Amount:</strong> {{params.paymentCurrency}} {{params.paymentAmount}}</p>
  <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;"><strong>Exchange Rate:</strong> {{params.paymentRate}}</p>
  <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;"><strong>Transaction ID:</strong> {{params.transactionId}}</p>
  <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;"><strong>Date:</strong> {{params.date}}</p>
</div>

{{ #if params.additionalNotes }}
<div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
  <p><strong>Notes from Our Team:</strong></p>
  <p>{{params.additionalNotes}}</p>
</div>
{{ /if }}

<h3>✅ What Happens Next</h3>
<ul>
  <li>The payment has been credited to your account balance</li>
  <li>You can view the transaction in your transaction history</li>
  <li>The funds are available for immediate use</li>
</ul>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{params.submissionUrl}}" style="display: inline-block; padding: 12px 30px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">View Transaction Details</a>
  <br><br>
  <a href="{{params.appDeepLink}}" style="display: inline-block; padding: 12px 30px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Open in App</a>
</div>

<hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">

<p style="color: #666; font-size: 14px;">
  If you have any questions about this transaction, please contact our support team at
  <a href="mailto:{{params.supportEmail}}">{{params.supportEmail}}</a>
</p>

<p style="color: #666; font-size: 14px;">
  Thank you for using {{params.companyName}}!<br>
  The {{params.companyName}} Team
</p>
```

## Steps to Update Templates in Brevo

1. **Log in to Brevo Dashboard**
   - Go to https://app.brevo.com
   - Navigate to "Transactional" → "Templates"

2. **Find Your Template**
   - Locate Template ID 11 (or your rejection template ID)
   - Click "Edit"

3. **Update Template Content**
   - Copy the HTML structure above
   - Paste into the template editor
   - Customize colors/branding as needed

4. **Test Variables**
   - Use Brevo's "Test Send" feature
   - Ensure all variables render correctly
   - Check conditionals work (e.g., `additionalNotes`)

5. **Publish Template**
   - Click "Save & Activate"
   - Ensure template is in "Active" status (not "Draft")

6. **Verify Configuration**
   - Check template is not in draft mode
   - Verify all variable names match exactly
   - Test with a real submission

## Common Issues & Fixes

### Issue: Emails accepted by Brevo but not delivered
**Possible Causes:**
- Template is in "Draft" mode (must be "Active")
- Template has syntax errors in HTML
- Conditional statements are malformed
- Required variables are missing

**Solution:**
1. Go to Brevo dashboard
2. Check template status
3. Activate the template
4. Test send to verify

### Issue: Variables not rendering
**Possible Causes:**
- Variable names don't match exactly
- Missing `params.` prefix
- Typos in variable names

**Solution:**
- Double-check all variable names match the list above
- Ensure `{{params.variableName}}` format is used
- Test with Brevo's preview feature

### Issue: Conditional blocks not working
**Possible Causes:**
- Incorrect Handlebars syntax
- Missing closing tags

**Solution:**
```handlebars
{{ #if params.additionalNotes }}
  Content here
{{ /if }}
```

## Testing Checklist

Before going live, test:
- [ ] Template is in "Active" status
- [ ] Subject line renders correctly
- [ ] All variables populate with data
- [ ] Conditional blocks work (with and without additionalNotes)
- [ ] Links are clickable and correct
- [ ] Email renders well on mobile
- [ ] Test both approval and rejection templates
- [ ] Verify sender email and name are correct

## Support

If emails still don't send after following this guide:
1. Check server logs for detailed error messages
2. Verify BREVO_API_KEY is correct
3. Ensure template IDs are correct in .env
4. Contact Brevo support if API errors persist
