import { writeFileSync } from 'fs';
import { join } from 'path';

interface InvestmentParams {
  initialInvestment: number;
  monthlyInvestment: number;
  annualReturn: number;
  startDate: Date;
  endDate: Date;
}

interface YearlyResult {
  year: number;
  initialAsset: number;
  additionalInvestment: number;
  yearEndAsset: number;
  yearlyReturn: number;
}

class InvestmentSimulator {
  constructor(private params: InvestmentParams) {}

  private calculateMonthlyReturn(amount: number, months: number): number {
    return amount * (1 + (this.params.annualReturn / 12) * months);
  }

  private calculateYearlyReturn(amount: number): number {
    return amount * (1 + this.params.annualReturn);
  }

  simulate(): YearlyResult[] {
    const results: YearlyResult[] = [];
    let currentAsset = this.params.initialInvestment;
    let currentDate = new Date(this.params.startDate);

    while (currentDate < this.params.endDate) {
      const year = currentDate.getFullYear();
      const monthsInYear = currentDate.getFullYear() === this.params.startDate.getFullYear()
        ? 12 - this.params.startDate.getMonth()
        : currentDate.getFullYear() === this.params.endDate.getFullYear()
          ? this.params.endDate.getMonth() + 1
          : 12;

      const additionalInvestment = this.params.monthlyInvestment * monthsInYear;
      const yearStartAsset = currentAsset;
      
      // 초기 자산에 대한 수익
      const initialAssetReturn = this.calculateYearlyReturn(yearStartAsset);
      
      // 추가 투자금에 대한 평균 수익
      const additionalInvestmentReturn = additionalInvestment * (1 + this.params.annualReturn / 2);
      
      currentAsset = initialAssetReturn + additionalInvestmentReturn;

      results.push({
        year,
        initialAsset: yearStartAsset,
        additionalInvestment,
        yearEndAsset: currentAsset,
        yearlyReturn: currentAsset - yearStartAsset - additionalInvestment,
      });

      currentDate.setFullYear(currentDate.getFullYear() + 1);
    }

    return results;
  }

  generateReport(): string {
    const results = this.simulate();
    let report = '# 투자 시뮬레이션 리포트\n\n';

    report += '## 투자 조건\n';
    report += `- 초기 투자금: ${this.formatKRW(this.params.initialInvestment)}\n`;
    report += `- 월 투자금: ${this.formatKRW(this.params.monthlyInvestment)}\n`;
    report += `- 연간 수익률: ${(this.params.annualReturn * 100).toFixed(1)}%\n`;
    report += `- 투자 기간: ${this.formatDate(this.params.startDate)} - ${this.formatDate(this.params.endDate)}\n\n`;

    report += '## 연도별 실적\n';
    results.forEach(result => {
      report += `### ${result.year}년\n`;
      report += `- 초기 자산: ${this.formatKRW(result.initialAsset)}\n`;
      report += `- 추가 투자: ${this.formatKRW(result.additionalInvestment)}\n`;
      report += `- 연말 자산: ${this.formatKRW(result.yearEndAsset)}\n`;
      report += `- 연간 수익: ${this.formatKRW(result.yearlyReturn)}\n\n`;
    });

    const totalInvestment = this.params.initialInvestment + 
      results.reduce((sum, r) => sum + r.additionalInvestment, 0);
    const finalAsset = results[results.length - 1].yearEndAsset;
    const totalReturn = finalAsset - totalInvestment;
    const years = results.length;
    const annualizedReturn = (Math.pow(finalAsset / totalInvestment, 1 / years) - 1);

    report += '## 최종 성과\n';
    report += `- 총 투자금: ${this.formatKRW(totalInvestment)}\n`;
    report += `- 최종 자산: ${this.formatKRW(finalAsset)}\n`;
    report += `- 총 수익: ${this.formatKRW(totalReturn)}\n`;
    report += `- 총 수익률: ${(totalReturn / totalInvestment * 100).toFixed(1)}%\n`;
    report += `- 연환산 수익률: ${(annualizedReturn * 100).toFixed(1)}%\n`;

    return report;
  }

  private formatKRW(amount: number): string {
    const billion = Math.floor(amount / 100000000);
    const million = Math.floor((amount % 100000000) / 10000);
    
    if (billion > 0) {
      return `${billion}억 ${million > 0 ? million + '만' : ''}원`;
    }
    return `${million}만원`;
  }

  private formatDate(date: Date): string {
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
}

// CLI 실행 함수
async function main() {
  const simulator = new InvestmentSimulator({
    initialInvestment: 150000000, // 1억 5천만원
    monthlyInvestment: 3000000,   // 300만원
    annualReturn: 0.10,           // 10%
    startDate: new Date('2025-02-01'),
    endDate: new Date('2030-12-31'),
  });

  const report = simulator.generateReport();
  
  // docs 폴더에 결과 저장
  const outputPath = join(__dirname, '../docs/investment/analysis/simulation-results.md');
  writeFileSync(outputPath, report, 'utf-8');
  
  console.log('시뮬레이션 완료! 결과가 저장되었습니다:', outputPath);
}

// 스크립트 실행
main().catch(console.error); 