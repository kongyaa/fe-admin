require('dotenv').config();
const { Client } = require('@notionhq/client');

async function testNotion() {
  console.log('Starting Notion API test...');
  
  try {
    const notion = new Client({
      auth: process.env.NOTION_KEY
    });

    // 투자 데이터베이스 테스트
    console.log('\n=== Testing Investment Database ===');
    const investmentDb = await notion.databases.retrieve({
      database_id: process.env.NOTION_INVESTMENT_DATABASE_ID
    });
    console.log('Investment Database properties:', JSON.stringify(investmentDb.properties, null, 2));

    // 여행 데이터베이스 테스트
    console.log('\n=== Testing Travel Database ===');
    const travelDb = await notion.databases.retrieve({
      database_id: process.env.NOTION_TRAVEL_DATABASE_ID
    });
    console.log('Travel Database properties:', JSON.stringify(travelDb.properties, null, 2));

    console.log('\nAll database tests completed successfully!');
    
  } catch (error) {
    console.error('Error occurred:', error.message);
    if (error.code) {
      console.error('Error code:', error.code);
      console.error('Error details:', error.body);
    }
    process.exit(1);
  }
}

// 환경 변수 확인
console.log('Checking environment variables...');
const requiredEnvVars = [
  'NOTION_KEY',
  'NOTION_INVESTMENT_DATABASE_ID',
  'NOTION_TRAVEL_DATABASE_ID'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars.join(', '));
  process.exit(1);
}

console.log('Environment variables check passed');
console.log('Test script starting...');
testNotion().catch(console.error); 