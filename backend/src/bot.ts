import TelegramBot from 'node-telegram-bot-api';

export function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram bot integration will not start.');
    return;
  }

  // Fallback to a placeholder URL if the env variable isn't set yet
  const webAppUrl = process.env.FRONTEND_URL || 'https://mafia-kvartalski.vercel.app';
  
  const bot = new TelegramBot(token, { polling: true });

  // Handle /start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, `зайди тебя выебу`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{
            text: 'зайти',
            web_app: { url: webAppUrl }
          }]
        ]
      }
    });
  });

  // Configures the bottom-left Menu Button in Telegram
  bot.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: 'Играть',
      web_app: { url: webAppUrl }
    }
  }).catch(err => console.error('Failed to set menu button:', err));

  console.log('Telegram Bot engine initialized successfully.');
}
