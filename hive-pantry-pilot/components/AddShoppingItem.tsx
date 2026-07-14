import { useState } from 'react';
import { ShoppingListItem } from '../types';

export default function AddShoppingItem() {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 bg-gray-50 rounded-lg">
      <div>
        <label className="block text-sm font-medium">Item Name</label>
        <input 
          type="text" 
          value={name} 
          onChange={(e) => setName(e.target.value)}
          className="w-full p-2 border rounded"
          placeholder="e.g. Bread"
        />
      </div>
      <div>
        <label className="block text-sm font-medium">Quantity</label>
        <input 
          type="number" 
          value={quantity} 
          onChange={(e) => setQuantity(parseInt(e.target.value))}
          className="w-full p-2 border rounded"
        />
      </div>
      <button type="submit" className="bg-green-500 text-white px-4 py-2 rounded">Add to List</button>
    </form>
  );
}
