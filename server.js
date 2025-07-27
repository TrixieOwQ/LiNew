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
  console.error('🖤❌ TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID должны быть заданы в .env');
  process.exit(1);
}

// Инициализация бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Обработчик ошибок polling
bot.on('polling_error', (error) => {
  console.error(`🖤‼️ Polling error: ${error.code} - ${error.message}`);
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
      console.log(`🖤✅ Данные загружены: ${products.length} товаров, ${orders.length} заказов`);
    }
  } catch (e) {
    console.error('🖤❌ Ошибка загрузки данных:', e);
  }
}

function saveData() {
  try {
    const data = JSON.stringify({ products, orders }, null, 2);
    fs.writeFileSync(DATA_FILE, data);
    console.log('🖤💾 Данные сохранены');
  } catch (e) {
    console.error('🖤❌ Ошибка сохранения данных:', e);
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API для сайта
app.get('/api/products', (req, res) => {
  const availableProducts = products
    .filter(p => {
      return Object.values(p.quantities).some(qty => qty > 0);
    })
    .map(p => ({
      ...p,
      available: Object.values(p.quantities).some(qty => qty > 0)
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
    console.error('🖤❌ Error fetching photo:', error);
    res.status(404).send('🖤❌ Фото не знайдено');
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
      error = `🖤❌ Товар ${item.title} більше недоступний`;  
    } else if (!product.quantities[item.size] || product.quantities[item.size] < item.qty) {  
      error = `🖤❌ Недостатня кількість: ${product.title} (розмір: ${item.size}, залишилось: ${product.quantities[item.size] || 0})`;  
    } else {  
      validItems.push(item);  
    }  
  });  
  
  if (error || validItems.length === 0) {  
    return res.status(400).json({   
      success: false,  
      message: error || '🖤❌ Немає доступних товарів для замовлення'  
    });  
  }  
  
  // Обновление количества  
  validItems.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    product.quantities[item.size] -= item.qty;  
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
  let message = `🖤🦇 *НОВЕ ЗАМОВЛЕННЯ!* #${newOrder.id}\n`;  
  message += `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n`;  
  message += `👤 *Ім'я:* ${name}\n`;  
  message += `📞 *Контакт:* ${contact}\n\n`;  
  message += `🛒 *Товари:*\n`;  
  
  validItems.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    message += `- ${product.title} (${item.size})\n`;  
    message += `  💰 Ціна: ₴${product.price} x ${item.qty}\n`;  
    message += `  🖤 Загалом: ₴${(product.price * item.qty).toFixed(2)}\n`;  
  });  
  
  const total = validItems.reduce((sum, item) => {  
    const product = products.find(p => p.id === item.id);  
    return sum + (product.price * item.qty);  
  }, 0);  
  
  message += `\n💀 *Сума замовлення:* ₴${total.toFixed(2)}\n`;  
  message += `⏳ *Дата:* ${new Date().toLocaleString('uk-UA')}`;  
  
  // Отправка в Telegram  
  bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' })  
    .catch(err => console.error('🖤❌ Помилка відправки в Telegram:', err));  
  
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
  ADDING_QUANTITY_FOR_SIZE: 'ADDING_QUANTITY_FOR_SIZE',
  ADDING_PHOTOS: 'ADDING_PHOTOS',
  EDITING_PRODUCT: 'EDITING_PRODUCT',
  EDITING_FIELD: 'EDITING_FIELD',
  EDITING_PHOTOS: 'EDITING_PHOTOS',
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
        ['🖤 Додати товар', '🕸 Список товарів'],
        ['🔮 Редагувати товар', '💀 Видалити товар'],
        ['🧛 Замовлення', '🔄 Змінити порядок']
      ],
      resize_keyboard: true
    }
  };

  const welcomeMessage = `
🖤🦇 *Темний Лабіринт Торгівлі*
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
Оберіть дію з меню нижче...
  `;
  
  bot.sendMessage(chatId, welcomeMessage, { 
    parse_mode: 'Markdown',
    ...menu 
  });  
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

  bot.sendMessage(chatId, '🖤❌ Дію скасовано');  
  showMainMenu(chatId);
});

// =================================================
// ГОТИЧЕСКИЙ СТИЛЬ - ИНТЕРФЕЙС
// =================================================

// Обработка фото при добавлении товара
function handleAddingPhotos(chatId, msg) {
  const state = userStates[chatId];
  
  // Если пришло фото
  if (msg.photo) {
    if (state.productData.photos.length >= 10) {
      bot.sendMessage(chatId, '🖤❌ Максимум 10 фото');
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    state.productData.photos.push(photo.file_id);
    
    bot.sendMessage(
      chatId, 
      `🖤🖼 Додано фото: ${state.productData.photos.length}/10\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
      `Надішліть ще фото або напишіть "🖤 готово"`
    );
  }
  // Если пришло текстовое сообщение "готово"
  else if (msg.text && (msg.text.toLowerCase() === 'готово' || msg.text.includes('🖤 готово'))) {
    // Проверка наличия фото
    if (state.productData.photos.length === 0) {
      bot.sendMessage(chatId, '🖤❌ Додайте хоча б одне фото');
      return;
    }
    
    // Сохранение товара  
    const newProduct = {  
      id: Date.now(),  
      ...state.productData  
    };  
      
    products.push(newProduct);  
    saveData();  
      
    const successMsg = `
🖤✅ *Товар додано!*
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
Назва: ${newProduct.title}
Ціна: ₴${newProduct.price}
    `;
    
    bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });  
    showMainMenu(chatId);
  }
  // Неподдерживаемый тип
  else {
    bot.sendMessage(
      chatId, 
      '🖤❌ Надішліть фото або напишіть "🖤 готово"'
    );
  }
}

// Обработка фото при редактировании товара
function handleEditingPhotos(chatId, msg) {
  const state = userStates[chatId];
  
  // Если пришло фото
  if (msg.photo) {
    if (state.photos.length >= 10) {
      bot.sendMessage(chatId, '🖤❌ Максимум 10 фото');
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    state.photos.push(photo.file_id);
    
    bot.sendMessage(
      chatId, 
      `🖤🖼 Додано фото: ${state.photos.length}/10\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
      `Надішліть ще фото або напишіть "🖤 готово"`
    );
  }
  // Если пришло текстовое сообщение "готово"
  else if (msg.text && (msg.text.toLowerCase() === 'готово' || msg.text.includes('🖤 готово'))) {
    // Проверка наличия фото
    if (state.photos.length === 0) {
      bot.sendMessage(chatId, '🖤❌ Додайте хоча б одне фото');
      return;
    }
    
    // Обновляем товар
    const product = state.editingProduct;
    product.photos = state.photos;
    saveData();
    
    bot.sendMessage(chatId, `🖤✅ Фото оновлено!`);
    
    // Возвращаемся в меню редактирования
    state.state = STATE.EDITING_FIELD;
    delete state.photos;
    
    // Покажем меню редактирования
    const menu = {
      reply_markup: {
        keyboard: [
          ['✏️ Назва', '✏️ Опис'],
          ['✏️ Ціна', '✏️ Розміри'],
          ['✏️ Кількість', '✏️ Фото'],
          ['🖤 Завершити редагування']
        ],
        resize_keyboard: true
      }
    };
    
    bot.sendMessage(chatId, `🔮 Що бажаєте змінити?`, menu);
  }
  // Неподдерживаемый тип
  else {
    bot.sendMessage(
      chatId, 
      '🖤❌ Надішліть фото або напишіть "🖤 готово"'
    );
  }
}

// Обработка количества для каждого размера
function handleAddingQuantityForSize(chatId, text) {
  const state = userStates[chatId];
  const currentSize = state.sizes[state.currentSizeIndex];
  const quantity = parseInt(text);

  if (isNaN(quantity)) {
    bot.sendMessage(chatId, '🖤❌ Введіть число');
    return;
  }

  // Сохраняем количество для текущего размера
  state.productData.quantities[currentSize] = quantity;
  state.currentSizeIndex++;

  // Если остались размеры
  if (state.currentSizeIndex < state.sizes.length) {
    bot.sendMessage(chatId, `🖤🔢 Кількість для розміру ${state.sizes[state.currentSizeIndex]}:`);
  } else {
    // Переходим к фото
    state.state = STATE.ADDING_PHOTOS;
    state.productData.photos = [];
    
    const photoMsg = `
🖤🖼 *Додавання фото*
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
Надішліть фото товару (до 10)
Коли закінчите - напишіть "🖤 готово"
    `;
    
    bot.sendMessage(chatId, photoMsg, { parse_mode: 'Markdown' });
  }
}

// =================================================
// ОСНОВНОЙ КОД С ГОТИЧЕСКИМ СТИЛЕМ
// =================================================

// Обработка сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const text = msg.text;  
  const state = userStates[chatId]?.state || STATE.IDLE;  
  
  // Если команда
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
    case STATE.ADDING_QUANTITY_FOR_SIZE:  
      handleAddingQuantityForSize(chatId, text);  
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
    case STATE.EDITING_PHOTOS:  
      handleEditingPhotos(chatId, msg);  
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
    case '🖤 Додати товар':
      userStates[chatId] = {
        state: STATE.ADDING_TITLE,
        productData: {
          quantities: {}
        }
      };
      bot.sendMessage(chatId, '🖤📝 Назва товару:');
      break;

    case '🕸 Список товарів':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, '🖤ℹ️ Товарів немає');  
      } else {  
        let message = '🖤🕸 *Список товарів*\n';  
        message += '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n';  
        products.forEach((p, i) => {  
          message += `🖤 ${i+1}. ${p.title}\n`;  
          message += `   💰 Ціна: ₴${p.price}\n`;  
          message += `   🖤 Наявність:\n`;
          for (const [size, qty] of Object.entries(p.quantities)) {
            message += `      - ${size}: ${qty} шт.\n`;
          }
          message += '\n';
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });  
      }  
      break;  
        
    case '🔮 Редагувати товар':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, '🖤ℹ️ Товарів немає');  
      } else {  
        userStates[chatId] = { state: STATE.EDITING_PRODUCT };  
        let message = '🔮 *Виберіть товар*\n';  
        message += '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });  
      }  
      break;  
        
    case '💀 Видалити товар':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, '🖤ℹ️ Товарів немає');  
      } else {  
        userStates[chatId] = { state: STATE.DELETING_PRODUCT };  
        let message = '💀 *Видалити товар*\n';  
        message += '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });  
      }  
      break;  
        
    case '🧛 Замовлення':  
      if (orders.length === 0) {  
        bot.sendMessage(chatId, '🖤ℹ️ Замовлень немає');  
      } else {  
        let message = '🧛 *Останні замовлення*\n';  
        message += '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n';  
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
        bot.sendMessage(chatId, '🖤ℹ️ Потрібно щонайменше 2 товари');  
      } else {  
        userStates[chatId] = { state: STATE.MOVING_PRODUCT };  
        let message = '🔄 *Змінити порядок*\n';  
        message += '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n';  
        message += 'Виберіть товар:\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });  
      }  
      break;  
  }
}

// Добавление товара - обработка названия
function handleAddingTitle(chatId, text) {
  userStates[chatId].productData.title = text;
  userStates[chatId].state = STATE.ADDING_DESC;
  bot.sendMessage(chatId, '🖤📝 Опис товару:');
}

// Добавление товара - обработка описания
function handleAddingDesc(chatId, text) {
  userStates[chatId].productData.desc = text;
  userStates[chatId].state = STATE.ADDING_PRICE;
  bot.sendMessage(chatId, '🖤💰 Ціна товару:');
}

// Добавление товара - обработка цены
function handleAddingPrice(chatId, text) {
  const price = parseFloat(text);
  if (isNaN(price)) {
    bot.sendMessage(chatId, '🖤❌ Введіть число');
    return;
  }

  userStates[chatId].productData.price = price;  
  userStates[chatId].state = STATE.ADDING_SIZES;  
  bot.sendMessage(chatId, '🖤📏 Розміри через кому (наприкл.: S,M,L):');
}

// Добавление товара - обработка размеров
function handleAddingSizes(chatId, text) {
  const sizes = text.split(',').map(s => s.trim()).filter(s => s);
  if (sizes.length === 0) {
    bot.sendMessage(chatId, '🖤❌ Введіть хоча б один розмір');
    return;
  }

  const state = userStates[chatId];
  state.sizes = sizes;
  state.currentSizeIndex = 0;
  state.state = STATE.ADDING_QUANTITY_FOR_SIZE;
  
  bot.sendMessage(chatId, `🖤🔢 Кількість для розміру ${sizes[0]}:`);
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
          ['🖤 Завершити редагування']  
        ],  
        resize_keyboard: true  
      }  
    };  
    
    const msg = `
🔮 *Редагування товару*
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
${product.title}

Що бажаєте змінити?
    `;
      
    bot.sendMessage(chatId, msg, { 
      parse_mode: 'Markdown',
      ...menu 
    });  
  } else {  
    bot.sendMessage(chatId, '🖤❌ Невірний номер');  
  }
}

// Обработка редактирования полей
function handleEditingField(chatId, msg) {
  const state = userStates[chatId];
  const text = msg.text;
  
  // Завершение редактирования
  if (text === '🖤 Завершити редагування') {  
    bot.sendMessage(chatId, '🖤✅ Редагування завершено');  
    saveData();  
    showMainMenu(chatId);  
    return;  
  }  
  
  // Выбор поля
  if (!state.editingField) {
    switch (text) {  
      case '✏️ Назва':  
        state.editingField = 'title';  
        bot.sendMessage(chatId, '🖤📝 Нова назва:');  
        break;  
      case '✏️ Опис':  
        state.editingField = 'desc';  
        bot.sendMessage(chatId, '🖤📝 Новий опис:');  
        break;  
      case '✏️ Ціна':  
        state.editingField = 'price';  
        bot.sendMessage(chatId, '🖤💰 Нова ціна:');  
        break;  
      case '✏️ Розміри':  
        state.editingField = 'sizes';  
        bot.sendMessage(chatId, '🖤📏 Нові розміри через кому:');  
        break;  
      case '✏️ Кількість':  
        state.editingField = 'quantities';  
        bot.sendMessage(chatId, '🖤🔢 Нові кількості (формат: S:10,M:5):');  
        break;  
      case '✏️ Фото':  
        state.state = STATE.EDITING_PHOTOS;
        state.photos = [...state.editingProduct.photos] || [];
        
        const photoMsg = `
🖤🖼 *Редагування фото*
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
Надішліть нові фото (до 10)
Коли закінчите - напишіть "🖤 готово"
        `;
        
        bot.sendMessage(chatId, photoMsg, { parse_mode: 'Markdown' });  
        break;  
    }
    return;
  }
  
  // Обработка введенных значений
  const product = state.editingProduct;  
    
  switch (state.editingField) {  
    case 'title':  
      product.title = text;  
      bot.sendMessage(chatId, `🖤✅ Назву змінено на: ${text}`);  
      break;  
    case 'desc':  
      product.desc = text;  
      bot.sendMessage(chatId, `🖤✅ Опис оновлено`);  
      break;  
    case 'price':  
      const price = parseFloat(text);  
      if (isNaN(price)) {  
        bot.sendMessage(chatId, '🖤❌ Невірний формат');  
      } else {  
        product.price = price;  
        bot.sendMessage(chatId, `🖤✅ Ціну змінено на: ₴${price}`);  
      }  
      break;  
    case 'sizes':  
      const sizes = text.split(',').map(s => s.trim()).filter(s => s);  
      if (sizes.length === 0) {  
        bot.sendMessage(chatId, '🖤❌ Не вказано розміри');  
      } else {  
        // Сохраняем старые количества
        const newQuantities = {};
        sizes.forEach(size => {
          newQuantities[size] = product.quantities[size] || 0;
        });
        product.quantities = newQuantities;
        bot.sendMessage(chatId, `🖤✅ Розміри оновлено: ${sizes.join(', ')}`);  
      }  
      break;  
    case 'quantities':  
      try {
        const newQuantities = {};
        const parts = text.split(',');
        parts.forEach(part => {
          const [size, qty] = part.split(':').map(s => s.trim());
          const quantity = parseInt(qty);
          if (isNaN(quantity)) throw new Error();
          newQuantities[size] = quantity;
        });
        
        // Проверяем размеры
        const sizesExist = Object.keys(newQuantities).every(size => product.quantities[size] !== undefined);
        if (!sizesExist) {
          bot.sendMessage(chatId, '🖤❌ Невірні розміри');
          return;
        }
        
        product.quantities = newQuantities;
        bot.sendMessage(chatId, `🖤✅ Кількості оновлено`);
      } catch (e) {
        bot.sendMessage(chatId, '🖤❌ Формат: S:10,M:5');
        return;
      }
      break;
  }  
    
  // Сбрасываем поле
  delete state.editingField;  
  saveData();
}

// Удаление товара
function handleDeletingProduct(chatId, text) {
  const index = parseInt(text) - 1;
  if (index >= 0 && index < products.length) {
    const product = products[index];
    products.splice(index, 1);
    saveData();
    
    const msg = `
💀 *Товар видалено*
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
${product.title}
    `;
    
    bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    showMainMenu(chatId);
  } else {
    bot.sendMessage(chatId, '🖤❌ Невірний номер');
  }
}

// Изменение порядка товаров
function handleMovingProduct(chatId, text) {
  const state = userStates[chatId];

  if (!state.selectedIndex) {  
    const index = parseInt(text) - 1;  
    if (index >= 0 && index < products.length) {  
      state.selectedIndex = index;  
      bot.sendMessage(chatId, '🖤↕️ На яку позицію перемістити?');  
    } else {  
      bot.sendMessage(chatId, '🖤❌ Невірний номер');  
    }  
  } else {  
    const newIndex = parseInt(text) - 1;  
    if (newIndex >= 0 && newIndex < products.length) {  
      const product = products[state.selectedIndex];  
      products.splice(state.selectedIndex, 1);  
      products.splice(newIndex, 0, product);  
      saveData();  
      bot.sendMessage(chatId, `🖤✅ Порядок оновлено`);  
      showMainMenu(chatId);  
    } else {  
      bot.sendMessage(chatId, '🖤❌ Невірна позиція');  
    }  
  }
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🖤🚀 Сервер запущено на порту ${PORT}`);
  loadData();
});
