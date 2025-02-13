interface CacheItem<T> {
  value: T;
  timestamp: number;
}

interface CacheConfig {
  ttl: number;
  maxSize: number;
}

export class Cache<T> {
  private cache = new Map<string, CacheItem<T>>();
  
  constructor(private config: CacheConfig) {}

  set(key: string, value: T): void {
    // 캐시가 최대 크기에 도달하면 가장 오래된 항목 제거
    if (this.cache.size >= this.config.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    
    if (!item) {
      return undefined;
    }

    // TTL 체크
    if (Date.now() - item.timestamp > this.config.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return item.value;
  }

  clear(): void {
    this.cache.clear();
  }

  delete(key: string): void {
    this.cache.delete(key);
  }
} 