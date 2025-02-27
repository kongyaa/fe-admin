import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import logger from '../utils/logger';

export class CacheService {
  private cacheDir: string;

  constructor() {
    this.cacheDir = config.cache.dir;
    this.initializeCache();
  }

  private async initializeCache() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      logger.info('Cache directory initialized', { dir: this.cacheDir });
    } catch (error) {
      logger.error('Failed to initialize cache directory', { error });
      throw error;
    }
  }

  private getFilePath(hash: string): string {
    return path.join(this.cacheDir, hash);
  }

  async put(hash: string, data: Buffer): Promise<void> {
    const filePath = this.getFilePath(hash);
    
    try {
      // Verify hash
      const computedHash = crypto
        .createHash('sha256')
        .update(data)
        .digest('hex');
      
      if (computedHash !== hash) {
        throw new Error('Hash mismatch');
      }

      await fs.writeFile(filePath, data);
      logger.info('Cache item stored', { hash, size: data.length });
    } catch (error) {
      logger.error('Failed to store cache item', { hash, error });
      throw error;
    }
  }

  async get(hash: string): Promise<Buffer | null> {
    const filePath = this.getFilePath(hash);
    
    try {
      const data = await fs.readFile(filePath);
      logger.info('Cache hit', { hash });
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('Cache miss', { hash });
        return null;
      }
      logger.error('Failed to retrieve cache item', { hash, error });
      throw error;
    }
  }

  async delete(hash: string): Promise<void> {
    const filePath = this.getFilePath(hash);
    
    try {
      await fs.unlink(filePath);
      logger.info('Cache item deleted', { hash });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to delete cache item', { hash, error });
        throw error;
      }
    }
  }

  async clear(): Promise<void> {
    try {
      const files = await fs.readdir(this.cacheDir);
      await Promise.all(
        files.map(file => fs.unlink(path.join(this.cacheDir, file)))
      );
      logger.info('Cache cleared');
    } catch (error) {
      logger.error('Failed to clear cache', { error });
      throw error;
    }
  }
} 