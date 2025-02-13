export interface RequestConfig extends RequestInit {
  params?: Record<string, string | number>;
}

export interface HttpError extends Error {
  status: number;
  statusText: string;
  data?: unknown;
}

export class HttpClient {
  constructor(private baseURL: string) {}

  private createUrl(path: string, params?: Record<string, string | number>): string {
    const url = new URL(path, this.baseURL);
    
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }
    
    return url.toString();
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const error = new Error(response.statusText) as HttpError;
      error.status = response.status;
      error.statusText = response.statusText;
      
      try {
        error.data = await response.json();
      } catch {
        // JSON 파싱 실패 시 무시
      }
      
      throw error;
    }

    return response.json();
  }

  async get<T>(path: string, config?: RequestConfig): Promise<T> {
    const url = this.createUrl(path, config?.params);
    const response = await fetch(url, {
      ...config,
      method: 'GET',
    });
    
    return this.handleResponse<T>(response);
  }

  async post<T>(path: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const url = this.createUrl(path, config?.params);
    const response = await fetch(url, {
      ...config,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    
    return this.handleResponse<T>(response);
  }

  async patch<T>(path: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const url = this.createUrl(path, config?.params);
    const response = await fetch(url, {
      ...config,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...config?.headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    
    return this.handleResponse<T>(response);
  }

  async delete<T>(path: string, config?: RequestConfig): Promise<T> {
    const url = this.createUrl(path, config?.params);
    const response = await fetch(url, {
      ...config,
      method: 'DELETE',
    });
    
    return this.handleResponse<T>(response);
  }
} 