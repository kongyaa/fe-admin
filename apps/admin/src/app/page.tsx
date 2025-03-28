'use client';

import { Button, Layout, Typography } from 'antd';
import Link from 'next/link';

const { Header, Content } = Layout;
const { Title } = Typography;

export default function Home() {
  return (
    <Layout className="min-h-screen">
      <Header className="flex items-center bg-white">
        <Title level={4} className="m-0">Admin Dashboard</Title>
      </Header>
      <Content className="p-6">
        <div className="bg-white p-6 rounded-lg">
          <Title level={2}>Welcome to Admin Dashboard</Title>
          <p className="mb-4">This is a sample admin dashboard built with Next.js and Ant Design.</p>
          <Link href="/pokemon">
            <Button type="primary">View Pokemon List</Button>
          </Link>
        </div>
      </Content>
    </Layout>
  );
}
