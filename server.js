require('dotenv').config(); // ENV फाइल लोड करने के लिए
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // CORS पैकेज को जोड़ें
const crypto = require('crypto');
const admin = require('firebase-admin'); // Firebase Admin SDK
const Razorpay = require('razorpay'); // Razorpay SDK

const app = express();

// CORS कॉन्फ़िगरेशन जोड़ें
app.use(cors({
  origin: 'http://localhost:3000', // अपने फ्रंटएंड का URL, डेवलपमेंट के लिए
  methods: ['GET', 'POST', 'OPTIONS'], // अनुमति देने के लिए HTTP विधियाँ
  allowedHeaders: ['Content-Type', 'x-razorpay-signature'], // अनुमति देने के लिए हेडर
}));

app.use(bodyParser.raw({ type: 'application/json' })); // Raw body for signature verification

// Razorpay Configuration
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Razorpay webhook secret (Render में Environment Variable के रूप से सेट करें)
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

// Firebase इनीशियलाइज़ेशन (Environment Variables से कॉन्फ़िग लोड करें)
const firebaseConfig = {
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // नई लाइन को ठीक करें
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};

admin.initializeApp(firebaseConfig);
const db = admin.firestore();

// Create Order API
app.post('/create-order', async (req, res) => {
  try {
    const { amount, receipt, userId } = req.body; // amount in paise, userId for notes
    if (!amount || !userId) {
      return res.status(400).json({ success: false, error: 'Amount and userId are required' });
    }

    const options = {
      amount: parseInt(amount), // Ensure amount is an integer
      currency: 'INR',
      receipt: receipt || `receipt_${Date.now()}`,
      payment_capture: 1, // Auto-capture enabled
      notes: {
        user_id: userId, // Pass userId to link payment with user
      },
    };

    const order = await razorpay.orders.create(options);
    res.json({
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID, // Return Razorpay key to client
      success: true,
    });
  } catch (error) {
    console.error('Order creation failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook Endpoint
app.post('/webhook', async (req, res) => {
  // हेडर और बॉडी की जांच
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    console.log('कोई सिग्नेचर नहीं मिला');
    return res.status(400).send('Missing signature');
  }

  const body = req.body.toString('utf8'); // Convert buffer to string
  if (!body || body.length === 0) {
    console.log('कोई बॉडी डेटा नहीं मिला');
    return res.status(400).send('No data received');
  }

  // सिग्नेचर वेरीफिकेशन
  let expectedSignature;
  try {
    expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');
  } catch (cryptoError) {
    console.error('Signature generation failed:', cryptoError);
    return res.status(500).send('Internal server error');
  }

  if (signature === expectedSignature) {
    console.log('Webhook प्राप्त हुआ:', body);
    try {
      const payload = JSON.parse(body);
      // पेमेंट डेटा निकालें
      if (payload.event === 'payment.captured') {
        const payment = payload.payload.payment.entity;
        const userId = payment.notes?.user_id; // Safely access notes
        const amount = payment.amount / 100; // पैसा से रुपये में कन्वर्ट

        if (userId) {
          const userRef = db.collection('users').doc(userId);
          const userDoc = await userRef.get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            const currentBalance = parseInt(userData.balance?.replace('₹', '') || 0);
            const currentTopUp = parseInt(userData.totalTopUp || 0);
            await userRef.update({
              balance: `₹${currentBalance + amount}`,
              totalTopUp: currentTopUp + amount,
              lastPaymentId: payment.id,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`बैलेंस अपडेट हो गया, यूजर: ${userId}, राशि: ₹${amount}`);
          } else {
            console.log(`यूजर ${userId} का दस्तावेज नहीं मिला`);
          }
        } else {
          console.log('user_id notes में नहीं मिला');
        }
      } else {
        console.log(`अनसपोर्टेड इवेंट: ${payload.event}`);
      }
    } catch (parseError) {
      console.error('JSON पर्सिंग में त्रुटि:', parseError);
      return res.status(400).send('Invalid payload format');
    }
    res.status(200).send('Webhook processed successfully');
  } else {
    console.log('अमान्य सिग्नेचर, प्राप्त:', signature, ' अपेक्षित:', expectedSignature);
    res.status(400).send('Invalid signature');
  }
});

// सर्वर शुरू करें
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server Running on Port ${PORT}`));