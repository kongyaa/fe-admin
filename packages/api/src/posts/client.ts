import type { ZodType } from 'zod';
import { Post, CreatePost, UpdatePost, PostSchema } from './types';

const BASE_URL = 'http://localhost:4000';

export interface Post {
  id: number;
  title: string;
  content: string;
  createdAt: string;
}

export async function getPosts(): Promise<Post[]> {
  const response = await fetch(`${BASE_URL}/posts`);
  if (!response.ok) {
    throw new Error('Failed to fetch posts');
  }
  return response.json();
}

export async function getPost(id: number): Promise<Post> {
  const response = await fetch(`${BASE_URL}/posts/${id}`);
  if (!response.ok) {
    throw new Error('Failed to fetch post');
  }
  return response.json();
}

export async function createPost(post: Omit<Post, 'id' | 'createdAt'>): Promise<Post> {
  const response = await fetch(`${BASE_URL}/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(post),
  });
  if (!response.ok) {
    throw new Error('Failed to create post');
  }
  return response.json();
}

export async function updatePost(id: number, post: Partial<Omit<Post, 'id' | 'createdAt'>>): Promise<Post> {
  const response = await fetch(`${BASE_URL}/posts/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(post),
  });
  if (!response.ok) {
    throw new Error('Failed to update post');
  }
  return response.json();
}

export async function deletePost(id: number): Promise<void> {
  const response = await fetch(`${BASE_URL}/posts/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete post');
  }
}

export class PostsClient {
  private async fetchWithValidation<T>(
    url: string,
    options?: RequestInit,
    schema?: ZodType<T>
  ): Promise<T> {
    console.log(`Fetching ${BASE_URL}${url}...`);
    
    const response = await fetch(`${BASE_URL}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      mode: 'cors',
    });

    console.log(`Response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('Received data:', data);
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