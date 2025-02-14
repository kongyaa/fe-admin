import { writeFileSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';

interface InvestmentParams {
  initialInvestment: number;
  monthlyContribution: number;
  annualReturn: number;
  startDate: Date;
  endDate: Date;
}

interface MarketData {
  kospiIndex: number;
  kospiChange: number;
  marketVolatility: number;
  sectorPerformance: Record<string, number>;
}

interface SimulationResult {
  currentValue: number;
  totalContributions: number;
  totalReturn: number;
  annualizedReturn: number;
}

class InvestmentAnalyzer {
  private openai: OpenAI;
  private params: InvestmentParams;

  constructor(params: InvestmentParams) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.params = params;
  }

  private async fetchMarketData(): Promise<MarketData> {
    // 실제 구현에서는 외부 API를 통해 시장 데이터를 가져옵니다
    return {
      kospiIndex: 2580.50,
      kospiChange: 0.8,
      marketVolatility: 15.2,
      sectorPerformance: {
        'IT': 2.5,
        'Finance': -0.8,
        'Healthcare': 1.2,
        'Consumer': 0.5
      }
    };
  }

  private calculateSimulation(): SimulationResult {
    const { initialInvestment, monthlyContribution, annualReturn, startDate, endDate } = this.params;
    
    // 투자 기간(월) 계산
    const months = (endDate.getFullYear() - startDate.getFullYear()) * 12 + 
                  (endDate.getMonth() - startDate.getMonth());
    
    // 월 수익률 계산
    const monthlyReturn = Math.pow(1 + annualReturn, 1/12) - 1;
    
    // 총 납입금액 계산
    const totalContributions = initialInvestment + (monthlyContribution * months);
    
    // 최종 투자 금액 계산 (복리 적용)
    let currentValue = initialInvestment;
    for (let i = 0; i < months; i++) {
      currentValue = (currentValue + monthlyContribution) * (1 + monthlyReturn);
    }
    
    // 총 수익률 계산
    const totalReturn = (currentValue - totalContributions) / totalContributions * 100;
    
    // 연환산 수익률 계산
    const years = months / 12;
    const annualizedReturn = (Math.pow(currentValue / totalContributions, 1/years) - 1) * 100;
    
    return {
      currentValue,
      totalContributions,
      totalReturn,
      annualizedReturn
    };
  }

  private async generateAIAnalysis(
    simulationResult: SimulationResult,
    marketData: MarketData
  ): Promise<string> {
    const prompt = `
현재 시장 상황:
- KOSPI 지수: ${marketData.kospiIndex} (전일대비 ${marketData.kospiChange}%)
- 시장 변동성: ${marketData.marketVolatility}%
- 섹터별 성과: ${Object.entries(marketData.sectorPerformance)
  .map(([sector, perf]) => `${sector}: ${perf}%`).join(', ')}

포트폴리오 성과:
- 총 투자금액: ${simulationResult.totalContributions.toLocaleString()}원
- 현재 평가금액: ${simulationResult.currentValue.toLocaleString()}원
- 총 수익률: ${simulationResult.totalReturn.toFixed(2)}%
- 연환산 수익률: ${simulationResult.annualizedReturn.toFixed(2)}%

위 데이터를 바탕으로 다음 내용을 포함하는 투자 분석 리포트를 작성해주세요:
1. 현재 시장 상황 분석
2. 포트폴리오 성과 평가
3. 리스크 요인 분석
4. 향후 전략 제안

전문가의 관점에서 객관적이고 통찰력 있는 분석을 제공해주세요.`;

    const response = await this.openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "당신은 전문 투자 분석가입니다. 데이터를 기반으로 객관적이고 통찰력 있는 분석을 제공합니다."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
    });

    return response.choices[0].message.content || '';
  }

  public async generateReport(): Promise<void> {
    try {
      console.log('시장 데이터 수집 중...');
      const marketData = await this.fetchMarketData();

      console.log('투자 시뮬레이션 수행 중...');
      const simulationResult = this.calculateSimulation();

      console.log('AI 분석 생성 중...');
      const aiAnalysis = await this.generateAIAnalysis(simulationResult, marketData);

      const report = `# 일일 투자 분석 리포트
날짜: ${new Date().toLocaleDateString('ko-KR')}

## 시장 현황
- KOSPI: ${marketData.kospiIndex} (${marketData.kospiChange > 0 ? '+' : ''}${marketData.kospiChange}%)
- 변동성 지수: ${marketData.marketVolatility}%

## 섹터별 성과
${Object.entries(marketData.sectorPerformance)
  .map(([sector, perf]) => `- ${sector}: ${perf > 0 ? '+' : ''}${perf}%`)
  .join('\n')}

## 포트폴리오 성과
- 총 투자금액: ${simulationResult.totalContributions.toLocaleString()}원
- 현재 평가금액: ${simulationResult.currentValue.toLocaleString()}원
- 총 수익률: ${simulationResult.totalReturn.toFixed(2)}%
- 연환산 수익률: ${simulationResult.annualizedReturn.toFixed(2)}%

## AI 분석
${aiAnalysis}

---
*본 리포트는 AI 분석을 포함하고 있으며, 투자 결정의 참고 자료로만 활용하시기 바랍니다.*`;

      const outputPath = join(__dirname, '../docs/investment/analysis/daily-report.md');
      writeFileSync(outputPath, report, 'utf-8');
      console.log('리포트 생성 완료:', outputPath);
    } catch (error) {
      console.error('리포트 생성 중 오류 발생:', error);
      throw error;
    }
  }
}

// 메인 실행 코드
async function main() {
  const params: InvestmentParams = {
    initialInvestment: 150_000_000, // 1억 5천만원
    monthlyContribution: 300_000,   // 30만원
    annualReturn: 0.10,            // 10%
    startDate: new Date('2025-02-14'),
    endDate: new Date('2030-12-31')
  };

  const analyzer = new InvestmentAnalyzer(params);
  await analyzer.generateReport();
}

main().catch(console.error); 