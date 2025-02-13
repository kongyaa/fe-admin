'use client';

import { useState, useEffect } from 'react';
import { Card, List, Image, Spin, Typography } from 'antd';
import { PokemonClient, type Pokemon } from '@fe-admin/api';

const { Title, Text } = Typography;
const pokemonClient = new PokemonClient();

export default function PokemonPage() {
  const [pokemons, setPokemons] = useState<Pokemon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPokemons() {
      try {
        setLoading(true);
        const list = await pokemonClient.getPokemonList(0, 20);
        const pokemonDetails = await Promise.all(
          list.results.map(pokemon => pokemonClient.getPokemon(pokemon.name))
        );
        setPokemons(pokemonDetails);
      } catch (err) {
        console.error('Error fetching pokemons:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch pokemons');
      } finally {
        setLoading(false);
      }
    }

    fetchPokemons();

    // 컴포넌트 언마운트 시 캐시 정리
    return () => {
      pokemonClient.clearCache();
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Title level={4} className="text-red-500">Error: {error}</Title>
      </div>
    );
  }

  return (
    <div className="p-6">
      <Title level={2}>Pokemon List</Title>
      <List
        grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 4 }}
        dataSource={pokemons}
        renderItem={pokemon => (
          <List.Item>
            <Card
              hoverable
              cover={
                <Image
                  alt={pokemon.name}
                  src={pokemon.sprites.front_default}
                  className="p-4"
                />
              }
            >
              <Card.Meta
                title={<Text className="capitalize">{pokemon.name}</Text>}
                description={
                  <div>
                    <Text>Height: {pokemon.height / 10}m</Text>
                    <br />
                    <Text>Weight: {pokemon.weight / 10}kg</Text>
                    <br />
                    <Text>Types: {pokemon.types.map(t => t.type.name).join(', ')}</Text>
                  </div>
                }
              />
            </Card>
          </List.Item>
        )}
      />
    </div>
  )
} 