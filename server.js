require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Конфигурация
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const DATA_FILE = 'data.json';

// Проверка переменных окружения
if (!TELEGRAM_TOKEN || !ADMIN_CHAT_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID должны быть заданы в .env');
  process.exit(1);
}

// Инициализация бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Обработчик ошибок polling
bot.on('polling_error', (error) => {
  console.error(`‼️ Polling error: ${error.code} - ${error.message}`);
});

// Загрузка данных
let products = [];
let orders = [];

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE));
      products = data.products || [];
      orders = data.orders || [];
      console.log(`✅ Данные загружены: ${products.length} товаров, ${orders.length} заказов`);
    }
  } catch (e) {
    console.error('❌ Ошибка загрузки данных:', e);
  }
}

function saveData() {
  try {
    const data = JSON.stringify({ products, orders }, null, 2);
    fs.writeFileSync(DATA_FILE, data);
    console.log('💾 Данные сохранены');
  } catch (e) {
    console.error('❌ Ошибка сохранения данных:', e);
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API для сайта
app.get('/api/products', (req, res) => {
  const availableProducts = products
    .filter(p => p.quantity > 0)
    .map(p => ({
      ...p,
      available: p.quantity > 0
    }));
  res.json(availableProducts);
});

app.get('/api/photo/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const fileUrl = await bot.getFileLink(fileId);
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    response.data.pipe(res);
  } catch (error) {
    console.error('Error fetching photo:', error);
    res.status(404).send('Фото не знайдено');
  }
});

app.post('/api/order', (req, res) => {
  const { name, contact, items } = req.body;

  // Проверка наличия товаров  
  let validItems = [];  
  let error = null;  
  
  items.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    if (!product) {  
      error = `Товар ${item.title} більше недоступний`;  
    } else if (product.quantity < item.qty) {  
      error = `Недостатня кількість товару: ${product.title} (залишилось: ${product.quantity})`;  
    } else {  
      validItems.push(item);  
    }  
  });  
  
  if (error || validItems.length === 0) {  
    return res.status(400).json({   
      success: false,  
      message: error || 'Немає доступних товарів для замовлення'  
    });  
  }  
  
  // Обновление количества  
  validItems.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    product.quantity -= item.qty;  
  });  
  
  // Сохранение заказа  
  const newOrder = {  
    id: Date.now(),  
    date: new Date().toISOString(),  
    name,  
    contact,  
    items: validItems  
  };  
  
  orders.push(newOrder);  
  saveData();  
  
  // Формирование сообщения для Telegram  
  let message = `📦 *НОВЕ ЗАМОВЛЕННЯ!* #${newOrder.id}\n\n`;  
  message += `👤 *Ім'я:* ${name}\n`;  
  message += `📞 *Контакт:* ${contact}\n\n`;  
  message += `🛒 *Товари:*\n`;  
  
  validItems.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    message += `- ${product.title} (${item.size})\n`;  
    message += `  Ціна: ₴${product.price} x ${item.qty}\n`;  
    message += `  Загалом: ₴${(product.price * item.qty).toFixed(2)}\n`;  
  });  
  
  const total = validItems.reduce((sum, item) => {  
    const product = products.find(p => p.id === item.id);  
    return sum + (product.price * item.qty);  
  }, 0);  
  
  message += `\n💵 *Сума замовлення:* ₴${total.toFixed(2)}\n`;  
  message += `⏰ *Дата:* ${new Date().toLocaleString('uk-UA')}`;  
  
  // Отправка в Telegram  
  bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' })  
    .catch(err => console.error('❌ Помилка відправки в Telegram:', err));  
  
  res.json({ success: true });
});

// Система состояний для бота
const userStates = {};

// Состояния
const STATE = {
  IDLE: 'IDLE',
  ADDING_TITLE: 'ADDING_TITLE',
  ADDING_DESC: 'ADDING_DESC',
  ADDING_PRICE: 'ADDING_PRICE',
  ADDING_SIZES: 'ADDING_SIZES',
  ADDING_QUANTITY: 'ADDING_QUANTITY',
  ADDING_PHOTOS: 'ADDING_PHOTOS',
  EDITING_PRODUCT: 'EDITING_PRODUCT',
  EDITING_FIELD: 'EDITING_FIELD',
  DELETING_PRODUCT: 'DELETING_PRODUCT',
  MOVING_PRODUCT: 'MOVING_PRODUCT'
};

// Сброс состояния
function resetState(chatId) {
  delete userStates[chatId];
}

// Главное меню
function showMainMenu(chatId) {
  const menu = {
    reply_markup: {
      keyboard: [
        ['➕ Додати товар', '📋 Список товарів'],
        ['✏️ Редагувати товар', '❌ Видалити товар'],
        ['📦 Замовлення', '🔄 Змінити порядок']
      ],
      resize_keyboard: true
    }
  };

  bot.sendMessage(chatId, '👋 Вітаю в панелі управління магазином!', menu);  
  resetState(chatId);
}

// Обработка команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  showMainMenu(chatId);
});

// Обработка команды /cancel
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  bot.sendMessage(chatId, '❌ Поточну дію скасовано');  
  showMainMenu(chatId);
});

// =================================================
// ОСНОВНЫЕ ИСПРАВЛЕНИЯ ДЛЯ ОБРАБОТКИ ФОТОГРАФИЙ:
// =================================================

// Обработка фото при добавлении товара
function handleAddingPhotos(chatId, msg) {
  const state = userStates[chatId];
  
  // Если пришло фото
  if (msg.photo) {
    if (state.productData.photos.length >= 10) {
      bot.sendMessage(chatId, '❌ Ви вже додали максимальну кількість фото (10)');
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    state.productData.photos.push(photo.file_id);
    
    bot.sendMessage(
      chatId, 
      `🖼 Додано фото ${state.productData.photos.length}/10. ` +
      `Надішліть ще фото або введіть "готово"`
    );
  }
  // Если пришло текстовое сообщение "готово"
  else if (msg.text && msg.text.toLowerCase() === 'готово') {
    // Проверка наличия хотя бы одного фото
    if (state.productData.photos.length === 0) {
      bot.sendMessage(chatId, '❌ Будь ласка, додайте хоча б одне фото');
      return;
    }
    
    // Сохранение товара  
    const newProduct = {  
      id: Date.now(),  
      ...state.productData  
    };  
      
    products.push(newProduct);  
    saveData();  
      
    bot.sendMessage(chatId, `✅ Товар "${newProduct.title}" успішно додано!`);  
    showMainMenu(chatId);
  }
  // Неподдерживаемый тип сообщения
  else {
    bot.sendMessage(
      chatId, 
      '❌ Будь ласка, надішліть фото або введіть "готово" для завершення'
    );
  }
}

// Обработка фото при редактировании товара
function handleEditingField(chatId, msg) {
  const state = userStates[chatId];
  
  // Если пришла команда завершения
  if (msg.text === '✅ Завершити редагування') {  
    bot.sendMessage(chatId, '✅ Редагування завершено');  
    saveData();  
    showMainMenu(chatId);  
    return;  
  }  
  
  // Если выбрано поле для редактирования
  if (!state.editingField) {
    switch (msg.text) {  
      case '✏️ Назва':  
        state.editingField = 'title';  
        bot.sendMessage(chatId, 'Введіть нову назву товару:');  
        break;  
      case '✏️ Опис':  
        state.editingField = 'desc';  
        bot.sendMessage(chatId, 'Введіть новий опис товару:');  
        break;  
      case '✏️ Ціна':  
        state.editingField = 'price';  
        bot.sendMessage(chatId, 'Введіть нову ціну товару:');  
        break;  
      case '✏️ Розміри':  
        state.editingField = 'sizes';  
        bot.sendMessage(chatId, 'Введіть нові розміри через кому:');  
        break;  
      case '✏️ Кількість':  
        state.editingField = 'quantity';  
        bot.sendMessage(chatId, 'Введіть нову кількість товару:');  
        break;  
      case '✏️ Фото':  
        state.editingField = 'photos';  
        bot.sendMessage(chatId, 'Надішліть нове фото товару:');  
        break;  
    }
    return;
  }
  
  // Если поле выбрано и пришло значение
  const product = state.editingProduct;  
    
  switch (state.editingField) {  
    case 'title':  
      product.title = msg.text;  
      bot.sendMessage(chatId, `✅ Назву змінено на: ${msg.text}`);  
      break;  
    case 'desc':  
      product.desc = msg.text;  
      bot.sendMessage(chatId, `✅ Опис змінено`);  
      break;  
    case 'price':  
      const price = parseFloat(msg.text);  
      if (isNaN(price)) {  
        bot.sendMessage(chatId, '❌ Невірний формат ціни');  
      } else {  
        product.price = price;  
        bot.sendMessage(chatId, `✅ Ціну змінено на: ₴${price}`);  
      }  
      break;  
    case 'sizes':  
      const sizes = msg.text.split(',').map(s => s.trim()).filter(s => s);  
      if (sizes.length === 0) {  
        bot.sendMessage(chatId, '❌ Не вказано розміри');  
      } else {  
        product.sizes = sizes;  
        bot.sendMessage(chatId, `✅ Розміри змінено на: ${sizes.join(', ')}`);  
      }  
      break;  
    case 'quantity':  
      const quantity = parseInt(msg.text);  
      if (isNaN(quantity)) {  
        bot.sendMessage(chatId, '❌ Невірний формат кількості');  
      } else {  
        product.quantity = quantity;  
        bot.sendMessage(chatId, `✅ Кількість змінено на: ${quantity}`);  
      }  
      break;  
    case 'photos':  
      if (msg.photo) {  
        const photo = msg.photo[msg.photo.length - 1];  
        product.photos = [photo.file_id]; // Обновляем все фото
        bot.sendMessage(chatId, `✅ Фото оновлено`);  
      } else {  
        bot.sendMessage(chatId, '❌ Будь ласка, надішліть фото');  
        return; // Не сбрасываем поле редактирования
      }  
      break;  
  }  
    
  // Сбрасываем текущее поле редактирования  
  delete state.editingField;  
  saveData();
}

// =================================================
// ОСТАЛЬНАЯ ЧАСТЬ КОДА (без изменений)
// =================================================

// Обработка сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const text = msg.text;  
  const state = userStates[chatId]?.state || STATE.IDLE;  
  
  // Если пользователь в процессе добавления товара  
  if (state !== STATE.IDLE && text && text.startsWith('/')) {  
    return;  
  }  
  
  switch (state) {  
    case STATE.IDLE:  
      handleIdleState(chatId, text);  
      break;  
    case STATE.ADDING_TITLE:  
      handleAddingTitle(chatId, text);  
      break;  
    case STATE.ADDING_DESC:  
      handleAddingDesc(chatId, text);  
      break;  
    case STATE.ADDING_PRICE:  
      handleAddingPrice(chatId, text);  
      break;  
    case STATE.ADDING_SIZES:  
      handleAddingSizes(chatId, text);  
      break;  
    case STATE.ADDING_QUANTITY:  
      handleAddingQuantity(chatId, text);  
      break;  
    case STATE.ADDING_PHOTOS:  
      handleAddingPhotos(chatId, msg);  
      break;  
    case STATE.EDITING_PRODUCT:  
      handleEditingProduct(chatId, text);  
      break;  
    case STATE.EDITING_FIELD:  
      handleEditingField(chatId, msg);  
      break;  
    case STATE.DELETING_PRODUCT:  
      handleDeletingProduct(chatId, text);  
      break;  
    case STATE.MOVING_PRODUCT:  
      handleMovingProduct(chatId, text);  
      break;  
  }
});

// Обработка состояний
function handleIdleState(chatId, text) {
  switch (text) {
    case '➕ Додати товар':
      userStates[chatId] = {
        state: STATE.ADDING_TITLE,
        productData: {}
      };
      bot.sendMessage(chatId, '📝 Надішліть назву товару:');
      break;

    case '📋 Список товарів':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ Товарів немає');  
      } else {  
        let message = '📦 *Список товарів:*\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
          message += `   Ціна: ₴${p.price}\n`;  
          message += `   Кількість: ${p.quantity}\n`;  
          message += `   Розміри: ${p.sizes.join(', ')}\n\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });  
      }  
      break;  
        
    case '✏️ Редагувати товар':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ Товарів немає для редагування');  
      } else {  
        userStates[chatId] = { state: STATE.EDITING_PRODUCT };  
        let message = '📋 Виберіть товар для редагування:\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message);  
      }  
      break;  
        
    case '❌ Видалити товар':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ Товарів немає для видалення');  
      } else {  
        userStates[chatId] = { state: STATE.DELETING_PRODUCT };  
        let message = '🗑 Виберіть товар для видалення:\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message);  
      }  
      break;  
        
    case '📦 Замовлення':  
      if (orders.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ Замовлень немає');  
      } else {  
        let message = '📋 *Останні замовлення:*\n\n';  
        orders.slice(-5).reverse().forEach(order => {  
          message += `🆔 #${order.id}\n`;  
          message += `👤 ${order.name}\n`;  
          message += `📞 ${order.contact}\n`;  
          message += `📅 ${new Date(order.date).toLocaleString('uk-UA')}\n`;  
          message += `🛒 ${order.items.length} товар(ів)\n\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });  
      }  
      break;  
        
    case '🔄 Змінити порядок':  
      if (products.length < 2) {  
        bot.sendMessage(chatId, 'ℹ️ Потрібно щонайменше 2 товари для зміни порядку');  
      } else {  
        userStates[chatId] = { state: STATE.MOVING_PRODUCT };  
        let message = '↕️ Виберіть товар для переміщення:\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message);  
      }  
      break;  
  }
}

// Добавление товара - обработка названия
function handleAddingTitle(chatId, text) {
  userStates[chatId].productData.title = text;
  userStates[chatId].state = STATE.ADDING_DESC;
  bot.sendMessage(chatId, '📝 Надішліть опис товару:');
}

// Добавление товара - обработка описания
function handleAddingDesc(chatId, text) {
  userStates[chatId].productData.desc = text;
  userStates[chatId].state = STATE.ADDING_PRICE;
  bot.sendMessage(chatId, '💰 Надішліть ціну товару (тільки число):');
}

// Добавление товара - обработка цены
function handleAddingPrice(chatId, text) {
  const price = parseFloat(text);
  if (isNaN(price)) {
    bot.sendMessage(chatId, '❌ Ціна повинна бути числом. Спробуйте ще раз:');
    return;
  }

  userStates[chatId].productData.price = price;  
  userStates[chatId].state = STATE.ADDING_SIZES;  
  bot.sendMessage(chatId, '📏 Надішліть розміри через кому (наприклад: S,M,L):');
}

// Добавление товара - обработка размеров
function handleAddingSizes(chatId, text) {
  const sizes = text.split(',').map(s => s.trim()).filter(s => s);
  if (sizes.length === 0) {
    bot.sendMessage(chatId, '❌ Введіть хоча б один розмір. Спробуйте ще раз:');
    return;
  }

  userStates[chatId].productData.sizes = sizes;  
  userStates[chatId].state = STATE.ADDING_QUANTITY;  
  bot.sendMessage(chatId, '🔢 Надішліть кількість товару (від 1 до 100):');
}

// Добавление товара - обработка количества
function handleAddingQuantity(chatId, text) {
  const quantity = parseInt(text);
  if (isNaN(quantity) || quantity < 1 || quantity > 100) {
    bot.sendMessage(chatId, '❌ Кількість повинна бути числом від 1 до 100. Спробуйте ще раз:');
    return;
  }

  userStates[chatId].productData.quantity = quantity;  
  userStates[chatId].state = STATE.ADDING_PHOTOS;  
  userStates[chatId].productData.photos = [];  
  bot.sendMessage(chatId, '🖼 Надішліть фото товару (до 10 фото)');
}

// Редактирование товара - выбор товара
function handleEditingProduct(chatId, text) {
  const index = parseInt(text) - 1;
  if (index >= 0 && index < products.length) {
    const product = products[index];
    userStates[chatId] = {
      state: STATE.EDITING_FIELD,
      editingProductId: product.id,
      editingProduct: product
    };

    const menu = {  
      reply_markup: {  
        keyboard: [  
          ['✏️ Назва', '✏️ Опис'],  
          ['✏️ Ціна', '✏️ Розміри'],  
          ['✏️ Кількість', '✏️ Фото'],  
          ['✅ Завершити редагування']  
        ],  
        resize_keyboard: true  
      }  
    };  
      
    bot.sendMessage(chatId, `✏️ Ви обрали товар: ${product.title}\nЩо бажаєте змінити?`, menu);  
  } else {  
    bot.sendMessage(chatId, '❌ Невірний номер товару. Спробуйте ще раз:');  
  }
}

// Удаление товара
function handleDeletingProduct(chatId, text) {
  const index = parseInt(text) - 1;
  if (index >= 0 && index < products.length) {
    const product = products[index];
    products.splice(index, 1);
    saveData();
    bot.sendMessage(chatId, `✅ Товар "${product.title}" видалено`);
    showMainMenu(chatId);
  } else {
    bot.sendMessage(chatId, '❌ Невірний номер товару. Спробуйте ще раз:');
  }
}

// Изменение порядка товаров
function handleMovingProduct(chatId, text) {
  const state = userStates[chatId];

  if (!state.selectedIndex) {  
    const index = parseInt(text) - 1;  
    if (index >= 0 && index < products.length) {  
      state.selectedIndex = index;  
      bot.sendMessage(chatId, '↕️ На яку позицію перемістити? Введіть номер:');  
    } else {  
      bot.sendMessage(chatId, '❌ Невірний номер товару. Спробуйте ще раз:');  
    }  
  } else {  
    const newIndex = parseInt(text) - 1;  
    if (newIndex >= 0 && newIndex < products.length) {  
      const product = products[state.selectedIndex];  
      products.splice(state.selectedIndex, 1);  
      products.splice(newIndex, 0, product);  
      saveData();  
      bot.sendMessage(chatId, `✅ Порядок товарів оновлено`);  
      showMainMenu(chatId);  
    } else {  
      bot.sendMessage(chatId, '❌ Невірна позиція. Спробуйте ще раз:');  
    }  
  }
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на порту ${PORT}`);
  loadData();
});
