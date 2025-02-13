import { z } from 'zod';

export const PostSchema: z.ZodObject<{
  id: z.ZodNumber;
  title: z.ZodString;
  body: z.ZodString;
  userId: z.ZodNumber;
}>;

export type Post = z.infer<typeof PostSchema>;
export type CreatePost = Omit<Post, 'id'>;
export type UpdatePost = Partial<Post> & { id: number };

export class PostsClient {
  getPosts(): Promise<Post[]>;
  getPost(id: number): Promise<Post>;
  createPost(post: CreatePost): Promise<Post>;
  updatePost(post: UpdatePost): Promise<Post>;
  deletePost(id: number): Promise<void>;
} 