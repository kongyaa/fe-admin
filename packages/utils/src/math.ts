export const add = (a: number, b: number): number => {
  console.log('Adding numbers:', a, b);  // 로그 메시지 변경
  return a + b;
};
export const subtract = (a: number, b: number): number => a - b;
export const multiply = (a: number, b: number): number => a * b;
export const divide = (a: number, b: number): number => {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
};

// 복잡한 계산을 시뮬레이션하기 위한 함수
export const complexCalculation = (input: number): number => {
  // 의도적으로 시간이 걸리는 연산
  let result = input;
  for (let i = 0; i < 1000000; i++) {
    result = Math.sqrt(result * i);
  }
  return result;
}; 