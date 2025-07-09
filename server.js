 const express = require('express');
     const bodyParser = require('body-parser');
     const crypto = require('crypto');

     const app = express();
     app.use(bodyParser.raw({ type: 'application/json' })); // Raw body for signature verification

     // Razorpay webhook secret (Render में Environment Variable के रूप में सेट करें)
     const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'mysecretkey123'; // डिफॉल्ट टेस्ट सीक्रेट

     app.post('/webhook', (req, res) => {
       const signature = req.headers['x-razorpay-signature'];
       const body = req.body;

       // सिग्नेचर वेरीफिकेशन
       const expectedSignature = crypto
         .createHmac('sha256', webhookSecret)
         .update(Buffer.from(JSON.stringify(body)))
         .digest('hex');

       if (signature === expectedSignature) {
         console.log('Webhook प्राप्त हुआ:', body);
         // यहाँ Firebase अपडेट जोड़ें (उदाहरण के लिए)
         res.sendStatus(200); // सफलता का जवाब
       } else {
         console.log('अमान्य सिग्नेचर');
         res.sendStatus(400); // त्रुटि
       }
     });

     // सर्वर शुरू करें
     const PORT = process.env.PORT || 4000;
     app.listen(PORT, () => console.log(`Server Running on Port ${PORT}`));
