require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const DATA_FILE = 'data.json';

if (!TELEGRAM_TOKEN || !ADMIN_CHAT_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID должны быть заданы в .env');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.error(`‼️ Polling error: ${error.code} - ${error.message}`);
});

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

app.use(express.json());
app.use(express.static('public'));

app.get('/api/products', (req, res) => {
  const availableProducts = products
    .filter(p => p.sizes.some(s => s.quantity > 0))
    .map(p => ({
      ...p,
      available: p.sizes.some(s => s.quantity > 0)
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

  let validItems = [];  
  let error = null;  
  
  items.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    if (!product) {  
      error = `Товар ${item.title} більше недоступний`;  
    } else {
      const sizeObj = product.sizes.find(s => s.size === item.size);
      if (!sizeObj) {
        error = `Товар ${product.title} не має розміру ${item.size}`;
      } else if (sizeObj.quantity < item.qty) {  
        error = `Недостатня кількість товару: ${product.title} (розмір: ${item.size}, залишилось: ${sizeObj.quantity})`;  
      } else {  
        validItems.push({
          ...item,
          sizeObj
        });  
      }
    }  
  });  
  
  if (error || validItems.length === 0) {  
    return res.status(400).json({   
      success: false,  
      message: error || 'Немає доступних товарів для замовлення'  
    });  
  }  
  
  validItems.forEach(item => {  
    item.sizeObj.quantity -= item.qty;
  });  
  
  const newOrder = {  
    id: Date.now(),  
    date: new Date().toISOString(),  
    name,  
    contact,  
    items: validItems.map(item => ({ id: item.id, title: item.title, size: item.size, qty: item.qty }))  
  };  
  
  orders.push(newOrder);  
  saveData();  
  
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
  
  const total = validItems.reduce((sum, item) => sum + (product.price * item.qty), 0);  
  message += `\n💵 *Сума замовлення:* ₴${total.toFixed(2)}\n`;  
  message += `⏰ *Дата:* ${new Date().toLocaleString('uk-UA')}`;  
  
  bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' })  
    .catch(err => console.error('❌ Помилка відправки в Telegram:', err));  
  
  res.json({ success: true });
});

const userStates = {};

const STATE = {
  IDLE: 'IDLE',
  ADDING_TITLE: 'ADDING_TITLE',
  ADDING_DESC: 'ADDING_DESC',
  ADDING_PRICE: 'ADDING_PRICE',
  ADDING_SIZES: 'ADDING_SIZES',
  ADDING_QUANTITIES: 'ADDING_QUANTITIES',
  ADDING_PHOTOS: 'ADDING_PHOTOS',
  EDITING_PRODUCT: 'EDITING_PRODUCT',
  EDITING_FIELD: 'EDITING_FIELD',
  EDITING_PHOTOS: 'EDITING_PHOTOS',
  DELETING_PRODUCT: 'DELETING_PRODUCT',
  MOVING_PRODUCT: 'MOVING_PRODUCT'
};

function resetState(chatId) {
  delete userStates[chatId];
}

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

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;
  showMainMenu(chatId);
});

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;
  bot.sendMessage(chatId, '❌ Поточну дію скасовано');  
  showMainMenu(chatId);
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const text = msg.text;  
  const state = userStates[chatId]?.state || STATE.IDLE;  
  
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
    case STATE.ADDING_QUANTITIES:  
      handleAddingQuantities(chatId, text);  
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
          message += `   Розміри:\n`;  
          p.sizes.forEach(s => {
            message += `      ${s.size}: ${s.quantity} шт.\n`;
          });
          message += '\n';  
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

function handleAddingTitle(chatId, text) {
  userStates[chatId].productData.title = text;
  userStates[chatId].state = STATE.ADDING_DESC;
  bot.sendMessage(chatId, '📝 Надішліть опис товару:');
}

function handleAddingDesc(chatId, text) {
  userStates[chatId].productData.desc = text;
  userStates[chatId].state = STATE.ADDING_PRICE;
  bot.sendMessage(chatId, '💰 Надішліть ціну товару (тільки число):');
}

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

function handleAddingSizes(chatId, text) {
  const sizes = text.split(',').map(s => s.trim()).filter(s => s);
  if (sizes.length === 0) {
    bot.sendMessage(chatId, '❌ Введіть хоча б один розмір. Спробуйте ще раз:');
    return;
  }

  userStates[chatId].productData.sizes = sizes.map(size => ({ size, quantity: 0 }));
  userStates[chatId].state = STATE.ADDING_QUANTITIES;
  userStates[chatId].currentSizeIndex = 0;
  askForQuantity(chatId);
}

function askForQuantity(chatId) {
  const state = userStates[chatId];
  const currentSize = state.productData.sizes[state.currentSizeIndex].size;
  bot.sendMessage(chatId, `🔢 Введіть кількість для розміру ${currentSize}:`);
}

function handleAddingQuantities(chatId, text) {
  const state = userStates[chatId];
  const quantity = parseInt(text);

  if (isNaN(quantity) || quantity < 0 || quantity > 1000) {
    bot.sendMessage(chatId, '❌ Кількість повинна бути числом від 0 до 1000. Спробуйте ще раз:');
    return;
  }

  state.productData.sizes[state.currentSizeIndex].quantity = quantity;
  state.currentSizeIndex++;

  if (state.currentSizeIndex < state.productData.sizes.length) {
    askForQuantity(chatId);
  } else {
    state.state = STATE.ADDING_PHOTOS;
    state.productData.photos = [];
    bot.sendMessage(chatId, '🖼 Надішліть фото товару (до 10 фото)');
  }
}

function handleAddingPhotos(chatId, msg) {
  const state = userStates[chatId];
  
  if (msg.photo) {
    if (state.productData.photos.length >= 10) {
      bot.sendMessage(chatId, '❌ Ви вже додали максимальну кількість фото (10)');
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    state.productData.photos.push(photo.file_id);
    
    bot.sendMessage(
      chatId, 
      `🖼 Додано фото ${state.productData.photos.length}/10. Надішліть ще фото або введіть "готово"`
    );
  }
  else if (msg.text && msg.text.toLowerCase() === 'готово') {
    if (state.productData.photos.length === 0) {
      bot.sendMessage(chatId, '❌ Будь ласка, додайте хоча б одне фото');
      return;
    }
    
    const newProduct = {  
      id: Date.now(),  
      ...state.productData  
    };  
      
    products.push(newProduct);  
    saveData();  
      
    bot.sendMessage(chatId, `✅ Товар "${newProduct.title}" успішно додано!`);  
    showMainMenu(chatId);
  }
  else {
    bot.sendMessage(chatId, '❌ Будь ласка, надішліть фото або введіть "готово"');
  }
}

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

function handleEditingField(chatId, msg) {
  const state = userStates[chatId];
  
  if (msg.text === '✅ Завершити редагування') {  
    bot.sendMessage(chatId, '✅ Редагування завершено');  
    saveData();  
    showMainMenu(chatId);  
    return;  
  }  
  
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
        bot.sendMessage(chatId, 'Введіть нову кількість для кожного розміру (у форматі "розмір: кількість, ..."):');
        break;  
      case '✏️ Фото':  
        state.editingField = 'photos';  
        state.state = STATE.EDITING_PHOTOS;
        state.editingPhotos = [];
        bot.sendMessage(chatId, '🖼 Надішліть нові фото товару (до 10 фото). Введіть "готово" коли закінчите.');
        break;  
    }
    return;
  }
  
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
        product.sizes = sizes.map(size => ({ size, quantity: 0 }));
        bot.sendMessage(chatId, `✅ Розміри змінено на: ${sizes.join(', ')}\nТепер встановіть кількість для кожного розміру`);
      }  
      break;  
    case 'quantity':  
      try {
        const updates = msg.text.split(',').map(part => {
          const [size, qtyStr] = part.split(':').map(s => s.trim());
          const quantity = parseInt(qtyStr);
          if (isNaN(quantity)) throw new Error();
          return { size, quantity };
        });
        
        updates.forEach(update => {
          const sizeObj = product.sizes.find(s => s.size === update.size);
          if (sizeObj) {
            sizeObj.quantity = update.quantity;
          }
        });
        
        bot.sendMessage(chatId, `✅ Кількості оновлено`);
      } catch (e) {
        bot.sendMessage(chatId, '❌ Невірний формат. Використовуйте: "S: 10, M: 5, L: 3"');
      }
      break;
  }  
    
  delete state.editingField;  
  saveData();
}

function handleEditingPhotos(chatId, msg) {
  const state = userStates[chatId];
  
  if (msg.photo) {
    if (state.editingPhotos.length >= 10) {
      bot.sendMessage(chatId, '❌ Ви вже додали максимальну кількість фото (10)');
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    state.editingPhotos.push(photo.file_id);
    
    bot.sendMessage(
      chatId, 
      `🖼 Додано фото ${state.editingPhotos.length}/10. Надішліть ще фото або введіть "готово"`
    );
  }
  else if (msg.text && msg.text.toLowerCase() === 'готово') {
    if (state.editingPhotos.length === 0) {
      bot.sendMessage(chatId, '❌ Фото не змінено. Залишаються старі фото.');
    } else {
      state.editingProduct.photos = state.editingPhotos;
      bot.sendMessage(chatId, `✅ Фото оновлено!`);
    }
    
    state.state = STATE.EDITING_FIELD;
    delete state.editingPhotos;
    saveData();
    
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
    bot.sendMessage(chatId, 'Що бажаєте змінити?', menu);
  }
  else {
    bot.sendMessage(chatId, '❌ Будь ласка, надішліть фото або введіть "готово"');
  }
}

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

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на порту ${PORT}`);
  loadData();
});
