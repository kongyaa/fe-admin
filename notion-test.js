const { Client } = require('@notionhq/client');

async function testNotion() {
  console.log('Starting Notion API test...');
  
  try {
    const notion = new Client({
      auth: process.env.NOTION_KEY
    });

    console.log('Attempting to retrieve database...');
    const database = await notion.databases.retrieve({
      database_id: process.env.NOTION_DATABASE_ID
    });

    console.log('Database properties:', JSON.stringify(database.properties, null, 2));
    
  } catch (error) {
    console.error('Error occurred:', error);
    process.exit(1);
  }
}

console.log('Test script starting...');
testNotion().catch(console.error); 