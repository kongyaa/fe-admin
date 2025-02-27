import { z } from 'zod';

export const PostSchema = z.object({
  id: z.number(),
  title: z.string(),
  content: z.string(),
  createdAt: z.string(),
  userId: z.number(),
});

export const CreatePostSchema = PostSchema.omit({ id: true, createdAt: true });
export const UpdatePostSchema = PostSchema.partial().extend({ id: z.number() });

export type Post = z.infer<typeof PostSchema>;
export type CreatePost = z.infer<typeof CreatePostSchema>;
export type UpdatePost = z.infer<typeof UpdatePostSchema>; 