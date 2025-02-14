import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

interface MarketData {
  symbol: string;
  price: number;
  timestamp: number;
  source: string;
}

class MarketDataValidator {
  private static instance: MarketDataValidator;
  private ws: WebSocket | null = null;
  private dataCache: Map<string, MarketData[]> = new Map();
  private readonly DATA_DIR = join(__dirname, '../data/market');
  
  private constructor() {
    this.initializeDataDirectory();
  }

  static getInstance(): MarketDataValidator {
    if (!MarketDataValidator.instance) {
      MarketDataValidator.instance = new MarketDataValidator();
    }
    return MarketDataValidator.instance;
  }

  private initializeDataDirectory(): void {
    if (!existsSync(this.DATA_DIR)) {
      mkdirSync(this.DATA_DIR, { recursive: true });
    }
  }

  async validatePrice(symbol: string): Promise<MarketData | null> {
    try {
      // Yahoo Finance API 데이터 조회
      const yahooData = await this.fetchYahooFinanceData(symbol);
      console.log(`[${symbol}] Yahoo Finance 데이터:`, yahooData);
      return yahooData;
    } catch (error) {
      console.error(`Failed to validate price for ${symbol}:`, error);
      return null;
    }
  }

  private async fetchYahooFinanceData(symbol: string): Promise<MarketData> {
    try {
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      
      const price = data.chart.result[0].meta.regularMarketPrice;
      const timestamp = data.chart.result[0].meta.regularMarketTime * 1000;
      
      return {
        symbol,
        price,
        timestamp,
        source: 'yahoo'
      };
    } catch (error) {
      console.error(`Failed to fetch Yahoo Finance data for ${symbol}:`, error);
      throw error;
    }
  }

  async validatePortfolio(): Promise<void> {
    const portfolio = ['JEPI', 'NVDA', 'RIVN', 'LLY'];
    
    console.log('포트폴리오 가격 검증 시작...');
    
    for (const symbol of portfolio) {
      const data = await this.validatePrice(symbol);
      if (data) {
        console.log(`${symbol}: $${data.price.toFixed(2)} (${new Date(data.timestamp).toLocaleString()})`);
      }
    }
  }

  private async fetchAlphaVantageData(symbol: string): Promise<MarketData> {
    // Alpha Vantage API 구현
    throw new Error('Not implemented');
  }

  private validateDataConsistency(data1: MarketData, data2: MarketData): boolean {
    const priceDiff = Math.abs(data1.price - data2.price);
    const threshold = data1.price * 0.001; // 0.1% 임계값
    return priceDiff <= threshold;
  }

  private saveValidatedData(data: MarketData): void {
    const fileName = `${data.symbol}_${new Date().toISOString().split('T')[0]}.json`;
    const filePath = join(this.DATA_DIR, fileName);
    
    let existingData: MarketData[] = [];
    if (existsSync(filePath)) {
      existingData = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    
    existingData.push(data);
    writeFileSync(filePath, JSON.stringify(existingData, null, 2));
  }

  startRealtimeMonitoring(symbols: string[]): void {
    // WebSocket 연결 구현
    this.ws = new WebSocket('wss://your-websocket-endpoint');
    
    this.ws.on('message', (data: string) => {
      const marketData = JSON.parse(data) as MarketData;
      this.handleRealtimeData(marketData);
    });
  }

  private handleRealtimeData(data: MarketData): void {
    const cached = this.dataCache.get(data.symbol) || [];
    cached.push(data);
    
    // 최근 10개 데이터만 유지
    if (cached.length > 10) {
      cached.shift();
    }
    
    this.dataCache.set(data.symbol, cached);
    this.checkPriceAlerts(data);
  }

  private checkPriceAlerts(data: MarketData): void {
    const cached = this.dataCache.get(data.symbol) || [];
    if (cached.length < 2) return;
    
    const previousPrice = cached[cached.length - 2].price;
    const priceChange = (data.price - previousPrice) / previousPrice * 100;
    
    if (Math.abs(priceChange) >= 5) {
      console.log(`[ALERT] ${data.symbol} price changed by ${priceChange.toFixed(2)}%`);
    }
  }
}

// 싱글톤 인스턴스 생성
export const marketDataValidator = MarketDataValidator.getInstance();

// 메인 실행 코드
if (require.main === module) {
  marketDataValidator.validatePortfolio().catch(console.error);
} 