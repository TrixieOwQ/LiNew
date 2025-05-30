require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting - максимум 2 запроса в 30 минут
const limiter = rateLimit({
    windowMs: 30 * 60 * 1000, // 30 минут
    max: 2,
    message: {
        success: false,
        message: 'Too many requests. Please try again after 30 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Отправка в Telegram
async function sendToTelegram(text) {
    try {
        const response = await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML'
            }
        );
        return response.data;
    } catch (error) {
        console.error('Telegram API error:', error.response?.data || error.message);
        throw error;
    }
}

// Обработчик формы с ограничением запросов
app.post('/telegram-webhook', limiter, async (req, res) => {
    try {
        const { name, contact_info, price, details } = req.body;

        // Валидация данных
        if (!name || !contact_info || !price || !details) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required'
            });
        }

        // Проверка бюджета (число)
        if (isNaN(price) {
            return res.status(400).json({
                success: false,
                message: 'Budget must be a number'
            });
        }

        const message = `
<b>New order from website!</b>

<b>Name:</b> ${name}
<b>Contact Info:</b> ${contact_info}
<b>Budget:</b> $${price}

<b>Project details:</b>
${details}

<b>Date:</b> ${new Date().toLocaleString()}
<b>IP:</b> ${req.ip}
        `;

        await sendToTelegram(message);

        res.json({ 
            success: true,
            message: '✅ Your order has been received! Please wait up to 24 hours for us to contact you.'
        });

    } catch (error) {
        console.error('Form processing error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error processing your order'
        });
    }
});

// Старт сервера
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
