const BASE_URL = 'https://pokeapi.co/api/v2';

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

export async function getPokemonList(offset = 0, limit = 20): Promise<PokemonListResponse> {
  const response = await fetch(`${BASE_URL}/pokemon?offset=${offset}&limit=${limit}`);
  if (!response.ok) {
    throw new Error('Failed to fetch pokemon list');
  }
  return response.json();
}

export async function getPokemon(nameOrId: string | number): Promise<Pokemon> {
  const response = await fetch(`${BASE_URL}/pokemon/${nameOrId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch pokemon');
  }
  return response.json();
} 