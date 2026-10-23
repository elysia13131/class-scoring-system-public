// API配置 - 用于管理后端地址
const PRODUCTION_API_URL = import.meta.env.VITE_API_URL || 'https://your-api.example.com'; // 生产环境API地址（构建时通过 VITE_API_URL 注入）
const DEVELOPMENT_API_URL = 'http://localhost:3001'; // 开发环境API地址

const STORAGE_KEY = 'class_scoring_api_url';

// 判断是否为开发环境
const isDevelopment = () => {
  if (typeof window !== 'undefined') {
    // 检查是否是Capacitor环境（移动应用）
    if (window.Capacitor?.platform !== 'web') {
      return false; // 移动应用使用生产环境
    }
    const hostname = window.location.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  }
  return false;
};

export const getApiUrl = () => {
  if (typeof window !== 'undefined') {
    // 如果是开发环境，自动使用本地服务器
    if (isDevelopment()) {
      return localStorage.getItem(STORAGE_KEY) || DEVELOPMENT_API_URL;
    }
    return localStorage.getItem(STORAGE_KEY) || PRODUCTION_API_URL;
  }
  return isDevelopment() ? DEVELOPMENT_API_URL : PRODUCTION_API_URL;
};

export const setApiUrl = (url) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, url);
  }
};

export const getFullApiUrl = (endpoint) => {
  const baseUrl = getApiUrl();
  if (!baseUrl) {
    return endpoint; // 开发环境使用相对路径
  }
  // 确保baseUrl不以/结尾，endpoint不以/开头
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${cleanBaseUrl}/${cleanEndpoint}`;
};

export const getSocketUrl = () => {
  const baseUrl = getApiUrl();
  if (!baseUrl) {
    return undefined; // 使用默认连接
  }
  return baseUrl;
};
