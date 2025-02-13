'use client';

import { Inter } from 'next/font/google';
import { ConfigProvider, theme } from 'antd';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

const themeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 4,
  },
  algorithm: theme.defaultAlgorithm,
  components: {
    Button: {
      controlHeight: 32,
    },
    Table: {
      borderRadius: 8,
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="light">
      <head>
        <title>Admin Dashboard</title>
        <meta name="description" content="Admin dashboard built with Next.js and Ant Design" />
      </head>
      <body className={inter.className}>
        <AntdRegistry>
          <ConfigProvider theme={themeConfig}>
            {children}
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
