import React from 'react';

export default function ShoppingListItem({ item, onToggle }: { item: ShoppingListItem; onToggle: (id: string) => void }) {
  return (
    <div className="flex items-center justify-between p-2 border-b last:border-0">
      <span className={item.purchased ? 'line-through text-gray-400' : ''}>{item.name}</span>
      <button onClick={() => onToggle(item.id)} className="px-3 py-1 bg-blue-500 text-white rounded">
        {item.purchased ? 'Done' : 'Add'}
      </button>
    </div>
  );
}
