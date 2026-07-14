import { useState } from 'react';
import { PantryItem } from '../types';

export default function AddPantryItem() {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unit, setUnit] = useState('pcs');
  const [category, setCategory] = useState('General');
  const [expiryDate, setExpiryDate] = useState<string>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    // This will be handled by the hook in the page component or a parent
    // For now, we'll just pass it up via a callback if needed, 
    // but since this is a standalone component for UI, let's think about how to handle state.
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
          placeholder="e.g. Milk"
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
      <div>
        <label className="block text-sm font-medium">Unit</label>
        <input 
          type="text" 
          value={unit} 
          onChange={(e) => setUnit(e.target.value)}
          className="w-full p-2 border rounded"
        />
      </div>
      <div>
        <label className="block text-sm font-medium">Category</label>
        <select 
          value={category} 
          onChange={(e) => setCategory(e.target.value)}
          className="w-full p-2 border rounded"
        >
          <option value="General">General</option>
          <option value="Dairy">Dairy</option>
          <option value="Meat">Meat</option>
          <option value="Produce">Produce</option>
          <option value="Pantry">Pantry</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium">Expiry Date</label>
        <input 
          type="date" 
          value={expiryDate} 
          onChange={(e) => setExpiryDate(e.target.value)}
          className="w-full p-2 border rounded"
        />
      </div>
      <button type="submit" className="bg-blue-500 text-white px-4 py-2 rounded">Add Item</button>
    </form>
  );
}
