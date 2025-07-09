require('dotenv').config(); // ENV फाइल लोड करने के लिए

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.raw({ type: 'application/json' })); // Raw body for signature verification

// Razorpay webhook secret (Render में Environment Variable के रूप में सेट करें)
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

app.post('/webhook', (req, res) => {
  // हेडर और बॉडी की जांच
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    console.log('कोई सिग्नेचर नहीं मिला');
    return res.status(400).send('Missing signature');
  }

  const body = req.body;
  if (!body || Object.keys(body).length === 0) {
    console.log('कोई बॉडी डेटा नहीं मिला');
    return res.status(400).send('No data received');
  }

  // सिग्नेचर वेरीफिकेशन
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(Buffer.from(JSON.stringify(body)))
    .digest('hex');

  if (signature === expectedSignature) {
    console.log('Webhook प्राप्त हुआ:', JSON.stringify(body)); // डेटा को फॉर्मेटेड लॉग
    // यहाँ Firebase अपडेट जोड़ें (उदाहरण के लिए)
    res.status(200).send('Webhook processed successfully'); // सफलता का मैसेज
  } else {
    console.log('अमान्य सिग्नेचर, प्राप्त:', signature, ' अपेक्षित:', expectedSignature);
    res.status(400).send('Invalid signature');
  }
});

// सर्वर शुरू करें
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server Running on Port ${PORT}`));