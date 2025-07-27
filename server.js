require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) {
  console.error('❌ Отсутствуют переменные окружения');
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.error(`‼️ Ошибка polling: ${error.code} - ${error.message}`);
});

let products = [];
let orders = [];
const DATA_FILE = 'data.json';

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
    .filter(p => p.quantity > 0)
    .map(p => ({ ...p, available: p.quantity > 0 }));
  res.json(availableProducts);
});

app.get('/api/photo/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const fileUrl = await bot.getFileLink(fileId);
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    response.data.pipe(res);
  } catch (error) {
    res.status(404).send('Фото не найдено');
  }
});

app.post('/api/order', (req, res) => {
  const { name, contact, items } = req.body;
  
  let validItems = [];  
  let error = null;  
  
  items.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    if (!product) error = `Товар ${item.title} недоступен`;  
    else if (product.quantity < item.qty) error = `Недостаточно товара: ${product.title}`;  
    else validItems.push(item);  
  });  
  
  if (error || validItems.length === 0) {  
    return res.status(400).json({   
      success: false,  
      message: error || 'Нет доступных товаров'  
    });  
  }  
  
  validItems.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    product.quantity -= item.qty;  
  });  
  
  const newOrder = {  
    id: Date.now(),  
    date: new Date().toISOString(),  
    name,  
    contact,  
    items: validItems  
  };  
  
  orders.push(newOrder);  
  saveData();  
  
  let message = `📦 <b>НОВЫЙ ЗАКАЗ!</b> #${newOrder.id}\n\n`;  
  message += `👤 <b>Имя:</b> ${name}\n`;  
  message += `📞 <b>Контакт:</b> ${contact}\n\n`;  
  message += `🛒 <b>Товары:</b>\n`;  
  
  validItems.forEach(item => {  
    const product = products.find(p => p.id === item.id);  
    message += `- ${product.title} (${item.size})\n`;  
    message += `  Цена: ₴${product.price} x ${item.qty}\n`;  
    message += `  Итого: ₴${(product.price * item.qty).toFixed(2)}\n`;  
  });  
  
  const total = validItems.reduce((sum, item) => {  
    const product = products.find(p => p.id === item.id);  
    return sum + (product.price * item.qty);  
  }, 0);  
  
  message += `\n💵 <b>Сумма заказа:</b> ₴${total.toFixed(2)}\n`;  
  message += `⏰ <b>Дата:</b> ${new Date().toLocaleString('uk-UA')}`;  
  
  bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, message, { parse_mode: 'HTML' })  
    .catch(err => console.error('❌ Ошибка отправки:', err));  
  
  res.json({ success: true });
});

const userStates = {};

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
  MOVING_PRODUCT: 'MOVING_PRODUCT',
  EDITING_PHOTOS: 'EDITING_PHOTOS'
};

function resetState(chatId) {
  delete userStates[chatId];
}

function showMainMenu(chatId) {
  const menu = {
    reply_markup: {
      keyboard: [
        ['➕ Добавить товар', '📋 Список товаров'],
        ['✏️ Редактировать товар', '❌ Удалить товар'],
        ['📦 Заказы', '🔄 Изменить порядок']
      ],
      resize_keyboard: true
    }
  };

  bot.sendMessage(chatId, '👋 <b>Добро пожаловать в панель управления!</b>', { parse_mode: 'HTML', ...menu });  
  resetState(chatId);
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  showMainMenu(chatId);
});

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  bot.sendMessage(chatId, '❌ Действие отменено');  
  showMainMenu(chatId);
});

function handleAddingPhotos(chatId, msg) {
  const state = userStates[chatId];
  
  if (msg.photo) {
    if (state.productData.photos.length >= 10) {
      bot.sendMessage(chatId, '❌ <b>Достигнут лимит в 10 фото!</b>', { parse_mode: 'HTML' });
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    state.productData.photos.push(photo.file_id);
    
    const count = state.productData.photos.length;
    const hearts = '💜'.repeat(count) + '🤍'.repeat(10-count);
    
    bot.sendMessage(
      chatId, 
      `🖼 <b>Добавлено фото:</b> ${count}/10\n${hearts}\nОтправьте еще фото или введите "<b>готово</b>"`, 
      { parse_mode: 'HTML' }
    );
  }
  else if (msg.text && msg.text.toLowerCase() === 'готово') {
    if (state.productData.photos.length === 0) {
      bot.sendMessage(chatId, '❌ <b>Добавьте хотя бы одно фото!</b>', { parse_mode: 'HTML' });
      return;
    }
    
    const newProduct = {  
      id: Date.now(),  
      ...state.productData  
    };  
      
    products.push(newProduct);  
    saveData();  
      
    bot.sendMessage(chatId, `🎉 <b>Товар "${newProduct.title}" успешно добавлен!</b>`, { parse_mode: 'HTML' });  
    showMainMenu(chatId);
  }
  else {
    bot.sendMessage(chatId, '❌ Отправьте фото или введите "<b>готово</b>"', { parse_mode: 'HTML' });
  }
}

function handleEditingPhotos(chatId, msg) {
  const state = userStates[chatId];
  
  if (msg.photo) {
    if (state.photos.length >= 10) {
      bot.sendMessage(chatId, '❌ <b>Достигнут лимит в 10 фото!</b>', { parse_mode: 'HTML' });
      return;
    }
    
    const photo = msg.photo[msg.photo.length - 1];
    state.photos.push(photo.file_id);
    
    const count = state.photos.length;
    const hearts = '💜'.repeat(count) + '🤍'.repeat(10-count);
    
    bot.sendMessage(
      chatId, 
      `📸 <b>Добавлено фото:</b> ${count}/10\n${hearts}\nОтправьте еще фото или введите "<b>сохранить</b>"`, 
      { parse_mode: 'HTML' }
    );
  }
  else if (msg.text && msg.text.toLowerCase() === 'сохранить') {
    if (state.photos.length === 0) {
      bot.sendMessage(chatId, '❌ <b>Добавьте хотя бы одно фото!</b>', { parse_mode: 'HTML' });
      return;
    }
    
    const product = state.editingProduct;
    product.photos = state.photos;
    saveData();
    
    bot.sendMessage(chatId, '✅ <b>Фото товара обновлены!</b>', { parse_mode: 'HTML' });
    
    userStates[chatId].state = STATE.EDITING_FIELD;
    delete userStates[chatId].photos;
    
    const menu = {  
      reply_markup: {  
        keyboard: [  
          ['✏️ Название', '✏️ Описание'],  
          ['✏️ Цена', '✏️ Размеры'],  
          ['✏️ Количество', '✏️ Фото'],  
          ['✅ Завершить редактирование']  
        ],  
        resize_keyboard: true  
      }  
    };
    
    bot.sendMessage(chatId, `✏️ <b>Редактирование:</b> ${product.title}`, { parse_mode: 'HTML', ...menu });  
  }
  else {
    bot.sendMessage(chatId, '❌ Отправьте фото или введите "<b>сохранить</b>"', { parse_mode: 'HTML' });
  }
}

function handleEditingField(chatId, msg) {
  const state = userStates[chatId];
  
  if (msg.text === '✅ Завершить редактирование') {  
    bot.sendMessage(chatId, '✅ <b>Редактирование завершено</b>', { parse_mode: 'HTML' });  
    saveData();  
    showMainMenu(chatId);  
    return;  
  }  
  
  if (!state.editingField) {
    switch (msg.text) {  
      case '✏️ Название':  
        state.editingField = 'title';  
        bot.sendMessage(chatId, '✏️ <b>Введите новое название:</b>', { parse_mode: 'HTML' });  
        break;  
      case '✏️ Описание':  
        state.editingField = 'desc';  
        bot.sendMessage(chatId, '📝 <b>Введите новое описание:</b>', { parse_mode: 'HTML' });  
        break;  
      case '✏️ Цена':  
        state.editingField = 'price';  
        bot.sendMessage(chatId, '💰 <b>Введите новую цену:</b>', { parse_mode: 'HTML' });  
        break;  
      case '✏️ Размеры':  
        state.editingField = 'sizes';  
        bot.sendMessage(chatId, '📏 <b>Введите размеры через запятую:</b>', { parse_mode: 'HTML' });  
        break;  
      case '✏️ Количество':  
        state.editingField = 'quantity';  
        bot.sendMessage(chatId, '🔢 <b>Введите новое количество:</b>', { parse_mode: 'HTML' });  
        break;  
      case '✏️ Фото':  
        state.editingField = 'photos';  
        userStates[chatId] = {
          state: STATE.EDITING_PHOTOS,
          editingProduct: state.editingProduct,
          photos: []
        };
        bot.sendMessage(
          chatId, 
          '📸 <b>Отправьте новые фото (до 10)</b>\nВведите "<b>сохранить</b>" когда закончите', 
          { parse_mode: 'HTML' }
        );  
        return;
    }
    return;
  }
  
  const product = state.editingProduct;  
    
  switch (state.editingField) {  
    case 'title':  
      product.title = msg.text;  
      bot.sendMessage(chatId, `✅ <b>Название изменено:</b>\n${msg.text}`, { parse_mode: 'HTML' });  
      break;  
    case 'desc':  
      product.desc = msg.text;  
      bot.sendMessage(chatId, '✅ <b>Описание обновлено!</b>', { parse_mode: 'HTML' });  
      break;  
    case 'price':  
      const price = parseFloat(msg.text);  
      if (isNaN(price)) {  
        bot.sendMessage(chatId, '❌ <b>Неверный формат цены!</b>', { parse_mode: 'HTML' });  
      } else {  
        product.price = price;  
        bot.sendMessage(chatId, `✅ <b>Цена изменена:</b> ₴${price}`, { parse_mode: 'HTML' });  
      }  
      break;  
    case 'sizes':  
      const sizes = msg.text.split(',').map(s => s.trim()).filter(s => s);  
      if (sizes.length === 0) {  
        bot.sendMessage(chatId, '❌ <b>Не указаны размеры!</b>', { parse_mode: 'HTML' });  
      } else {  
        product.sizes = sizes;  
        bot.sendMessage(chatId, `✅ <b>Размеры обновлены:</b> ${sizes.join(', ')}`, { parse_mode: 'HTML' });  
      }  
      break;  
    case 'quantity':  
      const quantity = parseInt(msg.text);  
      if (isNaN(quantity)) {  
        bot.sendMessage(chatId, '❌ <b>Неверный формат количества!</b>', { parse_mode: 'HTML' });  
      } else {  
        product.quantity = quantity;  
        bot.sendMessage(chatId, `✅ <b>Количество изменено:</b> ${quantity}`, { parse_mode: 'HTML' });  
      }  
      break;  
  }  
    
  delete state.editingField;  
  saveData();
}

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== process.env.TELEGRAM_ADMIN_CHAT_ID) return;

  const text = msg.text;  
  const state = userStates[chatId]?.state || STATE.IDLE;  
  
  if (state !== STATE.IDLE && text && text.startsWith('/')) return;  
  
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
    case '➕ Добавить товар':
      userStates[chatId] = {
        state: STATE.ADDING_TITLE,
        productData: { photos: [] }
      };
      bot.sendMessage(chatId, '📝 <b>Введите название товара:</b>', { parse_mode: 'HTML' });
      break;

    case '📋 Список товаров':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ <b>Список товаров пуст</b>', { parse_mode: 'HTML' });  
      } else {  
        let message = '📦 <b>Список товаров:</b>\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. <b>${p.title}</b>\n`;  
          message += `   💰 Цена: <b>₴${p.price}</b>\n`;  
          message += `   📦 Количество: <b>${p.quantity}</b>\n`;  
          message += `   📏 Размеры: <b>${p.sizes.join(', ')}</b>\n\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });  
      }  
      break;  
        
    case '✏️ Редактировать товар':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ <b>Нет товаров для редактирования</b>', { parse_mode: 'HTML' });  
      } else {  
        userStates[chatId] = { state: STATE.EDITING_PRODUCT };  
        let message = '✏️ <b>Выберите товар для редактирования:</b>\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });  
      }  
      break;  
        
    case '❌ Удалить товар':  
      if (products.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ <b>Нет товаров для удаления</b>', { parse_mode: 'HTML' });  
      } else {  
        userStates[chatId] = { state: STATE.DELETING_PRODUCT };  
        let message = '🗑 <b>Выберите товар для удаления:</b>\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });  
      }  
      break;  
        
    case '📦 Заказы':  
      if (orders.length === 0) {  
        bot.sendMessage(chatId, 'ℹ️ <b>Нет заказов</b>', { parse_mode: 'HTML' });  
      } else {  
        let message = '📋 <b>Последние заказы:</b>\n\n';  
        orders.slice(-5).reverse().forEach(order => {  
          message += `🆔 <b>#${order.id}</b>\n`;  
          message += `👤 <b>${order.name}</b>\n`;  
          message += `📞 ${order.contact}\n`;  
          message += `📅 ${new Date(order.date).toLocaleString('uk-UA')}\n`;  
          message += `🛒 <b>${order.items.length} товаров</b>\n\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });  
      }  
      break;  
        
    case '🔄 Изменить порядок':  
      if (products.length < 2) {  
        bot.sendMessage(chatId, 'ℹ️ <b>Нужно минимум 2 товара</b>', { parse_mode: 'HTML' });  
      } else {  
        userStates[chatId] = { state: STATE.MOVING_PRODUCT };  
        let message = '↕️ <b>Выберите товар для перемещения:</b>\n\n';  
        products.forEach((p, i) => {  
          message += `${i+1}. ${p.title}\n`;  
        });  
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });  
      }  
      break;  
  }
}

function handleAddingTitle(chatId, text) {
  userStates[chatId].productData.title = text;
  userStates[chatId].state = STATE.ADDING_DESC;
  bot.sendMessage(chatId, '📝 <b>Введите описание товара:</b>', { parse_mode: 'HTML' });
}

function handleAddingDesc(chatId, text) {
  userStates[chatId].productData.desc = text;
  userStates[chatId].state = STATE.ADDING_PRICE;
  bot.sendMessage(chatId, '💰 <b>Введите цену товара (только число):</b>', { parse_mode: 'HTML' });
}

function handleAddingPrice(chatId, text) {
  const price = parseFloat(text);
  if (isNaN(price)) {
    bot.sendMessage(chatId, '❌ <b>Цена должна быть числом!</b>\nПопробуйте еще раз:', { parse_mode: 'HTML' });
    return;
  }

  userStates[chatId].productData.price = price;  
  userStates[chatId].state = STATE.ADDING_SIZES;  
  bot.sendMessage(chatId, '📏 <b>Введите размеры через запятую (например: S,M,L):</b>', { parse_mode: 'HTML' });
}

function handleAddingSizes(chatId, text) {
  const sizes = text.split(',').map(s => s.trim()).filter(s => s);
  if (sizes.length === 0) {
    bot.sendMessage(chatId, '❌ <b>Введите хотя бы один размер!</b>\nПопробуйте еще раз:', { parse_mode: 'HTML' });
    return;
  }

  userStates[chatId].productData.sizes = sizes;  
  userStates[chatId].state = STATE.ADDING_QUANTITY;  
  bot.sendMessage(chatId, '🔢 <b>Введите количество товара (от 1 до 100):</b>', { parse_mode: 'HTML' });
}

function handleAddingQuantity(chatId, text) {
  const quantity = parseInt(text);
  if (isNaN(quantity) || quantity < 1 || quantity > 100) {
    bot.sendMessage(chatId, '❌ <b>Количество должно быть числом от 1 до 100!</b>\nПопробуйте еще раз:', { parse_mode: 'HTML' });
    return;
  }

  userStates[chatId].productData.quantity = quantity;  
  userStates[chatId].state = STATE.ADDING_PHOTOS;  
  bot.sendMessage(
    chatId, 
    '🖼 <b>Отправьте фото товара (до 10 фото)</b>\nВведите "<b>готово</b>" когда закончите', 
    { parse_mode: 'HTML' }
  );
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
          ['✏️ Название', '✏️ Описание'],  
          ['✏️ Цена', '✏️ Размеры'],  
          ['✏️ Количество', '✏️ Фото'],  
          ['✅ Завершить редактирование']  
        ],  
        resize_keyboard: true  
      }  
    };  
      
    bot.sendMessage(chatId, `✏️ <b>Редактирование:</b> ${product.title}`, { parse_mode: 'HTML', ...menu });  
  } else {  
    bot.sendMessage(chatId, '❌ <b>Неверный номер товара!</b>\nПопробуйте еще раз:', { parse_mode: 'HTML' });  
  }
}

function handleDeletingProduct(chatId, text) {
  const index = parseInt(text) - 1;
  if (index >= 0 && index < products.length) {
    const product = products[index];
    products.splice(index, 1);
    saveData();
    bot.sendMessage(chatId, `🗑️ <b>Товар удален:</b>\n"${product.title}"`, { parse_mode: 'HTML' });
    showMainMenu(chatId);
  } else {
    bot.sendMessage(chatId, '❌ <b>Неверный номер товара!</b>\nПопробуйте еще раз:', { parse_mode: 'HTML' });
  }
}

function handleMovingProduct(chatId, text) {
  const state = userStates[chatId];

  if (!state.selectedIndex) {  
    const index = parseInt(text) - 1;  
    if (index >= 0 && index < products.length) {  
      state.selectedIndex = index;  
      bot.sendMessage(chatId, '↕️ <b>На какую позицию переместить?</b>\nВведите номер:', { parse_mode: 'HTML' });  
    } else {  
      bot.sendMessage(chatId, '❌ <b>Неверный номер товара!</b>\nПопробуйте еще раз:', { parse_mode: 'HTML' });  
    }  
  } else {  
    const newIndex = parseInt(text) - 1;  
    if (newIndex >= 0 && newIndex < products.length) {  
      const product = products[state.selectedIndex];  
      products.splice(state.selectedIndex, 1);  
      products.splice(newIndex, 0, product);  
      saveData();  
      bot.sendMessage(chatId, '✅ <b>Порядок товаров обновлен!</b>', { parse_mode: 'HTML' });  
      showMainMenu(chatId);  
    } else {  
      bot.sendMessage(chatId, '❌ <b>Неверная позиция!</b>\nПопробуйте еще раз:', { parse_mode: 'HTML' });  
    }  
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  loadData();
});
