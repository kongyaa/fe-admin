import type { ZodType } from 'zod';
import { PostSchema, type Post, type CreatePost, type UpdatePost } from './types';

const BASE_URL = 'http://localhost:4000';

export class PostsClient {
  private async fetchWithValidation<T>(
    url: string,
    options?: RequestInit,
    schema?: ZodType<T>
  ): Promise<T> {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (schema) {
      return schema.parse(data);
    }
    return data;
  }

  async getPosts(): Promise<Post[]> {
    return this.fetchWithValidation(`${BASE_URL}/posts`, undefined, PostSchema.array());
  }

  async getPost(id: number): Promise<Post> {
    return this.fetchWithValidation(`${BASE_URL}/posts/${id}`, undefined, PostSchema);
  }

  async createPost(post: CreatePost): Promise<Post> {
    return this.fetchWithValidation(
      `${BASE_URL}/posts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(post),
      },
      PostSchema
    );
  }

  async updatePost(post: UpdatePost): Promise<Post> {
    return this.fetchWithValidation(
      `${BASE_URL}/posts/${post.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(post),
      },
      PostSchema
    );
  }

  async deletePost(id: number): Promise<void> {
    await this.fetchWithValidation(`${BASE_URL}/posts/${id}`, {
      method: 'DELETE',
    });
  }
} 