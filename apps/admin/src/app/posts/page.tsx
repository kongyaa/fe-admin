'use client';

import { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, message } from 'antd';
import { PostsClient, type Post, type CreatePost } from '@fe-admin/api';

const PostsPage = () => {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [form] = Form.useForm();
  const [editingPost, setEditingPost] = useState<Post | null>(null);

  const client = new PostsClient();

  const fetchPosts = async () => {
    try {
      const data = await client.getPosts();
      setPosts(data);
    } catch (error) {
      message.error('Failed to fetch posts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPosts();
  }, []);

  const handleCreate = async (values: CreatePost) => {
    try {
      await client.createPost(values);
      message.success('Post created successfully');
      setIsModalVisible(false);
      form.resetFields();
      fetchPosts();
    } catch (error) {
      message.error('Failed to create post');
    }
  };

  const handleEdit = async (values: CreatePost) => {
    if (!editingPost) return;

    try {
      await client.updatePost({ ...values, id: editingPost.id });
      message.success('Post updated successfully');
      setIsModalVisible(false);
      setEditingPost(null);
      form.resetFields();
      fetchPosts();
    } catch (error) {
      message.error('Failed to update post');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await client.deletePost(id);
      message.success('Post deleted successfully');
      fetchPosts();
    } catch (error) {
      message.error('Failed to delete post');
    }
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
    },
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
    },
    {
      title: 'Body',
      dataIndex: 'body',
      key: 'body',
      ellipsis: true,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (text: string, record: Post) => (
        <div className="space-x-2">
          <Button
            onClick={() => {
              setEditingPost(record);
              form.setFieldsValue(record);
              setIsModalVisible(true);
            }}
          >
            Edit
          </Button>
          <Button danger onClick={() => handleDelete(record.id)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Posts</h1>
        <Button
          type="primary"
          onClick={() => {
            setEditingPost(null);
            form.resetFields();
            setIsModalVisible(true);
          }}
        >
          Create Post
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={posts}
        rowKey="id"
        loading={loading}
      />

      <Modal
        title={editingPost ? 'Edit Post' : 'Create Post'}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingPost(null);
          form.resetFields();
        }}
        footer={null}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={editingPost ? handleEdit : handleCreate}
        >
          <Form.Item
            name="title"
            label="Title"
            rules={[{ required: true, message: 'Please input title!' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="body"
            label="Body"
            rules={[{ required: true, message: 'Please input body!' }]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="userId" initialValue={1} hidden>
            <Input />
          </Form.Item>
          <Form.Item className="text-right">
            <Button type="primary" htmlType="submit">
              {editingPost ? 'Update' : 'Create'}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default PostsPage; 