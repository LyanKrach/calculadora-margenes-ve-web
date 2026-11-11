/* pro-config.js — Configuración de pasarela automática (Pabilo) y respaldo manual.
 * IMPORTANTE: Nunca escribas claves privadas de Pabilo (PABILO_API_KEY) ni
 * PABILO_USER_BANK_ID en este archivo. Esas credenciales viven únicamente en
 * Firebase Secret Manager (`functions/`).
 * Los datos públicos de cuenta pueden configurarse aquí o en Firestore (`config/proPayments`).
 */
window.PRO_PAYMENT_CONFIG = {
  api: {
    endpoints: {
      config: 'https://getpropaymentconfig-yqgkyclg5a-uc.a.run.app',
      checkout: 'https://createprocheckout-yqgkyclg5a-uc.a.run.app',
      verify: 'https://verifypropayment-yqgkyclg5a-uc.a.run.app',
      admin: 'https://adminmanagepro-yqgkyclg5a-uc.a.run.app'
    }
  },
  pagoMovil: {
    banco: 'Banco de Venezuela (BDV · 0102)',
    cedulaRif: '31955598',
    telefono: '04220336568',
    titular: ''    // Opcional aquí o en Firestore config/proPayments
  },
  usdt: {
    red: 'Binance Pay (USDT)',
    binanceId: '916942742',
    direccion: ''  // Opcional aquí o en Firestore config/proPayments
  },
  soporte: {
    email: 'soporterefillstore@gmail.com',
    whatsapp: '+584161740312'
  }
};
