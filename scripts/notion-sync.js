const { Client } = require('@notionhq/client');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');

// Notion 클라이언트 초기화
const notion = new Client({
  auth: process.env.NOTION_KEY,
});

const REPORTS_DIR = path.join(__dirname, '../docs/investment/analysis/reports');

async function convertMarkdownToNotionBlocks(markdown) {
  const tokens = marked.lexer(markdown);
  const blocks = [];
  
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        blocks.push({
          object: 'block',
          type: 'heading_' + token.depth,
          ['heading_' + token.depth]: {
            rich_text: [{
              type: 'text',
              text: { content: token.text }
            }]
          }
        });
        break;
        
      case 'paragraph':
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{
              type: 'text',
              text: { content: token.text }
            }]
          }
        });
        break;
        
      case 'list':
        token.items.forEach(item => {
          blocks.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{
                type: 'text',
                text: { content: item.text }
              }]
            }
          });
        });
        break;
    }
  }
  
  return blocks;
}

async function createNotionPage(title, blocks) {
  try {
    const response = await notion.pages.create({
      parent: {
        database_id: process.env.NOTION_DATABASE_ID,
      },
      properties: {
        Name: {
          title: [
            {
              text: {
                content: title,
              },
            },
          ],
        },
        Date: {
          date: {
            start: new Date().toISOString().split('T')[0],
          },
        },
      },
      children: blocks,
    });
    
    console.log('Successfully created Notion page:', response.url);
    return response;
  } catch (error) {
    console.error('Error creating Notion page:', error);
    throw error;
  }
}

async function syncReportsToNotion() {
  try {
    // Git에서 변경된 파일 목록 가져오기
    const gitOutput = require('child_process')
      .execSync('git diff --name-only HEAD HEAD~1')
      .toString()
      .trim();
    
    const changedFiles = gitOutput
      .split('\n')
      .filter(file => file.startsWith('docs/investment/analysis/reports/') && file.endsWith('.md'));
    
    for (const file of changedFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const title = path.basename(file, '.md');
      
      // Markdown을 Notion 블록으로 변환
      const blocks = await convertMarkdownToNotionBlocks(content);
      
      // Notion 페이지 생성
      await createNotionPage(title, blocks);
      console.log(`Synced ${file} to Notion`);
    }
  } catch (error) {
    console.error('Error syncing reports to Notion:', error);
    process.exit(1);
  }
}

// 스크립트 실행
syncReportsToNotion(); 