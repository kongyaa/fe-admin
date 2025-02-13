# CRUD 구현 예제

이 문서에서는 JSONPlaceholder API를 사용하여 게시글(Posts) CRUD 작업을 구현하는 방법을 설명합니다.

## 1. API 클라이언트 구조

### 1.1 타입 정의
```typescript
// posts/types.ts
import { z } from 'zod';

export const PostSchema = z.object({
  id: z.number(),
  title: z.string(),
  body: z.string(),
  userId: z.number(),
});

export type Post = z.infer<typeof PostSchema>;
```

### 1.2 API 클라이언트 클래스
```typescript
// posts/client.ts
export class PostsClient {
  private async fetchWithValidation<T>(...) { ... }
  
  async getPosts(): Promise<Post[]> { ... }
  async getPost(id: number): Promise<Post> { ... }
  async createPost(post: CreatePost): Promise<Post> { ... }
  async updatePost(post: UpdatePost): Promise<Post> { ... }
  async deletePost(id: number): Promise<void> { ... }
}
```

## 2. 사용 예제

### 2.1 게시글 목록 조회
```typescript
const postsClient = new PostsClient();

try {
  const posts = await postsClient.getPosts();
  console.log('Posts:', posts);
} catch (error) {
  console.error('Failed to fetch posts:', error);
}
```

### 2.2 게시글 생성
```typescript
const newPost: CreatePost = {
  title: '새로운 게시글',
  body: '게시글 내용입니다.',
  userId: 1
};

try {
  const createdPost = await postsClient.createPost(newPost);
  console.log('Created post:', createdPost);
} catch (error) {
  console.error('Failed to create post:', error);
}
```

### 2.3 게시글 수정
```typescript
const updateData: UpdatePost = {
  id: 1,
  title: '수정된 제목',
  body: '수정된 내용'
};

try {
  const updatedPost = await postsClient.updatePost(updateData);
  console.log('Updated post:', updatedPost);
} catch (error) {
  console.error('Failed to update post:', error);
}
```

### 2.4 게시글 삭제
```typescript
try {
  await postsClient.deletePost(1);
  console.log('Post deleted successfully');
} catch (error) {
  console.error('Failed to delete post:', error);
}
```

## 3. 구현 특징

### 3.1 타입 안정성
- Zod를 사용한 런타임 타입 검증
- TypeScript 타입 추론을 통한 개발 시 타입 안정성 확보

### 3.2 에러 처리
- HTTP 에러 상태 확인 및 적절한 에러 throw
- try-catch를 통한 에러 처리 패턴 제공

### 3.3 유지보수성
- 모듈화된 구조로 확장 용이
- 중복 코드 최소화를 위한 유틸리티 메서드 사용

## 4. 테스트

### 4.1 단위 테스트 예제
```typescript
describe('PostsClient', () => {
  let client: PostsClient;

  beforeEach(() => {
    client = new PostsClient();
  });

  it('should fetch posts successfully', async () => {
    const posts = await client.getPosts();
    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
  });

  it('should create a post successfully', async () => {
    const newPost: CreatePost = {
      title: 'Test Post',
      body: 'Test Content',
      userId: 1
    };
    
    const created = await client.createPost(newPost);
    expect(created.title).toBe(newPost.title);
    expect(created.body).toBe(newPost.body);
  });
});
```

## 5. 실제 사용 시나리오

### 5.1 React 컴포넌트에서 사용
```typescript
const PostsList: React.FC = () => {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  useEffect(() => {
    const fetchPosts = async () => {
      try {
        const client = new PostsClient();
        const fetchedPosts = await client.getPosts();
        setPosts(fetchedPosts);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchPosts();
  }, []);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  
  return (
    <div>
      {posts.map(post => (
        <div key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.body}</p>
        </div>
      ))}
    </div>
  );
};
```

## 다음 단계
- [에러 처리 전략](./03-error-handling.md)
- [캐싱 전략](./04-caching-strategy.md) 