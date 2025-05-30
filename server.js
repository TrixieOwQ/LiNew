require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Проверка на наличие необходимых переменных
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHAT_ID не заданы в .env');
    process.exit(1);
}

// Rate limiting
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

// Функция отправки в Telegram
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
        console.error('❌ Telegram API error:', error.response?.data || error.message);
        throw new Error('Failed to send message to Telegram');
    }
}

// Обработка формы
app.post('/telegram-webhook', limiter, async (req, res) => {
    try {
        const { name, contact_info, price, details } = req.body;

        // Валидация
        if (!name || !contact_info || !price || !details) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required'
            });
        }

        if (isNaN(price)) {
            return res.status(400).json({
                success: false,
                message: 'Budget must be a number'
            });
        }

        const message = `
<b>📨 Новый заказ с сайта</b>

<b>Имя:</b> ${name}
<b>Контакт:</b> ${contact_info}
<b>Бюджет:</b> $${price}

<b>Описание проекта:</b>
${details}

<b>Дата:</b> ${new Date().toLocaleString()}
<b>IP:</b> ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}
        `;

        await sendToTelegram(message);

        res.json({
            success: true,
            message: '✅ Your order has been received! Please wait up to 24 hours for us to contact you.'
        });

    } catch (error) {
        console.error('❌ Form processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error. Try again later.'
        });
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
