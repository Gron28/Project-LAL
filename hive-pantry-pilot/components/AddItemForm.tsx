"use client";
import { useState } from 'react';
import { PantryItem, ShoppingItem } from '../types'

export default function AddItemForm({
  type,
  item,
  onAdd,
}: {
  type: 'pantry' | 'shopping';
  item: Omit<PantryItem, 'id' | 'addedDate'> | Omit<ShoppingItem, 'id' | 'addedDate'>;
  onAdd: (e: React.FormEvent) => void;
}) {
  const [newItem, setNewItem] = useState(item);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setNewItem(prev => ({ ...prev, [name]: value }));
  };

  return (
    <form onSubmit={onAdd} className="space-y-4">
      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">Name</label>
        <input
          type="text"
          id="name"
          name="name"
          value={newItem.name}
          onChange={handleChange}
          required
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">Quantity</label>
          <input
            type="number"
            id="quantity"
            name="quantity"
            value={newItem.quantity}
            onChange={handleChange}
            min="1"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          />
        </div>
        
        <div>
          <label htmlFor="unit" className="block text-sm font-medium text-gray-700">Unit</label>
          <select
            id="unit"
            name="unit"
            value={newItem.unit}
            onChange={handleChange}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          >
            <option value="item">item</option>
            <option value="g">g</option>
            <option value="kg">kg</option>
            <option value="ml">ml</option>
            <option value="l">l</option>
            <option value="piece">piece</option>
            <option value="can">can</option>
            <option value="bottle">bottle</option>
          </select>
        </div>
      </div>
      
      {type === 'pantry' && (
        <div>
          <label htmlFor="expiryDate" className="block text-sm font-medium text-gray-700">Expiry Date</label>
          <input
            type="date"
            id="expiryDate"
            name="expiryDate"
            value={newItem.expiryDate || ''}
            onChange={handleChange}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          />
        </div>
      )}
      
      <div>
        <label htmlFor="category" className="block text-sm font-medium text-gray-700">Category</label>
        <select
          id="category"
          name="category"
          value={newItem.category}
          onChange={handleChange}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        >
          <option value="other">Other</option>
          <option value="dairy">Dairy</option>
          <option value="meat">Meat</option>
          <option value="produce">Produce</option>
          <option value="bakery">Bakery</option>
          <option value="snacks">Snacks</option>
          <option value="drinks">Drinks</option>
          <option value="frozen">Frozen</option>
          <option value="pantry">Pantry</option>
          <option value="spices">Spices</option>
          <option value="household">Household</option>
        </select>
      </div>
      
      <div className="flex justify-end">
        <button
          type="submit"
          className="inline-flex justify-center rounded-md border border-transparent bg-indigo-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          Add {type === 'pantry' ? 'to Pantry' : 'to Shopping List'}
        </button>
      </div>
    </form>
  );
}