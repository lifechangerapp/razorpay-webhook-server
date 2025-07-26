require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');

const app = express();

app.use(cors({
  origin: ['https://earnbyquiz.online', 'http://localhost:3000'],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-razorpay-signature'],
}));

const firebaseConfig = {
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};
const db = admin.initializeApp(firebaseConfig).firestore();

app.post('/create-order', bodyParser.json(), async (req, res) => {
  console.log('Received create-order request:', req.body);
  try {
    const { amount, receipt, userId } = req.body;
    if (!amount || !userId) {
      console.log('Missing required fields:', { amount, userId });
      return res.status(400).json({ success: false, error: 'Amount and userId are required' });
    }

    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('Razorpay credentials are missing in .env');
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const options = {
      amount: parsedAmount,
      currency: 'INR',
      receipt: receipt || `receipt_${Date.now()}`,
      payment_capture: 1,
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
    console.error('Order creation failed:', error.message, error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    console.log('No signature found in headers');
    return res.status(400).send('Missing signature');
  }

  const body = req.body;
  if (!body || Buffer.byteLength(body) === 0) {
    console.log('No body data received');
    return res.status(400).send('No data received');
  }

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.error('Webhook secret is missing in .env');
    return res.status(500).send('Internal server error: Webhook secret not configured');
  }

  let expectedSignature;
  try {
    expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
  } catch (cryptoError) {
    console.error('Signature generation failed:', cryptoError);
    return res.status(500).send('Internal server error');
  }

  console.log('Received signature:', signature, 'Expected signature:', expectedSignature);

  if (signature === expectedSignature) {
    console.log('Webhook received, body:', body.toString('utf8'));
    try {
      const payload = JSON.parse(body.toString('utf8'));
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
            console.log(`Balance updated for User: ${userId}, Amount: ₹${amount}`);
          } else {
            await userRef.set({
              balance: `₹${amount}`,
              totalTopUp: amount,
              lastPaymentId: payment.id,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`New user document created for ${userId} with initial balance ₹${amount}`);
          }
        } else {
          console.log('user_id not found in notes');
        }
      } else if (payload.event === 'payment.authorized') {
        console.log('Payment authorized, awaiting capture:', payload.payload.payment.entity.id);
      } else if (payload.event === 'payment.failed') {
        console.log('Payment failed:', payload.payload.payment.entity.id);
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

app.post('/verify-payment', bodyParser.json(), async (req, res) => {
  const { paymentId, orderId, userId } = req.body;
  try {
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const payment = await razorpay.payments.fetch(paymentId);
    if (payment.order_id === orderId && payment.status === 'captured') {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      const currentBalance = parseInt(userDoc.data()?.balance?.replace('₹', '') || 0);
      const currentTopUp = parseInt(userDoc.data()?.totalTopUp || 0);
      const amount = payment.amount / 100;

      await userRef.update({
        balance: `₹${currentBalance + amount}`,
        totalTopUp: currentTopUp + amount,
        lastPaymentId: paymentId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ success: true, message: 'Payment verified and balance updated' });
    } else {
      res.json({ success: false, message: 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).send('Cannot ' + req.method + ' ' + req.url);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server Running on Port ${PORT} at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`));