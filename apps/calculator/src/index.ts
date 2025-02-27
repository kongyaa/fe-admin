import { add, multiply, complexCalculation, formatCurrency } from '@cache-example/utils';

async function main() {
  console.time('Calculation');
  
  // 복잡한 계산 수행
  const baseNumber = 1000;
  const result1 = complexCalculation(baseNumber);
  console.log('Complex calculation result:', formatCurrency(result1));
  
  // 기본 연산 수행
  const result2 = multiply(add(100, 200), 3);
  console.log('Basic calculation result:', formatCurrency(result2));
  
  console.timeEnd('Calculation');
}

main().catch(console.error); 