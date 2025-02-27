아래 코드를 주니어 개발자에게 리뷰해주세요.
- 코드 분석 및 개선이 필요한 부분에 대해 설명해주세요.
- 코드 분석 및 개선이 필요한 부분에 대해 예시 코드를 작성해주세요.
- 코드 분석 및 개선이 필요한 부분에 대해 서술형으로 설명을 추가해주세요.

```typescript
function getNames(emailIds) {
  return emailIds.map((emailId) => {
    const user = users.find((user) => {
      return user.email === emailId
    });
    return user?.name || emailId
  })
}
```