import { Client } from '@notionhq/client';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from 'dotenv';

config();

interface TravelInfo {
  category: string;
  subCategory?: string;
  title: string;
  content: string;
  source: string;
  sourceUrl: string;
  createdAt: Date;
  images?: string[];
  tags?: string[];
  region?: string;
  season?: string;
  difficulty?: string;
  cost?: string;
  groupSize?: string;
}

class MongoliaTravelScraper {
  private notion: Client;
  private databaseId: string;
  private searchKeywords = [
    '몽골 홉스골 투어',
    '홉스골 6월 여행',
    '홉스골 단체 투어',
    '몽골 홉스골 패키지',
    '홉스골 여름 투어'
  ];

  constructor() {
    this.notion = new Client({
      auth: process.env.NOTION_KEY
    });
    this.databaseId = process.env.NOTION_TRAVEL_DATABASE_ID || '';
  }

  private isRelevantContent(info: TravelInfo): boolean {
    const content = info.content.toLowerCase();
    const title = info.title.toLowerCase();
    
    // 홉스골 관련 컨텐츠인지 확인
    const isHuvsgulRelated = content.includes('홉스골') || 
                            content.includes('후브스굴') || 
                            content.includes('huvsgul') || 
                            content.includes('khuvsgul');
    
    // 여름 시즌 여행 정보인지 확인
    const isSummerSeason = content.includes('6월') || 
                          content.includes('7월') || 
                          content.includes('여름');
    
    // 단체/투어 관련 정보인지 확인
    const isGroupTour = content.includes('단체') || 
                       content.includes('투어') || 
                       content.includes('패키지') ||
                       content.includes('여행사');

    return isHuvsgulRelated && isSummerSeason && isGroupTour;
  }

  private categorizeContent(content: string): { category: string, subCategory: string } {
    if (content.includes('투어') || content.includes('패키지')) {
      return { 
        category: '투어',
        subCategory: content.includes('홉스골') ? '홉스골 투어' : '일반 투어'
      };
    }
    
    // 기본값 반환
    return {
      category: '기타',
      subCategory: '일반'
    };
  }

  private extractTags(content: string): string[] {
    const tags = new Set<string>();
    
    // 기본 태그
    tags.add('홉스골');
    tags.add('6월여행');
    tags.add('단체여행');
    
    // 컨텐츠 기반 태그
    if (content.includes('승마')) tags.add('승마체험');
    if (content.includes('캠핑')) tags.add('캠핑');
    if (content.includes('게르')) tags.add('게르숙박');
    if (content.includes('트레킹')) tags.add('트레킹');
    if (content.includes('호수')) tags.add('호수투어');
    
    return Array.from(tags);
  }

  async scrapeNaverBlog(): Promise<TravelInfo[]> {
    const results: TravelInfo[] = [];
    
    for (const keyword of this.searchKeywords) {
      try {
        console.log(`Scraping for keyword: ${keyword}`);
        const url = `https://search.naver.com/search.naver?where=view&query=${encodeURIComponent(keyword)}&sm=tab_viw.blog`;
        
        // 요청 전 잠시 대기
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const response = await axios.get(url);
        console.log(`Response status for ${keyword}:`, response.status);
        
        if (response.status === 200) {
          const $ = cheerio.load(response.data);
          console.log('HTML content length:', response.data.length);
          
          // 디버깅을 위한 HTML 구조 출력
          console.log('Found elements:', $('.lst_total .total_wrap').length);
          
          $('.lst_total .total_wrap, .view_wrap').each((_, element) => {
            try {
              const $element = $(element);
              const title = $element.find('.total_tit, .api_txt_lines').first().text().trim();
              const content = $element.find('.dsc, .total_group .api_txt_lines').first().text().trim();
              const sourceUrl = $element.find('a.total_tit, a.api_txt_lines').attr('href') || '';
              const thumbnailUrl = $element.find('img.thumb').attr('src');
              
              if (title && content) {
                console.log(`Found blog post: "${title}"`);
                const info: TravelInfo = {
                  category: this.categorizeContent(content).category,
                  subCategory: this.categorizeContent(content).subCategory,
                  title,
                  content,
                  source: '네이버 블로그',
                  sourceUrl,
                  createdAt: new Date(),
                  tags: this.extractTags(content),
                  images: thumbnailUrl ? [thumbnailUrl] : undefined
                };
                if (this.isRelevantContent(info)) {
                  info.season = '여름';
                  info.region = '홉스골';
                  info.groupSize = '단체';
                  results.push(info);
                }
              } else {
                console.log('Skipping post due to missing title or content');
              }
            } catch (error) {
              console.error('Error processing blog post:', error);
            }
          });
        } else {
          console.error(`Unexpected status code for ${keyword}:`, response.status);
        }
      } catch (error) {
        console.error(`Error scraping keyword ${keyword}:`, error instanceof Error ? error.message : 'Unknown error');
        if (error && typeof error === 'object' && 'response' in error) {
          const axiosError = error as { response: { status: number; headers: any; data: any } };
          console.error('Error response:', {
            status: axiosError.response.status,
            headers: axiosError.response.headers,
            data: axiosError.response.data
          });
        }
      }
      
      // 다음 키워드 검색 전 대기
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log(`Found ${results.length} blog posts`);
    return results;
  }

  async createNotionPage(info: TravelInfo) {
    try {
      // 내용을 문단으로 분리
      const paragraphs = info.content.split('\n\n').filter(p => p.trim());
      
      // Notion 블록 생성
      const blocks: any[] = [
        {
          type: 'heading_2',
          heading_2: {
            rich_text: [{
              type: 'text',
              text: { content: '📝 상세 내용' }
            }]
          }
        },
        ...paragraphs.map(p => ({
          type: 'paragraph',
          paragraph: {
            rich_text: [{
              type: 'text',
              text: { content: p.trim() }
            }]
          }
        }))
      ];

      // 이미지가 있는 경우 이미지 섹션 추가
      if (info.images && info.images.length > 0) {
        blocks.unshift(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [{
                type: 'text',
                text: { content: '📸 이미지' }
              }]
            }
          },
          ...info.images.map(imageUrl => ({
            type: 'image',
            image: {
              type: 'external',
              external: { url: imageUrl }
            }
          }))
        );
      }

      // 메타 정보 섹션 추가
      blocks.unshift(
        {
          type: 'heading_2',
          heading_2: {
            rich_text: [{
              type: 'text',
              text: { content: '📌 기본 정보' }
            }]
          }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{
              type: 'text',
              text: { content: `카테고리: ${info.category}` }
            }]
          }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{
              type: 'text',
              text: { content: `서브카테고리: ${info.subCategory || '일반'}` }
            }]
          }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{
              type: 'text',
              text: { content: `출처: ${info.source}` }
            }]
          }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{
              type: 'text',
              text: { content: `작성일: ${info.createdAt.toLocaleDateString()}` }
            }]
          }
        }
      );

      // 태그가 있는 경우 태그 섹션 추가
      if (info.tags && info.tags.length > 0) {
        blocks.push(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [{
                type: 'text',
                text: { content: '🏷️ 태그' }
              }]
            }
          },
          {
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{
                type: 'text',
                text: { content: info.tags.join(', ') }
              }]
            }
          }
        );
      }

      const response = await this.notion.pages.create({
        parent: { database_id: this.databaseId },
        properties: {
          "Name": {
            title: [
              {
                type: "text",
                text: {
                  content: info.title
                }
              }
            ]
          },
          "Category": {
            select: {
              name: info.category
            }
          },
          "source": {
            rich_text: [
              {
                type: "text",
                text: {
                  content: info.source
                }
              }
            ]
          },
          "URL": {
            url: info.sourceUrl || null
          },
          "tags": {
            multi_select: [
              ...(info.tags || []).map(tag => ({ name: tag })),
              { name: info.subCategory || '일반' }
            ]
          },
          "Date": {
            date: {
              start: info.createdAt.toISOString()
            }
          }
        },
        children: blocks
      });
      
      console.log(`Successfully created page: ${info.title}`);
      return response;
    } catch (error) {
      console.error('Error creating Notion page:', error);
      throw error;
    }
  }

  async getDatabaseProperties() {
    try {
      const response = await this.notion.databases.retrieve({
        database_id: this.databaseId
      });
      console.log('Database properties:', JSON.stringify(response.properties, null, 2));
      return response.properties;
    } catch (error) {
      console.error('Error retrieving database properties:', error);
      throw error;
    }
  }

  async run() {
    try {
      console.log('Starting Mongolia travel info scraping...');
      
      // 데이터베이스 속성 조회
      console.log('Retrieving database properties...');
      await this.getDatabaseProperties();
      
      // 네이버 블로그 스크래핑
      const blogInfos = await this.scrapeNaverBlog();
      console.log(`Found ${blogInfos.length} blog posts`);

      // Notion에 데이터 저장
      for (const info of blogInfos) {
        await this.createNotionPage(info);
        console.log(`Created Notion page: ${info.title}`);
      }

      console.log('Scraping completed successfully');
    } catch (error) {
      console.error('Error during scraping:', error);
    }
  }
}

// 스크립트 실행
const scraper = new MongoliaTravelScraper();
scraper.run(); 