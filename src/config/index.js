const config = {
    // URL base del servidor
    socketServerUrl: process.env.NEXT_PUBLIC_SOCKET_URL || 'https://juego-memoria-servidor-soz8.onrender.com',
    
    // Configuración de Socket.io
    socketOptions: {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 10000
    }
  };
  
  export default config