import { HttpClient } from '../core/http-client';
import { Cache } from '../core/cache';
import { API_CONFIG, CACHE_CONFIG } from '../config';

export interface PokemonListResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: {
    name: string;
    url: string;
  }[];
}

export interface Pokemon {
  id: number;
  name: string;
  height: number;
  weight: number;
  sprites: {
    front_default: string;
    back_default: string;
  };
  types: {
    slot: number;
    type: {
      name: string;
    };
  }[];
}

export class PokemonClient {
  private http: HttpClient;
  private cache: Cache<Pokemon>;
  private listCache: Cache<PokemonListResponse>;

  constructor() {
    this.http = new HttpClient(API_CONFIG.baseURL);
    this.cache = new Cache<Pokemon>(CACHE_CONFIG);
    this.listCache = new Cache<PokemonListResponse>(CACHE_CONFIG);
  }

  async getPokemonList(offset = 0, limit = API_CONFIG.defaultParams.limit): Promise<PokemonListResponse> {
    const cacheKey = `list-${offset}-${limit}`;
    const cached = this.listCache.get(cacheKey);
    
    if (cached) {
      return cached;
    }

    const response = await this.http.get<PokemonListResponse>('/pokemon', {
      params: { offset, limit },
    });

    this.listCache.set(cacheKey, response);
    return response;
  }

  async getPokemon(nameOrId: string | number): Promise<Pokemon> {
    const cacheKey = `pokemon-${nameOrId}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached) {
      return cached;
    }

    const response = await this.http.get<Pokemon>(`/pokemon/${nameOrId}`);
    this.cache.set(cacheKey, response);
    return response;
  }

  clearCache(): void {
    this.cache.clear();
    this.listCache.clear();
  }
} 