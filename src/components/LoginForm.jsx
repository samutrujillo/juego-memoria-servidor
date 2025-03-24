'use client';

import { useState } from 'react';
import '@/styles/Login.css';

const LoginForm = ({ socket, onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Por favor, ingresa un nombre de usuario y contraseña');
      return;
    }

    socket.emit('login', { username, password }, (response) => {
      if (response.success) {
        const user = {
          id: response.userId,
          username: response.username,
          score: response.score,
          isBlocked: response.isBlocked
        };
        onLogin(user, response.isAdmin);
      } else {
        setError(response.message);
      }
    });
  };

  return (
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
  );
};

export default LoginForm;