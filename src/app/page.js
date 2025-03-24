'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import io from 'socket.io-client';
import '@/styles/Login.css';
import config from '@/config';

// Socket.io se iniciará al cargar el componente
let socket;

export default function Home() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  useEffect(() => {
    // Inicializar socket con la configuración centralizada
    socket = io(config.socketServerUrl, config.socketOptions);

    socket.on('connect', () => {
      console.log('Conectado al servidor con ID:', socket.id);
    });

    socket.on('connect_error', (error) => {
      console.error('Error de conexión con el servidor:', error.message);
      setError('No se pudo conectar con el servidor. Intenta de nuevo más tarde.');
    });

    // Limpiar al desmontar
    return () => {
      socket.disconnect();
    };
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Por favor, ingresa un nombre de usuario y contraseña');
      return;
    }

    console.log(`Intentando iniciar sesión con: ${username}`);
    socket.emit('login', { username, password }, (response) => {
      console.log('Respuesta del servidor:', response);
      
      if (response.success) {
        // Almacenar información de usuario y socket en sessionStorage
        const user = {
          id: response.userId,
          username: response.username,
          score: response.score,
          isBlocked: response.isBlocked,
          isAdmin: response.isAdmin  // Asegurarse de que esta línea esté presente
        };
        
        // Guardar datos completos
        try {
          sessionStorage.setItem('user', JSON.stringify(user));
          console.log('Usuario guardado en sessionStorage:', user);
        } catch (error) {
          console.error('Error al guardar usuario en sessionStorage:', error);
        }
        
        // Redirigir según el rol
        if (response.isAdmin) {
          router.push('/game'); // Cambiado de /admin a /game para usar el mismo panel
        } else {
          router.push('/game');
        }
      } else {
        setError(response.message || 'Error de inicio de sesión');
      }
    });
  };

  return (
    <main className="login-page">
      <div className="login-container">
        <h2>Iniciar Sesión</h2>
        {error && <div className="error-message">{error}</div>}
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="username">Usuario:</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Contraseña:</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="login-button">Entrar</button>
        </form>
      </div>
    </main>
  );
}