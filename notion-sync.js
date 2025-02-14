const { Client } = require('@notionhq/client');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');

// 전역 에러 핸들러 추가
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

// 로깅 함수
function log(message) {
  process.stdout.write(message + '\n');
}

// Notion 클라이언트 초기화
log('Initializing Notion client...');
const notion = new Client({
  auth: process.env.NOTION_KEY
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const REPORTS_DIR = './docs/investment/analysis/reports';

// Markdown을 Notion 블록으로 변환하는 함수
function convertMarkdownToNotionBlocks(markdown) {
  log('Converting markdown to Notion blocks...');
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

  log(`Generated ${blocks.length} Notion blocks`);
  return blocks;
}

// Notion 페이지 생성 함수
async function createNotionPage(title, blocks) {
  log(`Creating Notion page with title: ${title}`);
  try {
    const response = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        "Name": {
          title: [
            {
              type: "text",
              text: {
                content: title
              }
            }
          ]
        },
        "date": {
          date: {
            start: new Date().toISOString().split('T')[0]
          }
        }
      },
      children: blocks
    });

    log(`Successfully created Notion page: ${title}`);
    return response;
  } catch (error) {
    process.stderr.write('Error creating Notion page: ' + error.message + '\n');
    process.stderr.write('Error details: ' + JSON.stringify(error.body || error) + '\n');
    throw error;
  }
}

// 리포트를 Notion으로 동기화하는 함수
async function syncReportsToNotion() {
  try {
    log('Starting reports sync to Notion...');
    log('Checking reports directory: ' + REPORTS_DIR);

    // reports 디렉토리가 없으면 생성
    if (!fs.existsSync(REPORTS_DIR)) {
      log('Creating reports directory...');
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      log('Created reports directory');
    }

    // 모든 마크다운 파일을 재귀적으로 찾기
    function findMarkdownFiles(dir) {
      let results = [];
      const files = fs.readdirSync(dir);
      
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
          results = results.concat(findMarkdownFiles(filePath));
        } else if (file.endsWith('.md')) {
          results.push(filePath);
        }
      }
      
      return results;
    }

    const markdownFiles = findMarkdownFiles(REPORTS_DIR);
    log('Markdown files to process: ' + JSON.stringify(markdownFiles));

    for (const filePath of markdownFiles) {
      log(`Processing file: ${filePath}`);
      const content = fs.readFileSync(filePath, 'utf8');
      const title = path.basename(filePath, '.md');
      
      log('Converting markdown content to blocks...');
      const blocks = convertMarkdownToNotionBlocks(content);
      
      log('Creating Notion page...');
      await createNotionPage(title, blocks);
      
      log(`Synced ${filePath} to Notion`);
    }

    log('All reports synced successfully');
  } catch (error) {
    process.stderr.write('Error syncing reports: ' + error.message + '\n');
    process.exit(1);
  }
}

// 스크립트 실행
process.stdout.write('Starting Notion sync script...\n');
syncReportsToNotion(); 