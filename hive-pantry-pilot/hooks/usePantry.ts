import { useState, useEffect } from 'react';
import { PantryItem, InventoryState } from '../types';

const STORAGE_KEY = 'pantry_pilot_data';

export function usePantry() {
  const [state, setState] = useState<InventoryState>({ items: [] });
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setState(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse pantry data', e);
      }
    }
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }, [state, isLoaded]);

  const addItem = (item: Omit<PantryItem, 'id'>) => {
    const newItem: PantryItem = {
      ...item,
      id: Math.random().toString(36).substr(2, 9),
    };
    setState(prev => ({ ...prev, items: [...prev.items, newItem] }));
  };

  const updateItem = (id: string, updates: Partial<Omit<PantryItem, 'id'>>) => {
    setState(prev => ({
      ...prev,
      items: prev.items.map(item => item.id === id ? { ...item, ...updates } : item)
    }));
  };

  const removeItem = (id: string) => {
    setState(prev => ({
      ...prev,
      items: prev.items.filter(item => item.id !== id)
    }));
  };

  return { state, addItem, updateItem, removeItem, isLoaded };
}
