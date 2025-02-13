import { Post, CreatePost, UpdatePost, PostSchema } from './types';

const BASE_URL = 'https://jsonplaceholder.typicode.com';

export class PostsClient {
  private async fetchWithValidation<T>(
    url: string,
    options?: RequestInit,
    schema?: z.ZodType<T>
  ): Promise<T> {
    const response = await fetch(`${BASE_URL}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return schema ? schema.parse(data) : data;
  }

  async getPosts(): Promise<Post[]> {
    return this.fetchWithValidation('/posts', undefined, PostSchema.array());
  }

  async getPost(id: number): Promise<Post> {
    return this.fetchWithValidation(`/posts/${id}`, undefined, PostSchema);
  }

  async createPost(post: CreatePost): Promise<Post> {
    return this.fetchWithValidation(
      '/posts',
      {
        method: 'POST',
        body: JSON.stringify(post),
      },
      PostSchema
    );
  }

  async updatePost(post: UpdatePost): Promise<Post> {
    return this.fetchWithValidation(
      `/posts/${post.id}`,
      {
        method: 'PUT',
        body: JSON.stringify(post),
      },
      PostSchema
    );
  }

  async deletePost(id: number): Promise<void> {
    await this.fetchWithValidation(`/posts/${id}`, {
      method: 'DELETE',
    });
  }
} 