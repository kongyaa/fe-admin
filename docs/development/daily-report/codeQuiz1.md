다음과 같은 코드의 동작과 차이점을 설명하도록 요청:

```typescript
// 코드 1
const promiseOne = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  console.log(`tick ${Date.now()}`);
  return promiseOne();
};

promiseOne();

// 코드 2
const promiseTwo = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  console.log(`tick ${Date.now()}`);
};

const loop = async () => {
  while (true) {
    await promiseTwo();
  }
};

loop();
```
