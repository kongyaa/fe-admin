import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

export const config = {
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  cache: {
    dir: process.env.CACHE_DIR || path.join(process.cwd(), 'cache'),
    maxSize: process.env.MAX_CACHE_SIZE ? parseInt(process.env.MAX_CACHE_SIZE, 10) : 5120, // 5GB in MB
  },
  security: {
    turboToken: process.env.TURBO_TOKEN,
    allowedTeams: process.env.ALLOWED_TEAMS ? process.env.ALLOWED_TEAMS.split(',') : [],
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'combined',
  },
} as const;

// Type definitions
export type Config = typeof config;
export type ServerConfig = Config['server'];
export type CacheConfig = Config['cache'];
export type SecurityConfig = Config['security'];
export type LoggingConfig = Config['logging']; 