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
  origin: 'http://localhost:3000', // डेवलपमेंट के लिए, प्रोडक्शन में बदलें
  methods: ['POST', 'OPTIONS'], // केवल POST और OPTIONS, GET हटाया गया
  allowedHeaders: ['Content-Type', 'x-razorpay-signature'],
}));

// Body parser configuration for JSON
app.use(bodyParser.json()); // Parse JSON bodies
app.use(bodyParser.raw({ type: 'application/json' })); // For webhook raw body

// Razorpay Configuration
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Razorpay webhook secret
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

// Firebase इनीशियलाइज़ेशन
const firebaseConfig = {
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};

admin.initializeApp(firebaseConfig);
const db = admin.firestore();

// Create Order API
app.post('/create-order', async (req, res) => {
  console.log('Received create-order request:', req.body); // Log incoming request
  try {
    const { amount, receipt, userId } = req.body;
    if (!amount || !userId) {
      console.log('Missing required fields:', { amount, userId });
      return res.status(400).json({ success: false, error: 'Amount and userId are required' });
    }

    // Validate amount
    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const options = {
      amount: parsedAmount, // Amount in paise
      currency: 'INR',
      receipt: receipt || `receipt_${Date.now()}`,
      payment_capture: 1, // Auto-capture
      notes: { user_id: userId },
    };

    console.log('Creating order with options:', options);
    const order = await razorpay.orders.create(options);
    console.log('Order created successfully:', order);
    res.json({
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      success: true,
    });
  } catch (error) {
    console.error('Order creation failed:', error.message, error.stack); // Detailed error logging
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook Endpoint
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    console.log('No signature found');
    return res.status(400).send('Missing signature');
  }

  const body = req.body.toString('utf8');
  if (!body || body.length === 0) {
    console.log('No body data received');
    return res.status(400).send('No data received');
  }

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
    console.log('Webhook received:', body);
    try {
      const payload = JSON.parse(body);
      if (payload.event === 'payment.captured') {
        const payment = payload.payload.payment.entity;
        const userId = payment.notes?.user_id;
        const amount = payment.amount / 100;

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
            console.log(`Balance updated, User: ${userId}, Amount: ₹${amount}`);
          } else {
            console.log(`User ${userId} document not found`);
          }
        } else {
          console.log('user_id not found in notes');
        }
      } else {
        console.log(`Unsupported event: ${payload.event}`);
      }
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      return res.status(400).send('Invalid payload format');
    }
    res.status(200).send('Webhook processed successfully');
  } else {
    console.log('Invalid signature, received:', signature, 'expected:', expectedSignature);
    res.status(400).send('Invalid signature');
  }
});

// Handle invalid routes
app.use((req, res) => {
  res.status(404).send('Cannot ' + req.method + ' ' + req.url);
});

// Server start
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server Running on Port ${PORT}`));