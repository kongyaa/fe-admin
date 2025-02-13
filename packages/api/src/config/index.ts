export const API_CONFIG = {
  baseURL: 'https://pokeapi.co/api/v2',
  defaultParams: {
    limit: 20,
  },
  timeout: 10000, // 10초
} as const;

export const CACHE_CONFIG = {
  ttl: 5 * 60 * 1000, // 5분
  maxSize: 100, // 최대 100개 항목
} as const; 