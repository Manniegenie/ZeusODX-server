const crypto = require('crypto');

module.exports = function (req, res, next) {
  const signature = req.headers['x-obiex-signature'];
  const rawBody = req.rawBody;

  console.log('Webhook Auth - Headers:', req.headers);
  console.log('Webhook Auth - Raw Body:', rawBody);

  if (!signature || !rawBody) {
    console.log('Webhook Auth - Missing:', { signature: !!signature, rawBody: !!rawBody });
    return res.status(400).json({ error: 'Missing signature or raw body' });
  }

  const secret = process.env.OBIEX_WEBHOOK_SECRET;
  const computedSignature = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  console.log('Webhook Auth - Signature Verification:', { computed: computedSignature, received: signature });

  if (computedSignature !== signature) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Parse the raw body as JSON for the next middleware
  try {
    req.body = JSON.parse(rawBody);
  } catch (error) {
    console.error('Webhook Auth - JSON Parse Error:', error);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  next();
};