require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting storage
const rateLimitStore = new Map();

// Custom rate limiter for IP-based limiting
const ipRateLimiter = (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 30 * 60 * 1000; // 30 minutes
  const maxRequests = 2;

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, {
      count: 1,
      firstRequest: now
    });
    return next();
  }

  const ipData = rateLimitStore.get(ip);
  
  if (now - ipData.firstRequest > windowMs) {
    // Reset counter if window has passed
    rateLimitStore.set(ip, {
      count: 1,
      firstRequest: now
    });
    return next();
  }

  if (ipData.count >= maxRequests) {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again after 30 minutes.'
    });
  }

  // Increment count
  rateLimitStore.set(ip, {
    count: ipData.count + 1,
    firstRequest: ipData.firstRequest
  });
  
  next();
};

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  const windowMs = 30 * 60 * 1000;
  
  for (const [ip, data] of rateLimitStore.entries()) {
    if (now - data.firstRequest > windowMs) {
      rateLimitStore.delete(ip);
    }
  }
}, 60 * 1000); // Run every minute

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG or GIF files are allowed!'));
    }
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Send to Telegram function
async function sendToTelegram(text, files = []) {
  try {
    if (files.length > 0) {
      const formData = new FormData();
      formData.append('chat_id', TELEGRAM_CHAT_ID);
      formData.append('caption', text);
      formData.append('parse_mode', 'HTML');

      files.forEach(file => {
        formData.append('document', fs.createReadStream(file.path), {
          filename: file.originalname,
          contentType: file.mimetype
        });
      });

      const response = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
        formData,
        { headers: formData.getHeaders() }
      );

      // Clean up files
      files.forEach(file => {
        try {
          fs.unlinkSync(file.path);
        } catch (err) {
          console.error('Error deleting file:', err);
        }
      });

      return response.data;
    } else {
      const response = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: TELEGRAM_CHAT_ID,
          text: text,
          parse_mode: 'HTML'
        }
      );
      return response.data;
    }
  } catch (error) {
    console.error('Telegram API error:', error.response?.data || error.message);
    throw error;
  }
}

// Form handler with rate limiting
app.post('/telegram-webhook', ipRateLimiter, upload.array('reference_files[]'), async (req, res) => {
  try {
    const { name, email, project_type, price, details, contact_info } = req.body;

    const message = `
<b>New order from website!</b>

<b>Name:</b> ${name}
<b>Email:</b> ${email}
<b>Contact Info:</b> ${contact_info || 'Not provided'}
<b>Project type:</b> ${project_type}
<b>Budget:</b> $${price}

<b>Project details:</b>
${details}

<b>Date:</b> ${new Date().toLocaleString()}
<b>IP:</b> ${req.ip}
    `;

    await sendToTelegram(message, req.files);

    res.json({ 
      success: true,
      message: '✅ Your order has been received! Please wait up to 24 hours for us to contact you.'
    });

  } catch (error) {
    console.error('Form processing error:', error);
    
    // Clean up files on error
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path);
        } catch (err) {
          console.error('Error deleting file:', err);
        }
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Error processing your order'
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
