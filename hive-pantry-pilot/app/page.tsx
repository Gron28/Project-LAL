"use client";
import React, { useState } from 'react';
import { usePantryData } from '../hooks/usePantryData';
import PantryItemCard from '../components/PantryItemCard';

import { PantryItem, ShoppingListItem, FilterType } from '../types';

export default function PantryPage() {
  const { items, shoppingList, addItem, updateItem, removeItem, toggleShoppingItem, addShoppingItem, loading } = usePantryData();
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');

  const filteredItems = items.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filter === 'all' || item.category === filter;
    return matchesSearch && matchesFilter;
  });

  if (loading) return <div className="p-4">Loading...</div>;

  const handleAddItem = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newItem: PantryItem = {
      name: formData.get('name') as string,
      quantity: Number(formData.get('quantity')),
      unit: formData.get('unit') as string,
      category: formData.get('category') as any,
      expiryDate: formData.get('expiryDate') ? new Date(formData.get('expiryDate') as string) : undefined,
    };
    addItem(newItem);
    e.currentTarget.reset();
  };

  const handleAddShoppingItem = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = (e.target as HTMLFormElement).elements.shoppingName.value;
    if (name) {
      addShoppingItem(name);
      (e.target as HTMLFormElement).reset();
    }
  };

  return (
    <div className="max-w-md mx-auto p-4 bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-6 text-center text-blue-600">Pantry Pilot</h1>

      {/* Pantry Section */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 border-b pb-2">Pantry & Fridge</h2>
        <div className="mb-4 flex gap-2">
          <input
            type="text"
            placeholder="Search items..."
            className="border rounded px-3 py-2 w-full"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select
            className="border rounded px-3 py-2"
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterType)}
          >
            <option value="all">All</option>
            <option value="pantry">Pantry</option>
            <option value="fridge">Fridge</option>
            <option value="freezer">Freezer</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div className="space-y-2 mb-6">
          {filteredItems.map(item => (
            <PantryItemCard key={item.id} item={item} onUpdate={updateItem} onRemove={removeItem} />
          ))}
        </div>

        <form onSubmit={handleAddItem} className="bg-white p-4 rounded shadow-sm border">
          <h3 className="font-bold mb-2 text-sm">Add New Item</h3>
          <input name="name" placeholder="Item Name" required className="border w-full mb-2 p-2 rounded" />
          <div className="flex gap-2 mb-2">
            <input name="quantity" type="number" placeholder="Qty" required className="border w-1/3 p-2 rounded" />
            <input name="unit" placeholder="Unit (e.g. kg, pcs)" required className="border w-1/3 p-2 rounded" />
          </div>
          <select name="category" className="border w-full mb-2 p-2 rounded">
            <option value="pantry">Pantry</option>
            <option value="fridge">Fridge</option>
            <option value="freezer">Freezer</option>
            <option value="other">Other</option>
          </select>
          <input name="expiryDate" type="date" className="border w-full mb-4 p-2 rounded" />
          <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded font-bold">Add to Pantry</button>
        </form>
      </section>

      {/* Shopping List Section */}
      <section>
        <h2 className="text-xl font-semibold mb-4 border-b pb-2">Shopping List</h2>
        <div className="mb-4 flex gap-2">
          <form onSubmit={handleAddShoppingItem} className="flex w-full gap-2">
            <input
              name="shoppingName"
              placeholder="Add to shopping list..."
              className="border rounded px-3 py-2 w-full"
            />
            <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded">+</button>
          </form>
        </div>

        <div className="space-y-1">
          {shoppingList.map(item => (
            <ShoppingListItem key={item.id} item={item} onToggle={toggleShoppingItem} />
          ))}
        </div>
      </section>
    </div>
  );
}
