"use client";
import { useState } from 'react';
import { PantryItem, ShoppingItem } from '../types'

export default function ItemList({
  type,
  items,
  onRemove,
  onUpdateQuantity,
}: {
  type: 'pantry' | 'shopping';
  items: PantryItem[] | ShoppingItem[];
  onRemove: (id: string) => void;
  onUpdateQuantity: (id: string, field: 'quantity' | 'expiryDate', value: number | string) => void;
}) {
  const [editingItem, setEditingItem] = useState<PantryItem | ShoppingItem | null>(null);
  const [editField, setEditField] = useState<'quantity' | 'expiryDate'>('quantity');

  const handleEditClick = (item: PantryItem | ShoppingItem, field: 'quantity' | 'expiryDate') => {
    setEditingItem(item);
    setEditField(field);
  };

  const handleEditChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!editingItem) return;
    
    const value = e.target.value;
    
    if (editField === 'quantity') {
      const numValue = parseInt(value, 10);
      if (!isNaN(numValue)) {
        onUpdateQuantity(editingItem.id, editField, numValue);
      }
    } else if (editField === 'expiryDate') {
      onUpdateQuantity(editingItem.id, editField, value);
    }
  };

  const handleEditBlur = () => {
    setEditingItem(null);
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Unit</th>
            {type === 'pantry' && (
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Expiry</th>
            )}
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {items.map((item) => (
            <tr key={item.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                {item.name}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {editingItem?.id === item.id && editField === 'quantity' ? (
                  <input
                    type="number"
                    value={item.quantity}
                    onChange={handleEditChange}
                    onBlur={handleEditBlur}
                    className="w-full p-1 border rounded"
                    min="0"
                  />
                ) : (
                  item.quantity
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {item.unit}
              </td>
              {type === 'pantry' && (
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {item.expiryDate ? (
                    <span className="text-green-600">Expires: {new Date(item.expiryDate).toLocaleDateString()}</span>
                  ) : (
                    <span className="text-gray-400">No expiry</span>
                  )}
                </td>
              )}
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {item.category}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <button
                  onClick={() => handleEditClick(item, 'quantity')}
                  className="text-indigo-600 hover:text-indigo-900 mr-2"
                >
                  Edit
                </button>
                {type === 'pantry' && item.expiryDate && (
                  <button
                    onClick={() => handleEditClick(item, 'expiryDate')}
                    className="text-indigo-600 hover:text-indigo-900 mr-2"
                  >
                    Edit Expiry
                  </button>
                )}
                <button
                  onClick={() => onRemove(item.id)}
                  className="text-red-600 hover:text-red-900"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}