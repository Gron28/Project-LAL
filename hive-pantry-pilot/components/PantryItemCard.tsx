import { PantryItem } from '../types';

export default function PantryItemCard({ item, onUpdate, onRemove }: { item: PantryItem; onUpdate: (id: string, updates: Partial<PantryItem>) => void; onRemove: (id: string) => void }) {
  return (
    <div className="border p-3 rounded mb-2 bg-white shadow-sm">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-bold">{item.name}</h3>
          <p className="text-sm text-gray-500">{item.quantity} {item.unit}</p>
          {item.expiryDate && (
            <p className={`text-xs ${new Date(item.expiryDate).getTime() < Date.now() ? 'text-red-600' : 'text-green-600'}`}>
              Expires: {new Date(item.expiryDate).toLocaleDateString()}
            </p>
          )}
        </div>
        <button onClick={() => onRemove(item.id)} className="text-red-500 text-sm">Delete</button>
      </div>
    </div>
  );
}
