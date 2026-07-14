import { useState, useEffect } from 'react';
import { PantryItem, ShoppingListItem } from '../types';

const PANTRY_KEY = 'pantry_pilot_items';
const SHOPPING_LIST_KEY = 'pantry_pilot_shopping_list';

export function usePantryData() {
  const [items, setItems] = useState<PantryItem[]>([]);
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedItems = localStorage.getItem(PANTRY_KEY);
    const savedShopping = localStorage.getItem(SHOPPING_LIST_KEY);

    if (savedItems) {
      setItems(JSON.parse(savedItems));
    }
    if (savedShopping) {
      setShoppingList(JSON.parse(savedShopping));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!loading) {
      localStorage.setItem(PANTRY_KEY, JSON.stringify(items));
    }
  }, [items, loading]);

  useEffect(() => {
    if (!loading) {
      localStorage.setItem(SHOPPING_LIST_KEY, JSON.stringify(shoppingList));
    }
  }, [shoppingList, loading]);

  const addItem = (item: PantryItem) => {
    setItems((prev) => [...prev, { ...item, id: Date.now().toString() }]);
  };

  const updateItem = (id: string, updates: Partial<PantryItem>) => {
    setItems((prev) => prev.map(i => i.id === id ? { ...i, ...updates } : i));
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter(i => i.id !== id));
  };

  const toggleShoppingItem = (id: string) => {
    setShoppingList((prev) => prev.map(i => i.id === id ? { ...i, purchased: !i.purchased } : i));
  };

  const addShoppingItem = (name: string) => {
    setShoppingList((prev) => [...prev, { id: Date.now().toString(), name, purchased: false }]);
  };

  return { items, shoppingList, addItem, updateItem, removeItem, toggleShoppingItem, addShoppingItem, loading };
}
