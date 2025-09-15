import { useState, useEffect, useRef } from 'react';

export function useWebSocket() {
  const [ws, setWs] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    connect();
    
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (ws) {
        ws.close();
      }
    };
  }, []);

  const connect = async () => {
    try {
      // Get authentication token
      const token = localStorage.getItem('auth-token');
      if (!token) {
        // No authentication token found for WebSocket connection
        return;
      }
      // Starting WebSocket connection
      
      // Fetch server configuration to get the correct WebSocket URL
      let wsBaseUrl;
      try {
        const configResponse = await fetch('/api/config', {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        const config = await configResponse.json();
        wsBaseUrl = config.wsUrl;
        
        // If the config returns localhost but we're not on localhost, use current host but with API server port
        if (wsBaseUrl.includes('localhost') && !window.location.hostname.includes('localhost')) {
          // console.warn('Config returned localhost, using current host with API server port instead');
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          // For development, API server is typically on port 4008 when Vite is on 4009
          const apiPort = window.location.port === '4009' ? '4008' : window.location.port;
          wsBaseUrl = `${protocol}//${window.location.hostname}:${apiPort}`;
        }
      } catch (error) {
        // console.warn('Could not fetch server config, falling back to current host with API server port');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // For development, API server is typically on port 4008 when Vite is on 4009
        const apiPort = window.location.port === '4009' ? '4008' : window.location.port;
        wsBaseUrl = `${protocol}//${window.location.hostname}:${apiPort}`;
      }
      
      // Include token in WebSocket URL as query parameter
      const wsUrl = `${wsBaseUrl}/ws?token=${encodeURIComponent(token)}`;
      // Connecting to WebSocket
      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        // WebSocket connected successfully
        setIsConnected(true);
        setWs(websocket);
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // WebSocket received message
          setMessages(prev => [...prev, data]);
        } catch (error) {
          // Error parsing WebSocket message
        }
      };

      websocket.onclose = (event) => {
        // WebSocket closed
        setIsConnected(false);
        setWs(null);

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          // Attempting to reconnect WebSocket
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        // WebSocket error
      };

    } catch (error) {
      // Error creating WebSocket connection
    }
  };

  const sendMessage = (message) => {
    if (ws && isConnected) {
      // Sending message via WebSocket
      ws.send(JSON.stringify(message));
    } else {
      // WebSocket not connected
    }
  };

  return {
    ws,
    sendMessage,
    messages,
    isConnected
  };
}